export const GENESYS_HANDOFF_CHANNELS = Object.freeze({
  MESSAGING: "messaging",
  CHAT: "messaging",
  VOICE: "voice",
});

export const TELNYX_CONVERSATION_CHANNELS = Object.freeze({
  PHONE_CALL: "phone_call",
  WEB_CALL: "web_call",
  WEBSOCKET_CALL: "websocket_call",
  SMS_CHAT: "sms_chat",
  WEB_CHAT: "web_chat",
  LEGACY_SMS: "sms",
});

export const TELNYX_HANDOFF_MECHANISMS = Object.freeze({
  AUDIO_CONNECTOR: "audio_connector",
  SIP_TRANSFER: "sip_transfer",
  OPEN_MESSAGING: "open_messaging",
});

const CHAT_CHANNEL_ALIASES = new Set([
  "chat",
  "messaging",
  "sms",
  "sms_chat",
  "web_chat",
]);

const VOICE_CHANNEL_ALIASES = new Set([
  "voice",
  "phone",
  "phone_call",
  "web_call",
  "websocket_call",
  "genesys_audio_connector",
]);

const TELNYX_CHANNEL_VALUES = new Set(Object.values(TELNYX_CONVERSATION_CHANNELS));

export class GenesysHandoffValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "GenesysHandoffValidationError";
    this.code = "GENESYS_HANDOFF_INVALID_REQUEST";
    this.status = 400;
    this.field = field;
  }
}

export function normalizeGenesysHandoffChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (CHAT_CHANNEL_ALIASES.has(normalized)) return GENESYS_HANDOFF_CHANNELS.CHAT;
  if (VOICE_CHANNEL_ALIASES.has(normalized)) return GENESYS_HANDOFF_CHANNELS.VOICE;
  return null;
}

export function normalizeTelnyxConversationChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TELNYX_CHANNEL_VALUES.has(normalized) ? normalized : null;
}

export function genesysHandoffChannelForTelnyx(value) {
  const telnyxChannel = normalizeTelnyxConversationChannel(value);
  if (!telnyxChannel) return null;
  return normalizeGenesysHandoffChannel(telnyxChannel);
}

export function telnyxHandoffMechanism(value) {
  const channel = normalizeTelnyxConversationChannel(value);
  if (channel === TELNYX_CONVERSATION_CHANNELS.WEBSOCKET_CALL) {
    return TELNYX_HANDOFF_MECHANISMS.AUDIO_CONNECTOR;
  }
  if (
    channel === TELNYX_CONVERSATION_CHANNELS.PHONE_CALL ||
    channel === TELNYX_CONVERSATION_CHANNELS.WEB_CALL
  ) {
    return TELNYX_HANDOFF_MECHANISMS.SIP_TRANSFER;
  }
  if (
    channel === TELNYX_CONVERSATION_CHANNELS.SMS_CHAT ||
    channel === TELNYX_CONVERSATION_CHANNELS.WEB_CHAT ||
    channel === TELNYX_CONVERSATION_CHANNELS.LEGACY_SMS
  ) {
    return TELNYX_HANDOFF_MECHANISMS.OPEN_MESSAGING;
  }
  return null;
}

function requiredText(value, field, maxLength) {
  const normalized = String(value || "").trim().slice(0, maxLength);
  if (!normalized) {
    throw new GenesysHandoffValidationError(`${field} is required`, field);
  }
  return normalized;
}

function optionalText(value, maxLength) {
  const normalized = String(value || "").trim().slice(0, maxLength);
  return normalized || null;
}

export function normalizeGenesysHandoffRequest(
  body,
  { defaultChannel, defaultQueueName = "", allowedQueueNames = [] } = {}
) {
  const requestedChannel =
    body?.telnyx_conversation_channel || body?.channel || defaultChannel;
  const channel = normalizeGenesysHandoffChannel(requestedChannel);
  if (!channel) {
    throw new GenesysHandoffValidationError(
      "telnyx_conversation_channel is not supported",
      "telnyx_conversation_channel"
    );
  }

  const sentiment = optionalText(body?.sentiment, 32);
  if (
    sentiment &&
    !["positive", "neutral", "negative", "mixed", "unknown"].includes(sentiment)
  ) {
    throw new GenesysHandoffValidationError(
      "sentiment must be positive, neutral, negative, mixed, or unknown",
      "sentiment"
    );
  }

  const requestedQueue = optionalText(body?.queue_name || body?.queue_key, 200);
  const allowed = new Map((allowedQueueNames || []).map((name) => [
    String(name || "").trim().toLocaleLowerCase(),
    String(name || "").trim(),
  ]).filter(([key]) => key));
  const queueName = requestedQueue && (!allowed.size || allowed.has(requestedQueue.toLocaleLowerCase()))
    ? requestedQueue
    : String(defaultQueueName || "").trim();
  if (!queueName) throw new GenesysHandoffValidationError("queue_name is required", "queue_name");
  return {
    channel,
    queueName,
    queueFallbackReason: requestedQueue && queueName === requestedQueue
      ? null
      : requestedQueue
        ? "outside_allowlist"
        : "missing",
    reason: requiredText(body?.reason, "reason", 2000),
    summary: requiredText(body?.summary, "summary", 4000),
    intent: requiredText(body?.intent, "intent", 200),
    sentiment: sentiment || "neutral",
  };
}

export function genesysVoiceHandoffOutputVariables({
  handoffId,
  queueName,
  queueId,
  reason,
  summary,
  intent,
  sentiment,
  telnyxConversationId,
  transcript,
}) {
  const values = {
    routeToHuman: "true",
    handoffId,
    queueName,
    queueId,
    handoffReason: reason,
    summary,
    intent,
    sentiment,
    telnyxConversationId,
    telnyxAiTranscript: transcript,
  };

  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value).slice(0, 4000)])
  );
}

export function formatGenesysVoiceTranscript(entries, maxLength = 4000) {
  const text = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const role = entry?.role === "assistant" ? "AI" : "Customer";
      const value = String(entry?.text || "").trim();
      return value ? `${role}: ${value}` : "";
    })
    .filter(Boolean)
    .join("\n");

  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}
