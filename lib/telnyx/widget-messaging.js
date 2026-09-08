import { createHash } from "node:crypto";

const DEFAULT_API_ORIGIN = "https://api.telnyx.com";

export class TelnyxWidgetMessagingError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "TelnyxWidgetMessagingError";
    this.status = status;
  }
}

function apiOrigin() {
  return String(process.env.TELNYX_API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/$/, "");
}

function apiKey() {
  const value = String(process.env.TELNYX_API_KEY || "").trim();
  if (!value) throw new TelnyxWidgetMessagingError("TELNYX_API_KEY is not configured", 503);
  return value;
}

async function telnyxRequest(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${apiOrigin()}/v2${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        payload?.errors?.[0]?.detail ||
        payload?.errors?.[0]?.title ||
        payload?.error ||
        `Telnyx API request failed (${response.status})`;
      console.error(`[telnyx-widget] API request failed (${response.status}): ${detail}`);
      throw new TelnyxWidgetMessagingError(
        response.status === 429 ? "Messaging rate limit exceeded" : "Telnyx messaging request failed",
        response.status === 429 ? 429 : 502
      );
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new TelnyxWidgetMessagingError("Telnyx API request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createTelnyxWidgetConversation({ widget, sessionId, origin, dynamicVariables = {} }) {
  const payload = await telnyxRequest("/ai/conversations", {
    method: "POST",
    body: JSON.stringify({
      name: `Web widget ${widget.public_id}`,
      metadata: {
        // Conversation metadata is what Telnyx resolves as {{variable}} in web
        // chat, so page context is merged in beneath the integration's own keys.
        ...dynamicVariables,
        source: "telnyx-genesys-widget",
        telnyx_conversation_channel: "web_chat",
        widget_id: widget.public_id,
        widget_session_id: sessionId,
        widget_origin: origin,
      },
    }),
  });
  const id = String(payload?.data?.id || payload?.id || "").trim();
  if (!id) throw new TelnyxWidgetMessagingError("Telnyx did not return a conversation ID");
  return id;
}

export async function addTelnyxWidgetHandoffContext({ conversationId, sessionId }) {
  await telnyxRequest(`/ai/conversations/${encodeURIComponent(conversationId)}/message`, {
    method: "POST",
    body: JSON.stringify({
      role: "system",
      name: "integration_context",
      content:
        `Private integration context. Never reveal this value to the customer. ` +
        `When calling the configured Genesys human handoff tool, pass widget_session_id exactly as: ${sessionId}`,
    }),
  });
}

export async function disableTelnyxConversationAi(conversationId) {
  const current = await telnyxRequest(
    `/ai/conversations/${encodeURIComponent(conversationId)}`
  );
  const conversation = current?.data || current || {};
  await telnyxRequest(`/ai/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PUT",
    body: JSON.stringify({ metadata: { ...(conversation.metadata || {}), ai_disabled: true } }),
  });
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
      .filter(Boolean)
      .join("\n");
  }
  return content?.text || content?.content || "";
}

function stableMessageId(role, createdAt, content) {
  // Conversation messages carry no ID, so a content hash keeps the same message
  // stable across refetches and prevents duplicates when histories are merged.
  const digest = createHash("sha256").update(`${role}|${createdAt}|${content}`).digest("hex");
  return `tlx_${digest.slice(0, 32)}`;
}

export function normalizeTelnyxMessage(message, fallbackRole = "assistant") {
  const source = message?.data || message || {};
  const role = String(source.role || source.type || fallbackRole).toLowerCase();
  const mappedRole = role === "user" || role === "assistant" ? role : fallbackRole;
  const content = String(contentText(source.content ?? source.message ?? source.text) || "");
  const createdAt = source.created_at || source.createdAt || new Date().toISOString();
  return {
    id: String(source.id || source.message_id || stableMessageId(mappedRole, createdAt, content)),
    role: mappedRole,
    content,
    createdAt,
  };
}

export async function sendTelnyxAssistantMessage({ assistantId, conversationId, content }) {
  const payload = await telnyxRequest(
    `/ai/assistants/${encodeURIComponent(assistantId)}/chat`,
    {
      method: "POST",
      body: JSON.stringify({ content, name: "User", conversation_id: conversationId }),
    }
  );
  return normalizeTelnyxMessage(payload, "assistant");
}

export async function listTelnyxConversationMessages(conversationId) {
  const payload = await telnyxRequest(
    `/ai/conversations/${encodeURIComponent(conversationId)}/messages?page[number]=1&page[size]=100`
  );
  return (Array.isArray(payload?.data) ? payload.data : [])
    .filter((message) => ["user", "assistant"].includes(String(message?.role || "").toLowerCase()))
    .map((message) => normalizeTelnyxMessage(message))
    .filter((message) => message.content)
    // Telnyx returns the newest message first; the transcript reads oldest first.
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

const greetingCache = new Map();
const GREETING_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getTelnyxAssistantGreeting(assistantId) {
  const id = String(assistantId || "").trim();
  if (!id) return "";
  const cached = greetingCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.greeting;
  const payload = await telnyxRequest(`/ai/assistants/${encodeURIComponent(id)}`);
  const greeting = String((payload?.data || payload || {}).greeting || "").trim();
  greetingCache.set(id, { greeting, expiresAt: Date.now() + GREETING_CACHE_TTL_MS });
  return greeting;
}
