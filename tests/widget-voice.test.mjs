import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimePath = new URL("../components/widget/VoiceWidgetRuntime.jsx", import.meta.url);
const waveformPath = new URL("../components/widget/AudioWaveform.jsx", import.meta.url);
const framePath = new URL("../components/widget/WidgetFrame.jsx", import.meta.url);
const studioPreviewPath = new URL("../components/widget-admin/WidgetStudioPreview.jsx", import.meta.url);
const sessionRoutePath = new URL("../app/api/widgets/[publicId]/sessions/route.js", import.meta.url);
const bootstrapRoutePath = new URL("../app/api/widgets/[publicId]/bootstrap/route.js", import.meta.url);
const voiceStatePath = new URL("../app/api/widget-sessions/voice-state/route.js", import.meta.url);
const sessionsPath = new URL("../lib/widgets/sessions.js", import.meta.url);
const schemaPath = new URL("../lib/postgres-schema.mjs", import.meta.url);
const loaderPath = new URL("../public/widget/v1/loader.js", import.meta.url);
const bootstrapClientPath = new URL("../lib/widgets/bootstrap-client.js", import.meta.url);

test("voice runtime uses the official Telnyx library without browser API credentials", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.match(source, /new TelnyxAIAgent\(agentOptions\)/);
  assert.match(source, /config\.channels\.voice\.region !== "auto"/);
  assert.match(source, /client\.startConversation\(\{/);
  assert.match(source, /callerNumber: config\.channels\.voice\.callerNumber/);
  assert.match(source, /callerName: "Web Call"/);
  assert.match(source, /clientRef\.current\.sendConversationMessage/);
  assert.match(source, /client\.endConversation/);
  assert.match(source, /setClientEpoch\(\(current\) => current \+ 1\)/);
  assert.match(source, /clientConnectPromiseRef\.current/);
  assert.match(source, /widgetDynamicVariableHeaders\(freshWidget\.decisionContext/);
  assert.doesNotMatch(source, /TELNYX_API_KEY|Authorization:\s*[`'"]Bearer KEY/);
});

test("voice call carries only non-secret widget correlation headers", async () => {
  const source = await readFile(runtimePath, "utf8");
  assert.match(source, /X-Widget-Session-Id/);
  assert.match(source, /X-Widget-Id/);
  assert.doesNotMatch(source, /genesysSipUri|GC_/);
});

test("widget bootstrap sources the WebRTC caller identity from the server environment", async () => {
  const source = await readFile(bootstrapRoutePath, "utf8");
  assert.match(source, /process\.env\.TELNYX_WIDGET_CALLER_NUMBER/);
  assert.match(source, /normalizeTelnyxWebCallerNumber/);
  assert.match(source, /publicWidgetConfig\(runtimeConfig, \{ voiceCallerNumber \}\)/);
  assert.match(source, /runtimeConfig\.channels\.voice\.enabled = false/);
  assert.match(source, /launcherIconSvg: widgetIconSvgMarkup/);
  assert.match(source, /components\.launcher\.icon/);
});

test("voice UI derives waveform from a live media stream and exposes mute and hangup", async () => {
  const [runtime, waveform] = await Promise.all([
    readFile(runtimePath, "utf8"),
    readFile(waveformPath, "utf8"),
  ]);
  assert.match(waveform, /createMediaStreamSource\(stream\)/);
  assert.match(waveform, /getByteFrequencyData/);
  assert.match(runtime, /muteAudio/);
  assert.match(runtime, /unmuteAudio/);
  assert.match(runtime, /voiceTextInput/);
  assert.match(runtime, /voiceTranscript/);
  assert.match(waveform, /\(active \|\| preview\)[\s\S]*requestAnimationFrame/);
  assert.match(waveform, /style === "radial"/);
  assert.match(waveform, /options\.style === "mirrored"/);
  assert.match(waveform, /options\.style === "line"/);
  assert.match(waveform, /options\.style === "ribbon"/);
  assert.match(waveform, /options\.style === "dots"/);
  assert.match(waveform, /options\.style === "rings"/);
  const controlsPosition = runtime.indexOf("const controlStyle");
  const waveformPosition = runtime.indexOf("<AudioWaveform");
  const transcriptPosition = runtime.indexOf("voiceTranscript");
  const composerPosition = runtime.lastIndexOf("<form");
  assert.ok(controlsPosition >= 0 && controlsPosition < waveformPosition);
  assert.ok(waveformPosition < composerPosition);
  assert.ok(transcriptPosition >= 0 && transcriptPosition < composerPosition);
});

test("widget studio preview reacts to surface and theme changes without clipping its footer", async () => {
  const [frame, studio] = await Promise.all([
    readFile(framePath, "utf8"),
    readFile(studioPreviewPath, "utf8"),
  ]);
  assert.match(frame, /const \[runtimePayload, setRuntimePayload\] = useState\(null\)/);
  assert.match(frame, /const payload = useMemo\([\s\S]{0,120}\(\) => previewWidget \? \{ widget: previewWidget, mode: previewMode \} : runtimePayload/);
  assert.match(frame, /previewWidget \? "h-full min-h-0" : "h-dvh min-h-\[420px\]"/);
  assert.match(frame, /aria-label=\{ui\.aria\.attachFile\}/);
  assert.match(frame, /aria-label=\{ui\.aria\.emoji\}/);
  assert.match(studio, /key=\{`\$\{surface\}-\$\{previewScenario \|\| "default"\}`\}/);
  assert.doesNotMatch(studio, /inset-x-0 top-0 h-12 border-b/);
});

test("voice sessions are short-lived server records with monotonic terminal state", async () => {
  const [route, stateRoute, sessions, schema] = await Promise.all([
    readFile(sessionRoutePath, "utf8"),
    readFile(voiceStatePath, "utf8"),
    readFile(sessionsPath, "utf8"),
    readFile(schemaPath, "utf8"),
  ]);
  assert.match(route, /z\.enum\(\["messaging", "voice"\]\)/);
  assert.match(route, /activateVoiceSession/);
  assert.match(stateRoute, /z\.enum\(\["active", "completed", "failed"\]\)/);
  assert.match(sessions, /status IN \('completed', 'failed'\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS widget_sessions/);
  assert.match(schema, /telnyx_call_id TEXT/);
});

test("embed loader refreshes the short-lived bootstrap token when a panel opens", async () => {
  const source = await readFile(loaderPath, "utf8");
  assert.match(source, /function openPanel\(mode\)[\s\S]*bootstrap refresh returned/);
  assert.match(source, /var evaluated = evaluateWidget\(payload\.widget\)/);
  assert.match(source, /openFrame\(mode, evaluated\.widget\)/);
  assert.match(source, /widget: runtimeWidget/);
  assert.match(source, /widget\.launcherIconSvg \|\| iconSvg/);
});

test("every retained iframe session requests a fresh origin-bound bootstrap token", async () => {
  const [loader, client, frame, voice] = await Promise.all([
    readFile(loaderPath, "utf8"),
    readFile(bootstrapClientPath, "utf8"),
    readFile(framePath, "utf8"),
    readFile(runtimePath, "utf8"),
  ]);
  assert.match(loader, /telnyx-widget-bootstrap-request/);
  assert.match(loader, /telnyx-widget-bootstrap-response/);
  assert.match(client, /event\.source !== window\.parent/);
  assert.match(client, /event\.origin !== expectedOrigin/);
  assert.match(frame, /requestFreshWidgetBootstrap\(widget\.id\)/);
  assert.match(voice, /requestFreshWidgetBootstrap\(widget\.id\)/);
});

test("streamed assistant text accumulates into one bubble per spoken response", async () => {
  const { mergeTranscript } = await import("../lib/widgets/voice-transcript.js");
  const timestamp = new Date("2026-08-19T12:44:00.000Z");
  // The library emits one item per delta, each carrying its own Date.now() suffix.
  const deltas = ["Sure!", " Genesys", " Cloud"].map((content, index) => ({
    id: `item_abc-${1_755_000_000_000 + index}`,
    role: "assistant",
    content,
    timestamp,
  }));
  let transcript = [];
  for (const delta of deltas) transcript = mergeTranscript(transcript, delta);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].content, "Sure! Genesys Cloud");
  assert.equal(transcript[0].id, "item_abc");

  // A completed user utterance keeps its own bubble and replaces rather than appends.
  transcript = mergeTranscript(transcript, {
    id: "item_user_1", role: "user", content: "Tell me about Architect.", timestamp,
  });
  transcript = mergeTranscript(transcript, {
    id: "item_user_1", role: "user", content: "Tell me about Architect application.", timestamp,
  });
  assert.equal(transcript.length, 2);
  assert.equal(transcript[1].content, "Tell me about Architect application.");

  // The next assistant response starts a new bubble because its item_id changed.
  transcript = mergeTranscript(transcript, {
    id: "item_def-1755000009999", role: "assistant", content: "Architect", timestamp,
  });
  assert.equal(transcript.length, 3);
  assert.deepEqual(transcript.map((entry) => entry.content), [
    "Sure! Genesys Cloud",
    "Tell me about Architect application.",
    "Architect",
  ]);
});

test("the widget panel renders on a transparent document so its rounded corners stay clean", async () => {
  const page = await readFile(new URL("../app/widget/frame/page.jsx", import.meta.url), "utf8");
  assert.match(page, /html,body\{background:transparent\}/);
});

test("voice status is split into a session badge and a conversation badge", async () => {
  const [runtime, controls, config] = await Promise.all([
    readFile(runtimePath, "utf8"),
    readFile(new URL("../components/widget-admin/WidgetStudioControls.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/widgets/config.js", import.meta.url), "utf8"),
  ]);
  // The combined string truncated; each half now has its own badge and side.
  assert.match(runtime, /function statusText\(status, content\)/);
  assert.match(runtime, /function agentStateBadge\(agentState, content, statusBadge\)/);
  assert.doesNotMatch(runtime, /voiceActiveMessage\}\$\{detail\}/);
  assert.match(runtime, /className="mb-3 flex items-center justify-between gap-2 px-1"/);
  // The right badge keeps its space while idle so the call controls never jump.
  assert.match(runtime, /activeAgentState \? "opacity-100" : "opacity-0"/);
  assert.match(runtime, /aria-hidden=\{activeAgentState \? undefined : "true"\}/);
  // It only reports an agent state during a live call, never over an error.
  assert.match(runtime, /const activeAgentState = active && !error/);

  assert.match(runtime, /listening: \{ label: content\.voiceListeningMessage, icon: statusBadge\.listeningIcon/);
  assert.match(runtime, /speaking: \{ label: content\.voiceSpeakingMessage, icon: statusBadge\.speakingIcon/);
  assert.match(runtime, /thinking: \{ label: content\.voiceThinkingMessage, icon: statusBadge\.thinkingIcon/);
  assert.match(config, /listeningIcon: widgetIcon\.default\("mic"\)/);
  assert.match(config, /speakingIcon: widgetIcon\.default\("volume-2"\)/);
  assert.match(config, /thinkingIcon: widgetIcon\.default\("brain"\)/);
  assert.match(controls, /"statusBadge", "listeningIcon"/);
  assert.match(controls, /"statusBadge", "speakingIcon"/);
  assert.match(controls, /"statusBadge", "thinkingIcon"/);
});

test("widgets published before per-state icons keep parsing", async () => {
  const { DEFAULT_WIDGET_CONFIG, parseWidgetConfig } = await import("../lib/widgets/config.js");
  const legacy = structuredClone(DEFAULT_WIDGET_CONFIG);
  delete legacy.components.voice.statusBadge.listeningIcon;
  delete legacy.components.voice.statusBadge.speakingIcon;
  delete legacy.components.voice.statusBadge.thinkingIcon;
  const badge = parseWidgetConfig(legacy).components.voice.statusBadge;
  assert.deepEqual(
    [badge.listeningIcon, badge.speakingIcon, badge.thinkingIcon],
    ["mic", "volume-2", "brain"]
  );
});
