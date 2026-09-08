import { createHmac, timingSafeEqual } from "node:crypto";
import { getConversationsApi, getRoutingApi, getUsersApi } from "./client.js";
import { selectGenesysProfileImage } from "./profile-images.js";

function configuredSecrets() {
  const value = String(process.env.GC_OPEN_MESSAGING_SECRETS_JSON || "").trim();
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GC_OPEN_MESSAGING_SECRETS_JSON must be valid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("GC_OPEN_MESSAGING_SECRETS_JSON must be an object keyed by integration ID");
  }
  return parsed;
}

export function openMessagingSecret(integrationId) {
  const scoped = String(configuredSecrets()[integrationId] || "").trim();
  const fallback = String(
    process.env.GC_OPEN_MESSAGING_SECRET || process.env.GC_SECRET_TOKEN || ""
  ).trim();
  const secret = scoped || fallback;
  if (secret.length < 16) {
    throw new Error(`No valid Open Messaging webhook secret is configured for ${integrationId}`);
  }
  return secret;
}

export function verifyGenesysOpenMessagingSignature({ rawBody, signature, secret }) {
  const supplied = String(signature || "");
  if (!supplied.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("base64")}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function customAttributes(handoff) {
  return Object.fromEntries(
    Object.entries({
      telnyx_ai_handoff_id: handoff.id,
      telnyx_conversation_id: handoff.telnyx_conversation_id,
      telnyx_ai_queue_id: handoff.queue_id,
      telnyx_ai_queue_name: handoff.queue_name,
      telnyx_ai_handoff_reason: handoff.reason,
      telnyx_ai_summary: handoff.summary,
      telnyx_ai_intent: handoff.intent,
      telnyx_ai_sentiment: handoff.sentiment,
      telnyx_ai_channel: "messaging",
    }).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

function inboundBody({ handoff, messageId, text, metadata = {}, attachments = [] }) {
  const content = attachments.map((attachment) => ({
    contentType: "Attachment",
    attachment: {
      id: attachment.id,
      mediaType: attachment.mediaType,
      url: attachment.url,
      mime: attachment.mime,
      filename: attachment.filename,
      ...(attachment.size ? { contentSizeBytes: attachment.size } : {}),
    },
  }));
  return {
    channel: {
      messageId,
      from: {
        id: handoff.genesys_remote_address,
        idType: "Opaque",
        nickname: "Web customer",
      },
      time: new Date().toISOString(),
      metadata: { customAttributes: { ...customAttributes(handoff), ...metadata } },
    },
    type: "Text",
    text,
    ...(content.length ? { content } : {}),
  };
}

export async function startGenesysMessagingHandoff({ handoff }) {
  const conversationsApi = await getConversationsApi();
  const response = await conversationsApi.postConversationsMessageInboundOpenMessage(
    handoff.genesys_integration_id,
    inboundBody({
      handoff,
      messageId: handoff.id,
      text: handoff.summary
        ? `Klient poprosił o połączenie z konsultantem.\n\nPodsumowanie AI: ${handoff.summary}`
        : "Klient poprosił o połączenie z konsultantem.",
    }),
    { prefetchConversationId: true }
  );
  const conversationId = String(
    response?.conversationId || response?.conversation_id || response?.conversation?.id || ""
  ).trim();
  if (!conversationId) {
    throw new Error("Genesys Open Messaging did not return conversationId");
  }
  return { conversationId, response };
}

export async function validateGenesysHandoffQueue({ queueId, queueName }) {
  const routingApi = await getRoutingApi();
  const queue = await routingApi.getRoutingQueue(queueId);
  if (!queue?.id || queue.id !== queueId) throw new Error("Configured Genesys queue was not found");
  if (queueName && queue.name !== queueName) {
    throw new Error("Configured Genesys queue name no longer matches its immutable ID");
  }
  return { id: queue.id, name: queue.name };
}

export async function sendGenesysCustomerMessage({ handoff, messageId, text, attachments = [] }) {
  const conversationsApi = await getConversationsApi();
  await conversationsApi.postConversationsMessageInboundOpenMessage(
    handoff.genesys_integration_id,
    inboundBody({ handoff, messageId, text, attachments }),
    { prefetchConversationId: false }
  );
}

export function genesysCustomerTypingBody(handoff, now = new Date()) {
  return {
    channel: {
      from: {
        id: handoff.genesys_remote_address,
        idType: "Opaque",
        nickname: "Web customer",
      },
      time: now.toISOString(),
    },
    events: [{ eventType: "Typing", typing: { type: "On" } }],
  };
}

export async function sendGenesysCustomerTyping({ handoff }) {
  const conversationsApi = await getConversationsApi();
  await conversationsApi.postConversationsMessageInboundOpenEvent(
    handoff.genesys_integration_id,
    genesysCustomerTypingBody(handoff)
  );
}

export function genesysOutboundRemoteAddress(body) {
  const candidates = [body?.channel?.to?.id, body?.channel?.from?.id];
  return candidates
    .map((value) => String(value || "").trim())
    .find((value) => value.startsWith("telnyx-widget:")) || null;
}

export function genesysOutboundAgentName(body) {
  const nickname = String(body?.channel?.from?.nickname || "").trim();
  return nickname ? nickname.slice(0, 200) : null;
}

export function genesysOutboundTypingDuration(body) {
  if (String(body?.type || "").toLowerCase() !== "event") return null;
  const event = (Array.isArray(body?.events) ? body.events : []).find(
    (entry) => String(entry?.eventType || "").toLowerCase() === "typing"
  );
  if (!event || String(event?.typing?.type || "On").toLowerCase() === "off") return null;
  return Math.max(1000, Math.min(15_000, Math.round(Number(event?.typing?.duration) || 5000)));
}

// A messaging participant carries no top-level state; the lifecycle lives on its
// media session, where Genesys reports "alerting" while the interaction is offered
// to the agent and "connected" once they accept. That is the assigned/joined
// distinction the widget timeline draws.
function participantMessageState(participant) {
  const sessions = Array.isArray(participant?.messages) ? participant.messages : [];
  const live = sessions.find((entry) => {
    const state = String(entry?.state || "").toLowerCase();
    return state && state !== "disconnected" && state !== "terminated";
  });
  const selected = live || sessions[sessions.length - 1];
  return String(selected?.state || "").toLowerCase() || null;
}

export async function resolveGenesysConversationAgent({
  conversationId,
  fallbackName = null,
  conversationsApi: providedConversationsApi = null,
  usersApi: providedUsersApi = null,
}) {
  if (!conversationId) return { name: fallbackName, userId: null, imageUri: null };
  const conversationsApi = providedConversationsApi || await getConversationsApi();
  const conversation = await conversationsApi.getConversation(conversationId);
  const participants = (Array.isArray(conversation?.participants) ? conversation.participants : [])
    .filter((participant) => participant?.purpose === "agent" && participant?.userId)
    .sort((left, right) => {
      const leftActive = left.endTime ? 0 : 1;
      const rightActive = right.endTime ? 0 : 1;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return new Date(right.connectedTime || right.startTime || 0).getTime()
        - new Date(left.connectedTime || left.startTime || 0).getTime();
    });
  const participant = participants[0];
  if (!participant) return { name: fallbackName, userId: null, imageUri: null, state: null };
  const state = participantMessageState(participant);

  const usersApi = providedUsersApi || await getUsersApi();
  // Genesys omits the image collection by default. Without the explicit
  // expansion the user is resolved correctly, but their avatar is always null.
  const user = await usersApi.getUser(participant.userId, { expand: ["images"] });
  return {
    name: user?.name || participant.name || fallbackName,
    userId: participant.userId,
    imageUri: selectGenesysProfileImage(user?.images),
    state,
  };
}

export function genesysOutboundAttachments(body) {
  const safeUrl = (value) => {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  };
  return (Array.isArray(body?.content) ? body.content : [])
    .map((item) => item?.attachment)
    .filter(Boolean)
    .slice(0, 5)
    .map((attachment) => ({
      id: attachment.id || null,
      mediaType: attachment.mediaType || null,
      mime: attachment.mime || null,
      filename: attachment.filename || null,
      text: attachment.text || null,
      url: safeUrl(attachment.url),
      sha256: attachment.sha256 || null,
    }));
}
