import { getConversationsApi } from "./client.js";
import { latestInsightGroupWebhookEvent } from "../telnyx/insight-events.mjs";

const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class GenesysWidgetAccessError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = "GenesysWidgetAccessError";
    this.status = status;
  }
}

function genesysUrl(path) {
  const environment = String(process.env.GC_ENVIRONMENT || "").trim();
  if (!environment) throw new Error("GC_ENVIRONMENT is not configured");
  return `https://api.${environment}${path}`;
}

async function currentAgent(accessToken) {
  const response = await fetch(genesysUrl("/api/v2/users/me"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GenesysWidgetAccessError(
      response.status === 401 ? "Genesys Cloud session expired" : "Genesys Cloud access denied",
      response.status === 401 ? 401 : 403
    );
  }
  return response.json();
}

function userId(participant) {
  return String(participant?.userId || participant?.user?.id || "");
}

export function collectGenesysConversationAttributes(conversation) {
  return Object.assign(
    {},
    ...(conversation?.participants || []).map((participant) => participant?.attributes || {})
  );
}

async function telnyxGet(path) {
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Telnyx API request failed (${response.status})`);
  return response.json();
}

export function sipHeaderValue(rawHeaders, expectedName) {
  const name = String(expectedName || "").trim().toLowerCase();
  if (!name) return "";
  for (const line of String(rawHeaders || "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1 || line.slice(0, separator).trim().toLowerCase() !== name) continue;
    return line.slice(separator + 1).trim();
  }
  return "";
}

async function resolveTelnyxConversationId(context) {
  const rawHeaders = context.telnyx_sip_headers || "";
  const direct = String(
    context.telnyx_conversation_id || ""
  ).trim();
  if (CONVERSATION_ID.test(direct)) return direct;

  const callControlId = String(
    context.telnyx_call_control_id ||
      sipHeaderValue(rawHeaders, "X-TGX-Call-Control-Id") ||
      ""
  ).trim();
  if (!callControlId) return "";
  const query = new URLSearchParams({
    "metadata->call_control_id": `eq.${callControlId}`,
    limit: "2",
    order: "created_at.desc",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = await telnyxGet(`/ai/conversations?${query}`);
    const candidates = Array.isArray(payload?.data) ? payload.data : [];
    const resolved = String(candidates[0]?.id || "").trim();
    if (resolved) return resolved;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

async function messages(conversationId) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await telnyxGet(
      `/ai/conversations/${encodeURIComponent(conversationId)}/messages?page[number]=${page}&page[size]=100`
    );
    const items = Array.isArray(payload?.data) ? payload.data : [];
    result.push(...items);
    if (items.length < 100 || (payload?.meta?.total_pages && page >= payload.meta.total_pages)) break;
  }
  return result;
}

export function parseTelnyxWidgetValue(value) {
  if (Array.isArray(value)) return value.map(parseTelnyxWidgetValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, parseTelnyxWidgetValue(nested)])
    );
  }
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (!normalized.startsWith("{") && !normalized.startsWith("[")) return value;
  try {
    return parseTelnyxWidgetValue(JSON.parse(normalized));
  } catch {
    return value;
  }
}

export async function authorizeGenesysAiConversationWidget({ conversationId, accessToken }) {
  if (!CONVERSATION_ID.test(String(conversationId || ""))) {
    throw new GenesysWidgetAccessError("Invalid Genesys conversation ID", 400);
  }
  if (!accessToken) throw new GenesysWidgetAccessError("Genesys Cloud authentication required", 401);
  const [agent, conversationsApi] = await Promise.all([currentAgent(accessToken), getConversationsApi()]);
  const conversation = await conversationsApi.getConversation(conversationId);
  const assigned = (conversation?.participants || []).some(
    (participant) => userId(participant) === agent.id && ["agent", "user"].includes(String(participant.purpose || "").toLowerCase())
  );
  if (!assigned) {
    throw new GenesysWidgetAccessError("This Genesys Cloud user is not assigned to the interaction", 403);
  }
  const context = collectGenesysConversationAttributes(conversation);
  const telnyxConversationId = await resolveTelnyxConversationId(context);
  if (!telnyxConversationId) {
    throw new GenesysWidgetAccessError("No Telnyx AI handoff is associated with this interaction", 404);
  }
  return { agent, conversation, context, telnyxConversationId };
}

async function insightNames() {
  const payload = await telnyxGet("/ai/conversations/insight-groups?page[number]=1&page[size]=100");
  const names = {};
  for (const group of Array.isArray(payload?.data) ? payload.data : []) {
    for (const insight of Array.isArray(group?.insights) ? group.insights : []) {
      if (insight?.id && insight?.name) names[insight.id] = insight.name;
    }
  }
  return names;
}

async function costs(conversationId, conversation) {
  const url = new URL(
    `https://api.telnyx.com/v2/session_analysis/ai-voice-assistant/${encodeURIComponent(conversationId)}`
  );
  url.searchParams.set("include_children", "true");
  url.searchParams.set("max_depth", "5");
  url.searchParams.set("expand", "record");
  const createdAt = conversation?.created_at || conversation?.createdAt;
  if (createdAt) {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      url.searchParams.set("date_time", parsed.toISOString().slice(0, 10));
    }
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return response.json();
}

function settled(result, fallback) {
  return result.status === "fulfilled" ? result.value : fallback;
}

export function normalizeGenesysWidgetChannel(value) {
  const channel = String(value || "voice").trim().toLowerCase();
  return ["messaging", "message", "web_chat"].includes(channel) ? "messaging" : "voice";
}

export async function loadGenesysAiConversationWidget({ conversationId, accessToken }) {
  const { context, telnyxConversationId } = await authorizeGenesysAiConversationWidget({
    conversationId,
    accessToken,
  });
  const conversationResult = await Promise.allSettled([
    telnyxGet(`/ai/conversations/${encodeURIComponent(telnyxConversationId)}`),
  ]);
  const loadedConversation =
    settled(conversationResult[0], null)?.data || settled(conversationResult[0], null) || {
      id: telnyxConversationId,
      metadata: {},
    };
  const results = await Promise.allSettled([
    messages(telnyxConversationId),
    telnyxGet(`/ai/conversations/${encodeURIComponent(telnyxConversationId)}/conversations-insights?page[size]=100`),
    telnyxGet(`/ai/conversations/${encodeURIComponent(telnyxConversationId)}/webhook-logs?page[number]=1&page[size]=1&sort=-created_at`),
    insightNames(),
    costs(telnyxConversationId, loadedConversation),
    latestInsightGroupWebhookEvent(telnyxConversationId),
  ]);
  const loadedMessages = settled(results[0], []);
  const dynamicVariables = settled(results[2], null);
  const loadedInsights = settled(results[1], null)?.data || [];
  const insightsReady = loadedInsights.some(
    (entry) => Array.isArray(entry?.conversation_insights) && entry.conversation_insights.length > 0
  );
  const latestInsightEvent = settled(results[5], null);
  const normalizedChannel = normalizeGenesysWidgetChannel(
    context.telnyx_ai_channel || context.telnyx_conversation_channel
  );
  return {
    genesysConversationId: conversationId,
    telnyxConversationId,
    context: {
      channel: normalizedChannel,
      handoffId: context.telnyx_ai_handoff_id || null,
      assistantId: context.telnyx_ai_assistant_id || null,
      queueId: context.telnyx_ai_queue_id || null,
      queueName: context.telnyx_ai_queue_name || null,
      handoffReason: context.telnyx_ai_handoff_reason || null,
      summary: context.telnyx_ai_summary || null,
      intent: context.telnyx_ai_intent || null,
      sentiment: context.telnyx_ai_sentiment || "neutral",
      transcript: context.telnyx_ai_transcript || null,
      dnis: context.telnyx_ai_dnis || null,
    },
    conversation: {
      ...loadedConversation,
      id: loadedConversation?.id || telnyxConversationId,
      metadata: {
        ...(loadedConversation?.metadata || {}),
        genesys_conversation_id: conversationId,
        genesys_handoff_id: context.telnyx_ai_handoff_id || null,
        genesys_channel: normalizedChannel,
        genesys_queue_name: context.telnyx_ai_queue_name || null,
      },
    },
    messages: loadedMessages,
    insights: loadedInsights,
    insightNames: settled(results[3], {}),
    dynamicVariables: dynamicVariables ? parseTelnyxWidgetValue(dynamicVariables) : null,
    costs: settled(results[4], null),
    sync: {
      insightsPending: !insightsReady,
      insightWebhookReceivedAt: latestInsightEvent?.received_at || null,
    },
  };
}
