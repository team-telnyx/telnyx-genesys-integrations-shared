import { createHash } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";

export const TELNYX_INSIGHT_EVENT_TYPE = "conversation.insights.completed";
export const TELNYX_CALL_INSIGHT_EVENT_TYPE = "call.conversation_insights.generated";
export const TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE = "conversation_insight_result";
export const TELNYX_INSIGHT_NOTIFICATION_CHANNEL = "telnyx_insights_completed";

const TELNYX_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedIdentifier(value, label, { required = true } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (!required) return null;
    throw new Error(`${label} is required`);
  }
  if (normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function normalizeInsightGroupWebhookEvent(event) {
  const candidate = event?.data?.event_type ? event.data : event;
  const eventType = String(candidate?.event_type || "").trim();
  if (![
    TELNYX_INSIGHT_EVENT_TYPE,
    TELNYX_CALL_INSIGHT_EVENT_TYPE,
    TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE,
  ].includes(eventType)) {
    return null;
  }
  const payload = candidate?.payload && typeof candidate.payload === "object"
    ? candidate.payload
    : candidate;
  const status = String(payload?.status || candidate?.status || "").trim().toLowerCase() || null;
  if (
    eventType === TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE &&
    status !== "completed"
  ) {
    return null;
  }
  const conversationId = boundedIdentifier(
    payload?.conversation_id,
    "conversation_id",
    { required: false }
  );
  const callControlId = boundedIdentifier(
    payload?.call_control_id,
    "call_control_id",
    { required: false }
  );
  if (!conversationId && !callControlId) {
    throw new Error("conversation_id or call_control_id is required");
  }
  return {
    eventType,
    status,
    conversationId,
    callControlId,
    insightGroupId: boundedIdentifier(payload?.insight_group_id, "insight_group_id", {
      required: false,
    }),
    providerEventId: boundedIdentifier(
      candidate?.id || payload?.request_id,
      "event id",
      { required: false }
    ),
  };
}

export function telnyxInsightWebhookEventType(event) {
  const value = String(event?.data?.event_type || event?.event_type || "").trim();
  return value && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

export function telnyxInsightWebhookStatus(event) {
  const candidate = event?.data?.event_type ? event.data : event;
  const payload = candidate?.payload && typeof candidate.payload === "object"
    ? candidate.payload
    : candidate;
  const value = String(payload?.status || candidate?.status || "").trim().toLowerCase();
  return value && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

export async function resolveConversationIdByCallControlId(
  callControlId,
  {
    apiKey = process.env.TELNYX_API_KEY,
    fetchImpl = fetch,
    attempts = 3,
    retryDelayMs = 250,
  } = {}
) {
  const normalized = boundedIdentifier(callControlId, "call_control_id");
  const token = String(apiKey || "").trim();
  if (!token) throw new Error("TELNYX_API_KEY is required to resolve call_control_id");
  const query = new URLSearchParams({
    "metadata->call_control_id": `eq.${normalized}`,
    limit: "2",
    order: "created_at.desc",
  });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchImpl(`https://api.telnyx.com/v2/ai/conversations?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Telnyx conversation lookup failed (${response.status})`);
    }
    const body = await response.json();
    const matches = (Array.isArray(body?.data) ? body.data : []).filter(
      (conversation) =>
        String(conversation?.metadata?.call_control_id || "").trim() === normalized
    );
    if (matches.length > 1) {
      throw new Error("call_control_id resolved to multiple Telnyx conversations");
    }
    const conversationId = String(matches[0]?.id || "").trim();
    if (conversationId) {
      if (!TELNYX_CONVERSATION_ID.test(conversationId)) {
        throw new Error("Telnyx conversation lookup returned an invalid conversation ID");
      }
      return conversationId;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error("No Telnyx conversation found for call_control_id");
}

function eventIdFor(rawBody, providerEventId) {
  return providerEventId || createHash("sha256").update(rawBody).digest("hex");
}

export async function recordInsightGroupWebhookEvent({
  rawBody,
  event,
  pool = getPostgresPool(),
  resolveConversationId = resolveConversationIdByCallControlId,
}) {
  const normalized = normalizeInsightGroupWebhookEvent(event);
  if (!normalized) {
    const eventType = telnyxInsightWebhookEventType(event);
    const status = telnyxInsightWebhookStatus(event);
    return {
      accepted: false,
      duplicate: false,
      eventType,
      status,
      reason:
        eventType === TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE && status !== "completed"
          ? "not_completed"
          : "unsupported_event_type",
    };
  }
  const conversationId = normalized.conversationId ||
    await resolveConversationId(normalized.callControlId);
  const eventId = eventIdFor(rawBody, normalized.providerEventId);
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO telnyx_conversation_insight_events
         (event_id,event_type,conversation_id,insight_group_id,expires_at)
       VALUES ($1,$2,$3,$4,NOW() + INTERVAL '7 days')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id,conversation_id,insight_group_id,received_at
     )
     SELECT inserted.*,
       pg_notify(
         $5,
         json_build_object(
           'eventId',event_id,
           'conversationId',conversation_id,
           'insightGroupId',insight_group_id,
           'receivedAt',received_at
         )::text
       ) AS notified
     FROM inserted`,
    [
      eventId,
      normalized.eventType,
      conversationId,
      normalized.insightGroupId,
      TELNYX_INSIGHT_NOTIFICATION_CHANNEL,
    ]
  );
  const inserted = result.rows[0] || null;
  return {
    accepted: true,
    duplicate: !inserted,
    eventId,
    eventType: normalized.eventType,
    status: normalized.status,
    conversationId,
    insightGroupId: normalized.insightGroupId,
    receivedAt: inserted?.received_at || null,
  };
}

export async function latestInsightGroupWebhookEvent(
  conversationId,
  { pool = getPostgresPool() } = {}
) {
  const normalized = boundedIdentifier(conversationId, "conversation_id");
  const result = await pool.query(
    `SELECT event_id,conversation_id,insight_group_id,received_at
     FROM telnyx_conversation_insight_events
     WHERE conversation_id=$1 AND expires_at > NOW()
     ORDER BY received_at DESC LIMIT 1`,
    [normalized]
  );
  return result.rows[0] || null;
}
