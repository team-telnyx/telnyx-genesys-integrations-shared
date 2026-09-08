import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { verifyGenesysAudioHookRequest } from "./audiohook-auth.js";
import {
  AudioHookPcmPacketizer,
  AudioHookProtocolError,
  AudioHookServerSequence,
  StreamingPcm16Resampler,
  audioHookFrameBytes,
  decodeAudioHookAudio,
  encodeAudioHookAudio,
  parseAudioHookMessage,
  parseAudioHookOpenMessage,
  preferredAudioHookMediaFormat,
  requireAudioHookAssistantId,
  selectAudioHookMedia,
  unauthorizedAudioHookDisconnect,
} from "./audiohook-protocol.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import { Pcm16SpeechGate } from "./pcm-speech-gate.js";
import {
  GENESYS_HANDOFF_CHANNELS,
  formatGenesysVoiceTranscript,
  genesysVoiceHandoffOutputVariables,
  normalizeGenesysHandoffChannel,
  normalizeGenesysHandoffRequest,
} from "./handoff-request.js";
import { isGenesysHandoffToolFunctionName } from "./handoff-tool-name.js";
import { findGenesysQueueByName } from "./queue-routing.js";
import {
  createGenesysAudioConnectorLogger,
  isAudioConnectorMediaEvent,
  summarizeAudioConnectorJson,
} from "./audio-connector-logger.js";
import { buildTelnyxSessionUpdate } from "./telnyx-session-update.js";
import { getAdminAudioQueuePolicy } from "./admin-console-store.mjs";

const TELNYX_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TELNYX_INPUT_BUFFER_MS = 30_000;
const AUDIO_FRAME_DURATION_MS = 20;
const DEFAULT_INPUT_CATCH_UP_RATE = 1;
const DEFAULT_INPUT_CATCH_UP_TARGET_MS = 100;
// Genesys accepts media as binary WebSocket messages rather than requiring one
// message per 20 ms codec frame. Batching 200 ms keeps interactive latency low
// while avoiding the AudioHook message-rate limit triggered by 50 sends/second.
const GENESYS_OUTPUT_CHUNK_DURATION_MS = 200;
const PCM16_8KHZ_FRAME_BYTES = 320;
const AUDIO_SOCKET_HIGH_WATER_BYTES = 64 * 1024;
const MAX_GENESYS_OUTPUT_QUEUE_MS = 60_000;

export function boundedNumber(value, fallback, minimum, maximum) {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

export function normalizeAudioConnectorHandoffRequest(argumentsValue, queuePolicy = null) {
  return normalizeGenesysHandoffRequest(
    {
      ...(argumentsValue && typeof argumentsValue === "object"
        ? argumentsValue
        : {}),
      // The transport is authoritative here: this handler can only be reached
      // from a Genesys Audio Connector voice session. Telnyx identifies this
      // WebSocket transport as telnyx_conversation_channel=websocket_call,
      // which is still a voice interaction for Genesys handoff purposes.
      telnyx_conversation_channel: "websocket_call",
      channel: GENESYS_HANDOFF_CHANNELS.VOICE,
    },
    {
      defaultChannel: GENESYS_HANDOFF_CHANNELS.VOICE,
      defaultQueueName: queuePolicy?.defaultQueue?.name,
      allowedQueueNames: queuePolicy?.queues?.map(({ name }) => name),
    }
  );
}

export function telnyxRealtimeUrl(assistantId) {
  const configured = (
    process.env.TELNYX_AI_REALTIME_BASE_URL || "wss://api.telnyx.com"
  ).replace(/\/$/, "");
  const url = new URL(
    `${configured}/v2/ai/assistants/${encodeURIComponent(assistantId)}/conversation`
  );
  url.searchParams.set("input_sample_rate", "8000");
  url.searchParams.set("input_format", "pcm16");
  url.searchParams.set("output_format", "pcm16");
  url.searchParams.set("output_sample_rate", "8000");
  return url.toString();
}

function telnyxInputBufferLimitBytes() {
  const configured = Number(
    process.env.GC_AUDIO_CONNECTOR_INPUT_BUFFER_MS ||
      DEFAULT_TELNYX_INPUT_BUFFER_MS
  );
  const durationMs = Number.isFinite(configured)
    ? Math.max(1_000, Math.min(60_000, configured))
    : DEFAULT_TELNYX_INPUT_BUFFER_MS;
  return Math.floor((8_000 * 2 * durationMs) / 1_000);
}

function telnyxInputCatchUpConfiguration() {
  const rate = Math.round(
    boundedNumber(
      process.env.GC_AUDIO_CONNECTOR_INPUT_CATCHUP_RATE,
      DEFAULT_INPUT_CATCH_UP_RATE,
      1,
      1
    )
  );
  const targetMs = Math.round(
    boundedNumber(
      process.env.GC_AUDIO_CONNECTOR_INPUT_CATCHUP_TARGET_MS,
      DEFAULT_INPUT_CATCH_UP_TARGET_MS,
      AUDIO_FRAME_DURATION_MS,
      1_000
    )
  );
  return {
    frameDurationMs: Math.max(1, Math.round(AUDIO_FRAME_DURATION_MS / rate)),
    thresholdFrames: Math.max(1, Math.ceil(targetMs / AUDIO_FRAME_DURATION_MS)),
    rate,
    targetMs,
  };
}

function audioHookDurationMilliseconds(value) {
  const match = String(value || "").match(
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i
  );
  if (!match) return 0;
  return Math.round(
    (Number(match[1] || 0) * 3_600 +
      Number(match[2] || 0) * 60 +
      Number(match[3] || 0)) *
      1_000
  );
}

function setupWhenOpen(client, callback) {
  if (client.readyState === WebSocket.OPEN) {
    callback();
  } else if (client.readyState === WebSocket.CONNECTING) {
    client.once("open", callback);
  }
}

function safeJsonArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isHangupToolCall(tool = {}) {
  return [tool.name, tool.display_name, tool.type, tool.tool_type]
    .map((value) => String(value || "").trim().toLowerCase())
    .some((value) => value === "hangup" || value.includes("genesys hangup"));
}

function transcriptEntry(role, text) {
  return {
    role,
    text: String(text || "").trim().slice(0, 12_000),
    occurred_at: new Date().toISOString(),
  };
}

function audioHookOpenContext(message) {
  const params = message.parameters;
  return {
    sessionId: message.id,
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    participantId: params.participant.id,
    ani: params.participant.ani || null,
    aniName: params.participant.aniName || null,
    dnis: params.participant.dnis || null,
    direction: params.participant.direction || params.direction || params.inputVariables?.telnyxCallDirection || null,
    language: params.language || null,
    inputVariables: params.inputVariables || {},
  };
}

export async function handleGenesysAudioConnectorUpgrade(client, request) {
  const auth = verifyGenesysAudioHookRequest(request);
  const debugLog = createGenesysAudioConnectorLogger();

  setupWhenOpen(client, () => {
    if (!auth.ok) {
      const sessionId = request?.headers?.get?.("audiohook-session-id") || randomUUID();
      const message = unauthorizedAudioHookDisconnect(sessionId);
      debugLog.wire(
        "Telnyx -> Genesys",
        () => `Genesys WS send control ${summarizeAudioConnectorJson(message)}`
      );
      client.send(JSON.stringify(message));
      setTimeout(() => client.close(4001, "Unauthorized"), 100);
      return;
    }

    handleAudioConnectorSession(client).catch((error) => {
      debugLog.error("Session setup failed:", error);
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, "Audio Connector setup failed");
      }
    });
  });
}

export async function handleAudioConnectorSession(
  genesysWs,
  {
    createTelnyxWebSocket = (url, options) => new WebSocket(url, options),
    audioPacerTiming = {},
    genesysOutputMaxQueueMs = MAX_GENESYS_OUTPUT_QUEUE_MS,
    localBargeIn = {},
  } = {}
) {
  const debugLog = createGenesysAudioConnectorLogger();
  const telnyxApiKey = String(process.env.TELNYX_API_KEY || "").trim();
  if (!telnyxApiKey) throw new Error("TELNYX_API_KEY must be configured");

  let state = "opening";
  let sequence = null;
  let openContext = null;
  let selectedMedia = null;
  let assistantId = null;
  let telnyxWs = null;
  let telnyxConversationId = null;
  let telnyxOutputRate = 8000;
  let resampler = null;
  let packetizer = null;
  let telnyxInputPacketizer = null;
  let telnyxInputPacer = null;
  let genesysOutputPacer = null;
  let activeTelnyxResponseId = null;
  let assistantAudioActive = false;
  const interruptedTelnyxResponseIds = new Set();
  const localSpeechGate = new Pcm16SpeechGate({
    rmsThreshold: boundedNumber(
      localBargeIn.rmsThreshold ??
        process.env.GC_AUDIO_CONNECTOR_BARGE_IN_RMS_THRESHOLD,
      700,
      100,
      10_000
    ),
    peakThreshold: boundedNumber(
      localBargeIn.peakThreshold ??
        process.env.GC_AUDIO_CONNECTOR_BARGE_IN_PEAK_THRESHOLD,
      1800,
      200,
      20_000
    ),
    minSpeechMs: boundedNumber(
      localBargeIn.minSpeechMs ??
        process.env.GC_AUDIO_CONNECTOR_BARGE_IN_MIN_SPEECH_MS,
      40,
      20,
      500
    ),
  });
  const transcript = [];
  const assistantTranscriptByResponse = new Map();
  let pendingTool = null;
  let handoffPreparation = null;
  let activeHandoff = null;
  let pendingHangupToolId = null;
  let hangupRequested = false;
  let disconnectScheduled = false;
  let telnyxConnectTimer = null;
  let pingTimer = null;
  let closeFallbackTimer = null;
  let openReceivedAt = null;
  let telnyxConnectStartedAt = null;
  let audioHookPaused = false;
  const telnyxInputBufferMaxBytes = telnyxInputBufferLimitBytes();
  const telnyxInputCatchUp = telnyxInputCatchUpConfiguration();
  const audioStats = {
    genesysInputBytes: 0,
    telnyxInputPcmBytes: 0,
    telnyxOutputPcmBytes: 0,
    genesysOutputBytes: 0,
    genesysOutputMessages: 0,
    genesysOutputDroppedBytes: 0,
    genesysOutputDroppedMessages: 0,
    genesysOutputQueuePeakFrames: 0,
    telnyxInputDroppedFrames: 0,
    telnyxInputQueuePeakFrames: 0,
    telnyxInputQueuePeakMs: 0,
    telnyxInputCatchUpFrames: 0,
    telnyxConnectMs: 0,
    audioHookStartupMs: 0,
    genesysDiscardedMessages: 0,
    genesysDiscardedMs: 0,
    genesysPauseCount: 0,
    telnyxResponsesSuperseded: 0,
    localBargeIns: 0,
  };

  function sendGenesysMessage(message) {
    if (genesysWs.readyState === WebSocket.OPEN) {
      debugLog.wire(
        "Telnyx -> Genesys",
        () => `Genesys WS send control ${summarizeAudioConnectorJson(message)}`
      );
      genesysWs.send(JSON.stringify(message));
    }
  }

  function sendGenesysAudio(buffer) {
    if (
      state !== "active" ||
      genesysWs.readyState !== WebSocket.OPEN ||
      !selectedMedia ||
      !packetizer ||
      !genesysOutputPacer
    ) return;
    const encoded = encodeAudioHookAudio(buffer, selectedMedia);
    try {
      genesysOutputPacer.enqueueMany(packetizer.push(encoded));
      audioStats.genesysOutputQueuePeakFrames = Math.max(
        audioStats.genesysOutputQueuePeakFrames,
        genesysOutputPacer.pendingFrames
      );
    } catch (error) {
      debugLog.error("Genesys output pacing failed:", error);
      disconnectForTelnyxError("Generated audio exceeded the Genesys output buffer");
    }
  }

  function flushGenesysAudio() {
    if (!packetizer || !genesysOutputPacer) return;
    genesysOutputPacer.enqueueMany(packetizer.flush());
  }

  function interruptAssistantAudio({ source, force = false } = {}) {
    const responseId = activeTelnyxResponseId;
    const alreadyInterrupted = responseId
      ? interruptedTelnyxResponseIds.has(responseId)
      : false;
    const hasOutput =
      assistantAudioActive ||
      Boolean(genesysOutputPacer?.pendingFrames) ||
      Boolean(packetizer?.pending?.length);

    if (!force && (!hasOutput || alreadyInterrupted)) return false;
    if (responseId) interruptedTelnyxResponseIds.add(responseId);
    packetizer?.clear();
    genesysOutputPacer?.clear();
    assistantAudioActive = false;
    localSpeechGate.reset();

    if (!alreadyInterrupted && state === "active" && sequence) {
      sendGenesysMessage(sequence.bargeIn());
      if (source === "local-audio") audioStats.localBargeIns += 1;
    }
    return true;
  }

  function sendTelnyxInput(buffer) {
    if (telnyxWs?.readyState !== WebSocket.OPEN) return false;
    const message = {
      type: "input_audio_buffer.append",
      audio: buffer.toString("base64"),
    };
    telnyxWs.send(JSON.stringify(message));
    audioStats.telnyxInputPcmBytes += buffer.length;
    return true;
  }

  function queueTelnyxInput(buffer) {
    if (!telnyxInputPacketizer || state !== "active") return;
    for (const frame of telnyxInputPacketizer.push(buffer)) {
      telnyxInputPacer?.enqueue(frame);
      const pendingFrames = telnyxInputPacer?.pendingFrames || 0;
      audioStats.telnyxInputQueuePeakFrames = Math.max(
        audioStats.telnyxInputQueuePeakFrames,
        pendingFrames
      );
      audioStats.telnyxInputQueuePeakMs =
        audioStats.telnyxInputQueuePeakFrames * AUDIO_FRAME_DURATION_MS;
    }
  }

  function stopAudioPacing() {
    telnyxInputPacer?.stop();
    genesysOutputPacer?.stop();
    telnyxInputPacketizer?.clear();
    packetizer?.clear();
  }

  function closeTelnyx() {
    if (telnyxConnectTimer) clearTimeout(telnyxConnectTimer);
    telnyxConnectTimer = null;
    if (telnyxWs && telnyxWs.readyState < WebSocket.CLOSING) {
      telnyxWs.close(1000, "Genesys AudioHook session ended");
    }
  }

  function disconnectForTelnyxError(info) {
    if (![
      "opening",
      "connecting",
      "active",
    ].includes(state)) return;
    state = "disconnecting";
    stopAudioPacing();
    if (telnyxConnectTimer) clearTimeout(telnyxConnectTimer);
    telnyxConnectTimer = null;
    if (sequence) {
      sendGenesysMessage(sequence.disconnect({ reason: "error", info }));
    }
  }

  async function prepareHandoff(toolCall) {
    const requestedChannel = normalizeGenesysHandoffChannel(
      toolCall.arguments?.telnyx_conversation_channel || toolCall.arguments?.channel
    );
    if (
      requestedChannel &&
      requestedChannel !== GENESYS_HANDOFF_CHANNELS.VOICE
    ) {
      debugLog.warn(
        "Overriding non-voice handoff channel for an Audio Connector session:",
        requestedChannel
      );
    }
    const queuePolicy = await getAdminAudioQueuePolicy();
    const request = normalizeAudioConnectorHandoffRequest(toolCall.arguments, queuePolicy);

    const queue = await findGenesysQueueByName(request.queueName);
    const handoffId = randomUUID();
    const outputVariables = genesysVoiceHandoffOutputVariables({
      handoffId,
      queueName: queue.name,
      queueId: queue.id,
      reason: request.reason,
      summary: request.summary,
      intent: request.intent,
      sentiment: request.sentiment,
      telnyxConversationId,
    });

    return {
      outputVariables,
    };
  }

  async function disconnectForHandoff() {
    if (disconnectScheduled || state !== "active" || !handoffPreparation) return;
    disconnectScheduled = true;

    try {
      activeHandoff = await handoffPreparation;
      activeHandoff.outputVariables.telnyxAiTranscript =
        formatGenesysVoiceTranscript(transcript);
      const drainMs = Math.max(
        0,
        Math.min(
          30_000,
          Number(process.env.GC_AUDIO_CONNECTOR_HANDOFF_DRAIN_MS || 10_000)
        )
      );

      genesysOutputPacer?.enqueueMany(packetizer?.flush() || []);
      const deadline = Date.now() + drainMs;
      const disconnectWhenDrained = () => {
        if (state !== "active" || !sequence) return;
        if (genesysOutputPacer?.pendingFrames && Date.now() < deadline) {
          setTimeout(disconnectWhenDrained, AUDIO_FRAME_DURATION_MS);
          return;
        }
        genesysOutputPacer?.stop();
        state = "disconnecting";
        sendGenesysMessage(
          sequence.disconnect({
            reason: "completed",
            info: "Telnyx AI requested Genesys human handoff",
            outputVariables: activeHandoff.outputVariables,
          })
        );
      };
      disconnectWhenDrained();
    } catch (error) {
      disconnectScheduled = false;
      handoffPreparation = null;
      pendingTool = null;
      debugLog.error("Voice handoff preparation failed:", error);
    }
  }

  function disconnectForHangup() {
    if (disconnectScheduled || state !== "active" || !hangupRequested) return;
    disconnectScheduled = true;
    genesysOutputPacer?.enqueueMany(packetizer?.flush() || []);
    const drainMs = Math.max(
      0,
      Math.min(10_000, Number(process.env.GC_AUDIO_CONNECTOR_HANGUP_DRAIN_MS || 3_000))
    );
    const deadline = Date.now() + drainMs;
    const disconnectWhenDrained = () => {
      if (state !== "active" || !sequence) return;
      if (genesysOutputPacer?.pendingFrames && Date.now() < deadline) {
        setTimeout(disconnectWhenDrained, AUDIO_FRAME_DURATION_MS);
        return;
      }
      genesysOutputPacer?.stop();
      state = "disconnecting";
      sendGenesysMessage(sequence.disconnect({
        reason: "completed",
        info: "Telnyx AI completed the conversation",
      }));
    };
    disconnectWhenDrained();
  }

  function connectTelnyx() {
    let handshakeRejected = false;
    telnyxWs = createTelnyxWebSocket(telnyxRealtimeUrl(assistantId), {
      headers: { Authorization: `Bearer ${telnyxApiKey}` },
    });

    telnyxConnectTimer = setTimeout(() => {
      if (state === "connecting") {
        disconnectForTelnyxError("Telnyx connection timed out");
        closeTelnyx();
      }
    }, TELNYX_CONNECT_TIMEOUT_MS);

    setupWhenOpen(telnyxWs, () => {
      try {
        const { frame, variableNames } = buildTelnyxSessionUpdate({
          context: openContext,
          inputVariables: openContext?.inputVariables,
        });
        telnyxWs.send(JSON.stringify(frame));
        debugLog.info(
          "Telnyx realtime session update sent:",
          variableNames.length
            ? `dynamicVariables=${variableNames.join(",")}`
            : "dynamicVariables=none"
        );
      } catch (error) {
        debugLog.error("Could not build Telnyx session update:", error);
        disconnectForTelnyxError("Invalid Audio Connector dynamic variables");
        closeTelnyx();
      }
    });

    telnyxWs.once("unexpected-response", (_request, response) => {
      handshakeRejected = true;
      const statusCode = Number(response?.statusCode || 0);
      response?.resume?.();
      const info = {
        401: "Telnyx authentication failed (HTTP 401); check the configured API key",
        403: `Telnyx refused access to assistant ${assistantId} (HTTP 403)`,
        404: `Telnyx assistant ${assistantId} was not found or is not available to this account (HTTP 404)`,
      }[statusCode] || `Telnyx rejected assistant ${assistantId} (HTTP ${statusCode || "error"})`;
      debugLog.error(
        "Telnyx WebSocket handshake failed:",
        statusCode,
        assistantId
      );
      disconnectForTelnyxError(info);
      // An unexpected-response listener takes ownership of a failed upgrade:
      // ws otherwise remains CONNECTING until the Genesys side closes.
      closeTelnyx();
    });

    telnyxWs.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        debugLog.wire(
          "Telnyx -> Genesys",
          () => `Telnyx WS received invalid JSON bytes=${Buffer.byteLength(raw)}`
        );
        return;
      }
      if (!isAudioConnectorMediaEvent(event)) {
        debugLog.wire(
          "Telnyx -> Genesys",
          () => `Telnyx WS received ${summarizeAudioConnectorJson(event)}`
        );
      }

      switch (event.type) {
        case "session.created": {
          if (state !== "connecting") break;
          clearTimeout(telnyxConnectTimer);
          telnyxConnectTimer = null;
          telnyxConversationId = event.session?.conversation_id || null;
          const inputFormat = event.session?.audio?.input?.format || {};
          const outputFormat = event.session?.audio?.output?.format || {};
          if (
            inputFormat.type !== "audio/pcm" ||
            Number(inputFormat.rate || 0) !== 8000
          ) {
            disconnectForTelnyxError(
              `Telnyx returned unsupported input format ${
                inputFormat.type || "unknown"
              }/${inputFormat.rate || "unknown"}`
            );
            closeTelnyx();
            break;
          }
          if (outputFormat.type !== "audio/pcm") {
            disconnectForTelnyxError(
              `Telnyx returned unsupported output format ${
                outputFormat.type || "unknown"
              }`
            );
            closeTelnyx();
            break;
          }
          telnyxOutputRate = Number(outputFormat.rate || 8000);
          resampler = new StreamingPcm16Resampler(telnyxOutputRate, 8000);
          state = "active";
          telnyxInputPacer?.start();
          genesysOutputPacer?.start();
          const readyAt = Date.now();
          audioStats.telnyxConnectMs = telnyxConnectStartedAt
            ? readyAt - telnyxConnectStartedAt
            : 0;
          audioStats.audioHookStartupMs = openReceivedAt
            ? readyAt - openReceivedAt
            : 0;
          sendGenesysMessage(sequence.opened(selectedMedia));
          debugLog.info(
            "AudioHook opened after Telnyx became ready:",
            openContext.sessionId,
            `genesysConversationId=${openContext.conversationId}`,
            `assistantId=${assistantId}`,
            `startupMs=${audioStats.audioHookStartupMs}`
          );
          debugLog.info(
            "Telnyx realtime session ready:",
            telnyxConversationId,
            `input=${inputFormat.type || "unknown"}/${inputFormat.rate || "unknown"}`,
            `output=${outputFormat.type}/${telnyxOutputRate}`,
            `inputCatchUpRate=${telnyxInputCatchUp.rate}x`,
            `inputCatchUpTargetMs=${telnyxInputCatchUp.targetMs}`
          );
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const entry = transcriptEntry("customer", event.transcript);
          if (entry.text) transcript.push(entry);
          break;
        }

        case "response.created": {
          const responseId = event.response?.id || null;
          if (
            responseId &&
            activeTelnyxResponseId &&
            activeTelnyxResponseId !== responseId
          ) {
            // Only one assistant response can be played at a time. If Telnyx
            // starts a replacement before the previous response is done,
            // discard late audio from the superseded response instead of
            // interleaving both streams and growing the output backlog.
            interruptedTelnyxResponseIds.add(activeTelnyxResponseId);
            packetizer?.clear();
            genesysOutputPacer?.clear();
            audioStats.telnyxResponsesSuperseded += 1;
            assistantAudioActive = false;
          }
          if (activeTelnyxResponseId !== responseId) localSpeechGate.reset();
          activeTelnyxResponseId = responseId;
          break;
        }

        case "response.output_audio.delta": {
          if (!event.delta || !resampler) break;
          const responseId = event.response_id || activeTelnyxResponseId;
          if (responseId && interruptedTelnyxResponseIds.has(responseId)) break;
          if (responseId && !activeTelnyxResponseId) {
            activeTelnyxResponseId = responseId;
            localSpeechGate.reset();
          }
          const pcm = Buffer.from(event.delta, "base64");
          audioStats.telnyxOutputPcmBytes += pcm.length;
          sendGenesysAudio(resampler.push(pcm));
          assistantAudioActive = true;
          break;
        }

        case "response.output_audio.done": {
          const responseId = event.response_id || activeTelnyxResponseId;
          if (responseId && interruptedTelnyxResponseIds.has(responseId)) {
            packetizer?.clear();
          } else {
            flushGenesysAudio();
          }
          break;
        }

        case "response.output_audio_transcript.delta": {
          const responseId = event.response_id || "current";
          assistantTranscriptByResponse.set(
            responseId,
            `${assistantTranscriptByResponse.get(responseId) || ""}${event.delta || ""}`
          );
          break;
        }

        case "input_audio_buffer.speech_started": {
          interruptAssistantAudio({ source: "telnyx-vad", force: true });
          break;
        }

        case "response.tool_call.started": {
          const tool = event.tool_call || {};
          if (isGenesysHandoffToolFunctionName(tool.name)) {
            pendingTool = {
              id: tool.id,
              arguments: safeJsonArguments(tool.arguments),
            };
          } else if (isHangupToolCall(tool)) {
            pendingHangupToolId = tool.id || "hangup";
          }
          break;
        }

        case "response.tool_call.completed": {
          const tool = event.tool_call || {};
          if (
            isHangupToolCall(tool) ||
            (pendingHangupToolId && tool.id === pendingHangupToolId)
          ) {
            if (event.status === "success") {
              hangupRequested = true;
              disconnectForHangup();
            } else {
              pendingHangupToolId = null;
            }
            break;
          }
          if (!pendingTool || tool.id !== pendingTool.id) break;
          if (event.status === "success") {
            handoffPreparation = prepareHandoff(pendingTool);
            // Attach a rejection handler immediately. response.done awaits the
            // original promise and reports the error, but it may arrive on a
            // later event-loop turn; without this observer Node treats an early
            // queue/API failure as unhandled and terminates the server process.
            void handoffPreparation.catch(() => {});
          } else {
            pendingTool = null;
            handoffPreparation = null;
          }
          break;
        }

        case "response.done": {
          const responseId = event.response?.id || event.response_id || "current";
          const responseStatus = event.response?.status;
          if (
            responseStatus === "completed" &&
            !interruptedTelnyxResponseIds.has(responseId)
          ) {
            // Compatibility fallback for streams that omit output_audio.done.
            flushGenesysAudio();
          } else if (responseStatus === "cancelled") {
            packetizer?.clear();
            genesysOutputPacer?.clear();
          }
          const assistantText = assistantTranscriptByResponse.get(responseId);
          if (assistantText?.trim()) {
            transcript.push(transcriptEntry("assistant", assistantText));
            assistantTranscriptByResponse.delete(responseId);
          }
          if (responseStatus === "completed" && handoffPreparation) {
            disconnectForHandoff();
          } else if (responseStatus === "completed" && hangupRequested) {
            disconnectForHangup();
          }
          if (activeTelnyxResponseId === responseId) {
            activeTelnyxResponseId = null;
            assistantAudioActive = false;
            localSpeechGate.reset();
          }
          interruptedTelnyxResponseIds.delete(responseId);
          break;
        }

        case "error":
          debugLog.error(
            "Telnyx realtime error:",
            event.error?.code,
            event.error?.message
          );
          disconnectForTelnyxError(
            event.error?.message || `Telnyx assistant ${assistantId} returned an error`
          );
          break;
      }
    });

    telnyxWs.once("error", (error) => {
      // Aborting a rejected upgrade emits a local error; the HTTP failure above
      // is the useful diagnostic and has already disconnected Genesys.
      if (handshakeRejected) return;
      debugLog.error("Telnyx WebSocket error:", error.message);
      disconnectForTelnyxError(`Telnyx connection failed for assistant ${assistantId}`);
    });

    telnyxWs.once("close", (code, reason) => {
      debugLog.wire(
        "Telnyx -> Genesys",
        () => `Telnyx WS closed code=${code} reason=${reason?.toString?.() || ""}`
      );
      if (["closing", "closed", "disconnecting"].includes(state)) return;
      if (hangupRequested) {
        disconnectForHangup();
        return;
      }
      debugLog.warn(
        "Telnyx WebSocket closed:",
        code,
        reason?.toString?.() || ""
      );
      state = "disconnecting";
      stopAudioPacing();
      if (sequence) {
        sendGenesysMessage(
          sequence.disconnect({ reason: "error", info: "Telnyx session ended" })
        );
      }
    });
  }

  genesysWs.on("message", async (raw, isBinary) => {
    try {
      if (isBinary) {
        if (state === "active" && selectedMedia) {
          const input = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          audioStats.genesysInputBytes += input.length;
          const pcm = decodeAudioHookAudio(input, selectedMedia);
          const assistantPlaybackPending =
            assistantAudioActive ||
            Boolean(genesysOutputPacer?.pendingFrames) ||
            Boolean(packetizer?.pending?.length);
          if (assistantPlaybackPending && localSpeechGate.observe(pcm)) {
            interruptAssistantAudio({ source: "local-audio" });
          } else if (!assistantPlaybackPending) {
            localSpeechGate.reset();
          }
          queueTelnyxInput(pcm);
        }
        return;
      }

      debugLog.wire(
        "Genesys -> Telnyx",
        () => `Genesys WS received control ${summarizeAudioConnectorJson(
          (() => {
            try {
              return JSON.parse(raw.toString());
            } catch {
              return raw.toString();
            }
          })()
        )}`
      );

      const message = state === "opening" && !sequence
        ? parseAudioHookOpenMessage(raw.toString())
        : parseAudioHookMessage(raw.toString());

      if (!sequence) {
        sequence = new AudioHookServerSequence(message.id);
        sequence.observe(message);
        openReceivedAt = Date.now();
        openContext = audioHookOpenContext(message);
        const preferredMediaFormat = preferredAudioHookMediaFormat(
          process.env.GC_AUDIO_CONNECTOR_MEDIA_FORMAT
        );
        selectedMedia = selectAudioHookMedia(message, preferredMediaFormat);
        assistantId = requireAudioHookAssistantId(message);
        debugLog.info(
          "Negotiated AudioHook media:",
          selectedMedia.format,
          selectedMedia.rate,
          selectedMedia.channels.join(","),
          selectedMedia.format === "L16"
            ? "codecPath=L16/PCM16-pass-through"
            : "codecPath=PCMU/PCM16-transcode",
          `outputChunkMs=${GENESYS_OUTPUT_CHUNK_DURATION_MS}`,
          `outputChunkBytes=${audioHookFrameBytes(
            selectedMedia,
            GENESYS_OUTPUT_CHUNK_DURATION_MS
          )}`
        );
        packetizer = new AudioHookPcmPacketizer(
          audioHookFrameBytes(selectedMedia, GENESYS_OUTPUT_CHUNK_DURATION_MS)
        );
        telnyxInputPacketizer = new AudioHookPcmPacketizer(PCM16_8KHZ_FRAME_BYTES);
        telnyxInputPacer = new RealtimeAudioPacer({
          ...audioPacerTiming,
          frameDurationMs: AUDIO_FRAME_DURATION_MS,
          initialDelayMs: 0,
          catchUpFrameDurationMs: telnyxInputCatchUp.frameDurationMs,
          catchUpThresholdFrames: telnyxInputCatchUp.thresholdFrames,
          maxQueueFrames: Math.max(
            1,
            Math.ceil(telnyxInputBufferMaxBytes / PCM16_8KHZ_FRAME_BYTES)
          ),
          overflow: "drop-oldest",
          canSend: () =>
            state === "active" &&
            telnyxWs?.readyState === WebSocket.OPEN &&
            Number(telnyxWs.bufferedAmount || 0) <= AUDIO_SOCKET_HIGH_WATER_BYTES,
          sendFrame: sendTelnyxInput,
          onDrop: () => {
            audioStats.telnyxInputDroppedFrames += 1;
          },
          onCatchUp: () => {
            audioStats.telnyxInputCatchUpFrames += 1;
          },
          onError: (error) => {
            debugLog.error("Telnyx input pacing failed:", error);
            disconnectForTelnyxError("Could not stream caller audio to Telnyx");
          },
        });
        genesysOutputPacer = new RealtimeAudioPacer({
          ...audioPacerTiming,
          frameDurationMs: GENESYS_OUTPUT_CHUNK_DURATION_MS,
          initialDelayMs: 0,
          maxQueueFrames: Math.ceil(
            Math.max(GENESYS_OUTPUT_CHUNK_DURATION_MS, genesysOutputMaxQueueMs) /
              GENESYS_OUTPUT_CHUNK_DURATION_MS
          ),
          // Telnyx can synthesize a complete response much faster than it can
          // be played to the caller. Queue exhaustion must therefore degrade
          // by discarding stale audio, never by disconnecting the call.
          overflow: "drop-oldest",
          canSend: () =>
            state === "active" &&
            genesysWs.readyState === WebSocket.OPEN &&
            Number(genesysWs.bufferedAmount || 0) <= AUDIO_SOCKET_HIGH_WATER_BYTES,
          sendFrame: (frame) => {
            genesysWs.send(frame, { binary: true });
            audioStats.genesysOutputBytes += frame.length;
            audioStats.genesysOutputMessages += 1;
          },
          onDrop: (frame) => {
            audioStats.genesysOutputDroppedBytes += frame.length;
            audioStats.genesysOutputDroppedMessages += 1;
            const dropped = audioStats.genesysOutputDroppedMessages;
            if (dropped === 1 || dropped % 50 === 0) {
              debugLog.warn(
                "Dropped stale assistant audio to preserve the live session:",
                `droppedMessages=${dropped}`,
                `pendingFrames=${genesysOutputPacer.pendingFrames}`
              );
            }
          },
          onError: (error) => {
            debugLog.error("Genesys output pacing failed:", error);
            disconnectForTelnyxError("Could not stream assistant audio to Genesys");
          },
        });
        state = "connecting";
        telnyxConnectStartedAt = Date.now();
        debugLog.info(
          "Preparing AudioHook backend before accepting media:",
          openContext.sessionId,
          `genesysConversationId=${openContext.conversationId}`,
          `assistantId=${assistantId}`
        );
        connectTelnyx();
        return;
      }

      sequence.observe(message);
      switch (message.type) {
        case "ping":
          sendGenesysMessage(sequence.pong());
          break;
        case "update":
          sendGenesysMessage(sequence.updated());
          break;
        case "paused":
          if (!audioHookPaused) {
            audioHookPaused = true;
            audioStats.genesysPauseCount += 1;
            debugLog.info(
              "Genesys AudioHook media paused:",
              `position=${message.position || "unknown"}`,
              `inputQueueMs=${(telnyxInputPacer?.pendingFrames || 0) * AUDIO_FRAME_DURATION_MS}`
            );
          }
          break;
        case "resumed":
          if (audioHookPaused) {
            audioHookPaused = false;
            debugLog.info(
              "Genesys AudioHook media resumed:",
              `position=${message.position || "unknown"}`,
              `inputQueueMs=${(telnyxInputPacer?.pendingFrames || 0) * AUDIO_FRAME_DURATION_MS}`
            );
          }
          break;
        case "discarded":
          audioStats.genesysDiscardedMessages += 1;
          audioStats.genesysDiscardedMs += audioHookDurationMilliseconds(
            message.parameters?.discarded
          );
          debugLog.warn(
            "Genesys reported discarded AudioHook media:",
            `position=${message.position || "unknown"}`,
            `details=${JSON.stringify(message.parameters || {})}`
          );
          break;
        case "error":
          debugLog.error(
            "Genesys AudioHook protocol error:",
            message.parameters?.code || "unknown",
            message.parameters?.message || message.parameters?.info || ""
          );
          state = "disconnecting";
          stopAudioPacing();
          closeTelnyx();
          break;
        case "close":
          state = "closing";
          stopAudioPacing();
          closeTelnyx();
          sendGenesysMessage(sequence.closed());
          state = "closed";
          // Genesys closes the WebSocket after receiving `closed`. Keep a
          // conservative fallback only so a broken peer cannot leak a socket.
          closeFallbackTimer = setTimeout(() => {
            if (genesysWs.readyState === WebSocket.OPEN) {
              genesysWs.close(1000, "AudioHook close timeout");
            }
          }, 5_000);
          break;
      }
    } catch (error) {
      debugLog.error("Invalid AudioHook message:", error);
      if (sequence && genesysWs.readyState === WebSocket.OPEN) {
        state = "disconnecting";
        stopAudioPacing();
        sendGenesysMessage(
          sequence.disconnect({
            reason: "error",
            info: error instanceof AudioHookProtocolError
              ? error.message
              : "AudioHook message processing failed",
          })
        );
      } else {
        genesysWs.close(1002, "Invalid AudioHook message");
      }
    }
  });

  genesysWs.on("ping", (data) => {
    debugLog.wire(
      "Genesys -> Telnyx",
      () => `Genesys WS received ping bytes=${Buffer.byteLength(data)}`
    );
    debugLog.wire(
      "Telnyx -> Genesys",
      () => `Genesys WS send pong bytes=${Buffer.byteLength(data)}`
    );
    genesysWs.pong(data);
  });

  pingTimer = setInterval(() => {
    if (genesysWs.readyState === WebSocket.OPEN) {
      debugLog.wire("Telnyx -> Genesys", "Genesys WS send ping bytes=0");
      genesysWs.ping();
    }
  }, 30_000);

  genesysWs.once("close", (code, reason) => {
    debugLog.wire(
      "Genesys -> Telnyx",
      () => `Genesys WS closed code=${code} reason=${reason?.toString?.() || ""}`
    );
    debugLog.info(
      "Genesys WebSocket closed:",
      code,
      reason?.toString?.() || "",
      `sessionId=${openContext?.sessionId || "unknown"}`,
      `state=${state}`,
      `audio=${JSON.stringify(audioStats)}`
    );
    state = "closed";
    stopAudioPacing();
    clearInterval(pingTimer);
    if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
    if (telnyxConnectTimer) clearTimeout(telnyxConnectTimer);
    closeTelnyx();
  });

  genesysWs.once("error", (error) => {
    debugLog.error("Genesys WebSocket error:", error.message);
  });
}
