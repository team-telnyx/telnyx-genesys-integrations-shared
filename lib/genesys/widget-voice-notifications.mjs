import { WebSocket } from "ws";

import { getPostgresPool } from "../postgres.mjs";
import { upsertVoiceHandoffFromNotification } from "../widgets/handoffs.js";
import { getNotificationsApi, getUsersApi } from "./client.js";

const QUEUE_CALL_TOPIC = /^v2\.routing\.queues\.([^.]+)\.conversations\.calls$/;
const TERMINAL_CALL_STATES = new Set(["disconnected", "terminated"]);
const ASSIGNED_CALL_STATES = new Set(["alerting", "contacting", "dialing"]);
const AGENT_NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const AGENT_NAME_MISS_CACHE_TTL_MS = 30_000;
const agentNameCache = new Map();

function text(value) {
  return String(value || "").trim() || null;
}

function participantState(participant) {
  // Queue and user notification topics flatten the active media state onto the
  // participant. Conversation API responses instead expose it under calls[].
  // Support both representations because the latter is also used by tests and
  // by older Genesys payload projections.
  const direct = text(participant?.state)?.toLowerCase();
  if (direct) return direct;
  const calls = Array.isArray(participant?.calls) ? participant.calls : [];
  const live = calls.find((call) => {
    const state = text(call?.state)?.toLowerCase();
    return state && !TERMINAL_CALL_STATES.has(state);
  });
  const selected = live || calls[calls.length - 1];
  return text(selected?.state)?.toLowerCase() || null;
}

function participantUserId(participant) {
  return text(participant?.userId || participant?.user?.id);
}

function participantName(participant) {
  return text(participant?.name || participant?.user?.name);
}

function participantQueueId(participant) {
  return text(participant?.queueId || participant?.queue?.id);
}

function participantQueueName(participant) {
  return text(participant?.queue?.name);
}

function participantEnded(participant) {
  return Boolean(
    participant?.endTime || TERMINAL_CALL_STATES.has(participantState(participant))
  );
}

function mergedAttributes(participants) {
  return Object.assign(
    {},
    ...participants.map((participant) =>
      participant?.attributes && typeof participant.attributes === "object"
        ? participant.attributes
        : {}
    )
  );
}

function agentParticipants(participants) {
  return participants.filter((participant) =>
    ["agent", "user"].includes(text(participant?.purpose)?.toLowerCase()) &&
    participantUserId(participant)
  );
}

export function normalizeGenesysWidgetVoiceEvent(message) {
  const topicName = text(message?.topicName || message?.metadata?.topicName);
  const topic = QUEUE_CALL_TOPIC.exec(topicName || "");
  if (!topic) return null;
  const event = message?.eventBody || message?.event_body;
  if (!event || typeof event !== "object") return null;
  const conversationId = text(event.id);
  if (!conversationId) return null;
  const participants = Array.isArray(event.participants) ? event.participants : [];
  const attributes = mergedAttributes(participants);
  const rawSessionId = text(attributes.telnyx_widget_session_id);
  const sessionId = rawSessionId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(rawSessionId)
    ? rawSessionId
    : null;
  const telnyxCallId = text(attributes.telnyx_call_control_id);
  if (!sessionId && !telnyxCallId) return null;

  const agents = agentParticipants(participants);
  const activeAgents = agents.filter((participant) => !participantEnded(participant));
  const connectedAgent = activeAgents.find((participant) =>
    participantState(participant) === "connected" || Boolean(participant?.connectedTime)
  ) || null;
  const assignedAgent = connectedAgent || activeAgents.find((participant) =>
    ASSIGNED_CALL_STATES.has(participantState(participant))
  ) || activeAgents[0] || null;
  const customer = participants.find((participant) =>
    text(participant?.purpose)?.toLowerCase() === "customer"
  ) || null;
  const conversationEnded = customer
    ? participantEnded(customer)
    : agents.length > 0 && agents.every(participantEnded);

  let status = "waiting";
  if (connectedAgent) status = "connected";
  else if (assignedAgent) status = "assigned";
  else if (conversationEnded) status = "disconnected";

  // A declined offer creates an ended agent participant while the customer is
  // still queued. Do not report that as a disconnected handoff; retain the last
  // agent only after the customer interaction itself has ended.
  const agent = connectedAgent || assignedAgent || (status === "disconnected" ? agents.at(-1) : null);

  return {
    sessionId,
    telnyxCallId,
    status,
    genesysConversationId: conversationId,
    queueId: text(attributes.telnyx_ai_queue_id) || participantQueueId(agent) || topic[1],
    queueName: text(attributes.telnyx_ai_queue_name) || participantQueueName(agent),
    agentName: participantName(agent),
    agentUserId: participantUserId(agent),
  };
}

async function resolveGenesysVoiceAgentName(agentUserId, { usersApi = null } = {}) {
  const userId = text(agentUserId);
  if (!userId) return null;
  const now = Date.now();
  const cached = agentNameCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.promise;

  const entry = { expiresAt: Number.POSITIVE_INFINITY, promise: null };
  entry.promise = (async () => {
    const api = usersApi || await getUsersApi();
    const user = await api.getUser(userId);
    const name = text(user?.name);
    entry.expiresAt = Date.now() + (name ? AGENT_NAME_CACHE_TTL_MS : AGENT_NAME_MISS_CACHE_TTL_MS);
    return name;
  })();
  agentNameCache.set(userId, entry);

  try {
    return await entry.promise;
  } catch (error) {
    if (agentNameCache.get(userId) === entry) agentNameCache.delete(userId);
    throw error;
  }
}

export async function enrichGenesysWidgetVoiceEvent(event, options = {}) {
  if (!event || event.agentName || !event.agentUserId) return event;
  try {
    const agentName = await resolveGenesysVoiceAgentName(event.agentUserId, options);
    return agentName ? { ...event, agentName } : event;
  } catch (error) {
    console.warn(
      `[genesys-widget-voice-notifications] user ${event.agentUserId} lookup failed:`,
      error.message
    );
    return event;
  }
}

async function persistGenesysWidgetVoiceEvent(event, {
  pool = getPostgresPool(),
  usersApi = null,
} = {}) {
  const enriched = await enrichGenesysWidgetVoiceEvent(event, { usersApi });
  return upsertVoiceHandoffFromNotification({ ...enriched, pool });
}

export async function recordGenesysWidgetVoiceEvent(message, options = {}) {
  const event = normalizeGenesysWidgetVoiceEvent(message);
  if (!event) return null;
  return persistGenesysWidgetVoiceEvent(event, options);
}

export async function listGenesysWidgetVoiceQueueIds({ pool = getPostgresPool() } = {}) {
  const result = await pool.query(
    `SELECT DISTINCT queue_id
     FROM (
       SELECT q.genesys_queue_id AS queue_id
       FROM integration_handoff_policies p
       JOIN integration_configuration_aggregates a ON a.id=p.aggregate_id
       JOIN integration_handoff_policy_queues q ON q.policy_id=p.id
       WHERE p.context='web_voice' AND a.enabled=TRUE
       UNION
       SELECT queue_item->>'id' AS queue_id
       FROM widgets w
       JOIN widget_revisions r ON r.id=w.published_revision_id
       CROSS JOIN LATERAL jsonb_array_elements(
         COALESCE(r.config #> '{channels,messaging,genesys,queues}', '[]'::jsonb)
       ) queue_item
       WHERE w.enabled=TRUE
         AND COALESCE((r.config #>> '{channels,voice,enabled}')::boolean,FALSE)=TRUE
     ) queues
     WHERE queue_id IS NOT NULL AND queue_id <> ''
     ORDER BY queue_id`
  );
  return result.rows.map((row) => text(row.queue_id)).filter(Boolean);
}

function state() {
  if (!globalThis.__genesysWidgetVoiceNotifications) {
    globalThis.__genesysWidgetVoiceNotifications = {
      stopped: true,
      connecting: null,
      socket: null,
      channelId: null,
      notificationsApi: null,
      topics: new Set(),
      reconnectTimer: null,
      refreshTimer: null,
    };
  }
  return globalThis.__genesysWidgetVoiceNotifications;
}

function configured() {
  return Boolean(
    process.env.GC_ENVIRONMENT &&
    process.env.GC_CLIENT_CRED_CLIENT_ID &&
    process.env.GC_CLIENT_CRED_CLIENT_SECRET
  );
}

function scheduleReconnect(delayMs = 2_000) {
  const monitor = state();
  if (monitor.stopped || monitor.reconnectTimer) return;
  monitor.reconnectTimer = setTimeout(() => {
    monitor.reconnectTimer = null;
    void connect().catch((error) => {
      console.error("[genesys-widget-voice-notifications] reconnect failed:", error.message);
      scheduleReconnect(Math.min(delayMs * 2, 30_000));
    });
  }, delayMs);
  monitor.reconnectTimer.unref?.();
}

async function subscribeQueueTopics(queueIds) {
  const monitor = state();
  const missing = queueIds
    .map((queueId) => `v2.routing.queues.${queueId}.conversations.calls`)
    .filter((topic) => !monitor.topics.has(topic));
  if (!missing.length || !monitor.notificationsApi || !monitor.channelId) return missing.length;
  await monitor.notificationsApi.postNotificationsChannelSubscriptions(
    monitor.channelId,
    missing.map((id) => ({ id })),
    { ignoreErrors: false }
  );
  for (const topic of missing) monitor.topics.add(topic);
  return missing.length;
}

async function handleSocketMessage(data) {
  let message;
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  const messages = Array.isArray(message) ? message : [message];
  for (const item of messages) {
    const normalized = normalizeGenesysWidgetVoiceEvent(item);
    if (!normalized) continue;
    try {
      const handoff = await persistGenesysWidgetVoiceEvent(normalized);
      if (handoff) {
        console.info("[genesys-widget-voice-notifications] handoff updated", {
          conversationId: normalized.genesysConversationId,
          status: handoff.status,
        });
      } else {
        console.warn("[genesys-widget-voice-notifications] event did not match a widget session", {
          conversationId: normalized.genesysConversationId,
          sessionId: normalized.sessionId,
          telnyxCallId: normalized.telnyxCallId,
        });
      }
    } catch (error) {
      console.error("[genesys-widget-voice-notifications] event failed:", error.message);
    }
  }
}

async function connect() {
  const monitor = state();
  if (monitor.stopped || !configured()) return { configured: false, subscriptions: 0 };
  if (monitor.connecting) return monitor.connecting;
  monitor.connecting = (async () => {
    const queueIds = await listGenesysWidgetVoiceQueueIds();
    if (!queueIds.length) return { configured: true, subscriptions: 0 };
    const notificationsApi = await getNotificationsApi();
    const channel = await notificationsApi.postNotificationsChannels();
    if (!channel?.id || !channel?.connectUri) {
      throw new Error("Genesys notification channel did not return an ID and connect URI");
    }
    monitor.notificationsApi = notificationsApi;
    monitor.channelId = channel.id;
    monitor.topics.clear();
    await subscribeQueueTopics(queueIds);

    const socket = new WebSocket(channel.connectUri);
    monitor.socket = socket;
    socket.on("message", (data) => void handleSocketMessage(data));
    socket.on("error", (error) => {
      console.error("[genesys-widget-voice-notifications] WebSocket error:", error.message);
    });
    socket.on("close", () => {
      if (monitor.socket === socket) {
        monitor.socket = null;
        monitor.channelId = null;
        monitor.notificationsApi = null;
        monitor.topics.clear();
      }
      scheduleReconnect();
    });
    return { configured: true, subscriptions: monitor.topics.size };
  })().finally(() => {
    monitor.connecting = null;
  });
  return monitor.connecting;
}

export async function refreshGenesysWidgetVoiceSubscriptions() {
  const monitor = state();
  if (monitor.stopped || !configured()) return { configured: false, subscriptions: 0 };
  if (!monitor.channelId) return connect();
  await subscribeQueueTopics(await listGenesysWidgetVoiceQueueIds());
  return { configured: true, subscriptions: monitor.topics.size };
}

export async function startGenesysWidgetVoiceNotifications() {
  const monitor = state();
  monitor.stopped = false;
  if (!configured()) return { configured: false, subscriptions: 0 };
  if (!monitor.refreshTimer) {
    monitor.refreshTimer = setInterval(() => {
      void refreshGenesysWidgetVoiceSubscriptions().catch((error) => {
        console.error("[genesys-widget-voice-notifications] subscription refresh failed:", error.message);
      });
    }, 60_000);
    monitor.refreshTimer.unref?.();
  }
  return connect();
}

export async function stopGenesysWidgetVoiceNotifications() {
  const monitor = state();
  monitor.stopped = true;
  if (monitor.reconnectTimer) clearTimeout(monitor.reconnectTimer);
  if (monitor.refreshTimer) clearInterval(monitor.refreshTimer);
  monitor.reconnectTimer = null;
  monitor.refreshTimer = null;
  const socket = monitor.socket;
  monitor.socket = null;
  monitor.channelId = null;
  monitor.notificationsApi = null;
  monitor.topics.clear();
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "server shutdown");
}
