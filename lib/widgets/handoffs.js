import { randomUUID } from "node:crypto";
import { agentAttachmentDownloadPath } from "./session-attachments.js";
import { getPostgresPool } from "../postgres.mjs";
import { widgetGenesysQueues } from "./config.js";

function retentionHours() {
  const parsed = Number(process.env.WIDGET_HANDOFF_RETENTION_HOURS || 24);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 168) {
    throw new Error("WIDGET_HANDOFF_RETENTION_HOURS must be an integer between 1 and 168");
  }
  return parsed;
}

function expiresAt() {
  return new Date(Date.now() + retentionHours() * 60 * 60 * 1000);
}

function publicHandoff(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    queueId: row.queue_id,
    queueName: row.queue_name,
    agentName: row.agent_name,
    // The public runtime only needs lifecycle evidence, not the Genesys user
    // identifier itself. These flags prevent a terminal customer event from
    // being rendered as agent assignment, connection and disconnection.
    agentAssigned: Boolean(row.agent_user_id || row.agent_name || row.claimed_at),
    agentConnected: Boolean(row.claimed_at),
    reason: row.reason,
    summary: row.summary,
    intent: row.intent,
    sentiment: row.sentiment,
    genesysConversationId: row.genesys_conversation_id,
    agentTypingUntil: row.agent_typing_until || null,
    error: row.status === "failed" ? row.error : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function reserveMessagingHandoff({
  sessionId,
  queueId,
  queueName,
  reason,
  summary,
  intent,
  sentiment,
}) {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query(
      `SELECT s.*, w.public_id, w.enabled AS widget_enabled, r.config
       FROM widget_sessions s
       JOIN widgets w ON w.id=s.widget_id
       JOIN widget_revisions r ON r.id=s.revision_id
       WHERE s.id=$1 FOR UPDATE OF s`,
      [sessionId]
    );
    const session = sessionResult.rows[0];
    if (
      !session ||
      !session.widget_enabled ||
      session.channel !== "messaging" ||
      session.status !== "active" ||
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      throw new Error("Widget messaging session is not active");
    }

    const existingResult = await client.query(
      "SELECT * FROM genesys_widget_handoffs WHERE session_id=$1 FOR UPDATE",
      [sessionId]
    );
    if (existingResult.rowCount) {
      await client.query("COMMIT");
      return { session, handoff: existingResult.rows[0], created: false };
    }

    const genesys = session.config.channels.messaging.genesys;
    const allowedQueues = widgetGenesysQueues(session.config);
    if (!genesys.integrationId || !allowedQueues.length) {
      throw new Error("Widget Genesys Open Messaging configuration is incomplete");
    }
    // The assistant tool selects a queue by name from the deployment allowlist and
    // may omit it entirely, in which case the widget's configured default applies.
    const requestedId = String(queueId || "").trim();
    const requestedName = String(queueName || "").trim();
    const byId = requestedId
      ? allowedQueues.find((queue) => queue.id === requestedId)
      : null;
    if (requestedId && !byId) {
      throw new Error(`Genesys queue ${requestedId} is not allowed for this widget`);
    }
    const byName = requestedName
      ? allowedQueues.find((queue) => queue.name.toLowerCase() === requestedName.toLowerCase())
      : null;
    if (requestedName && !byName) {
      throw new Error(`Genesys queue ${requestedName} is not allowed for this widget`);
    }
    if (byId && byName && byId.id !== byName.id) {
      throw new Error("Selected Genesys queue name does not match its allowed immutable ID");
    }
    const defaultQueue = allowedQueues.find((queue) => queue.id === genesys.queueId)
      || (allowedQueues.length === 1 ? allowedQueues[0] : null);
    const selectedQueue = byId || byName || defaultQueue;
    if (!selectedQueue) {
      throw new Error("No Genesys queue was selected and this widget has no default queue");
    }
    const id = randomUUID();
    const handoffResult = await client.query(
      `INSERT INTO genesys_widget_handoffs
        (id, session_id, channel, status, genesys_integration_id, genesys_remote_address,
         queue_id, queue_name, reason, summary, intent, sentiment, expires_at)
       VALUES ($1,$2,'messaging','reserved',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        id,
        sessionId,
        genesys.integrationId,
        `telnyx-widget:${id}`,
        selectedQueue.id,
        selectedQueue.name,
        reason,
        summary,
        intent || null,
        sentiment || null,
        expiresAt(),
      ]
    );
    await client.query("COMMIT");
    return { session, handoff: handoffResult.rows[0], created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function activateMessagingHandoff({ handoffId, genesysConversationId, queueName }) {
  const result = await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs
     SET status='waiting', genesys_conversation_id=$2, queue_name=COALESCE($3,queue_name),
       error=NULL, updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [handoffId, genesysConversationId, queueName || null]
  );
  return result.rows[0] || null;
}

export async function failMessagingHandoff(handoffId, error) {
  const result = await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs
     SET status='failed', error=$2, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [handoffId, String(error || "Handoff failed").slice(0, 1000)]
  );
  return result.rows[0] || null;
}

export async function markMessagingHandoffConnected(
  handoffId,
  agentName = null,
  { agentUserId = null, agentImageUri = null } = {}
) {
  await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs SET status='connected', claimed_at=COALESCE(claimed_at,NOW()),
       agent_name=COALESCE($2,agent_name),
       agent_user_id=COALESCE($3,agent_user_id),
       agent_image_uri=COALESCE($4,agent_image_uri), updated_at=NOW()
     WHERE id=$1 AND status IN ('reserved','waiting','assigned','connected')`,
    [
      handoffId,
      agentName ? String(agentName).slice(0, 200) : null,
      agentUserId ? String(agentUserId).slice(0, 200) : null,
      agentImageUri ? String(agentImageUri).slice(0, 2000) : null,
    ]
  );
}

export async function markMessagingHandoffAgentTyping(handoffId, durationMs = 5000) {
  const duration = Math.max(1000, Math.min(15_000, Math.round(Number(durationMs) || 5000)));
  const result = await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs
     SET agent_typing_until=GREATEST(
       COALESCE(agent_typing_until, NOW()),
       NOW() + ($2 * INTERVAL '1 millisecond')
     ), updated_at=NOW()
     WHERE id=$1 AND channel='messaging' AND status IN ('assigned','connected')
     RETURNING agent_typing_until`,
    [handoffId, duration]
  );
  return result.rows[0]?.agent_typing_until || null;
}

export async function clearMessagingHandoffAgentTyping(handoffId) {
  await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs
     SET agent_typing_until=NULL, updated_at=NOW()
     WHERE id=$1 AND channel='messaging'`,
    [handoffId]
  );
}

// Genesys typing events last five seconds and may be refreshed while the user
// keeps composing. Claiming one notification per two seconds prevents a custom
// client from turning this lightweight UI signal into an API flood.
export async function claimMessagingCustomerTyping(handoffId) {
  const result = await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs
     SET customer_typing_sent_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND channel='messaging' AND status='connected'
       AND (customer_typing_sent_at IS NULL OR customer_typing_sent_at < NOW() - INTERVAL '2 seconds')
     RETURNING *`,
    [handoffId]
  );
  return result.rows[0] || null;
}

// Genesys offers the interaction to an agent before they accept it. That step has
// no Open Messaging webhook, so it only becomes visible by reading the
// conversation's participants.
export async function markMessagingHandoffAssigned(
  handoffId,
  agentName = null,
  { agentUserId = null, agentImageUri = null } = {}
) {
  await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs SET status='assigned',
       agent_name=COALESCE($2,agent_name),
       agent_user_id=COALESCE($3,agent_user_id),
       agent_image_uri=COALESCE($4,agent_image_uri), updated_at=NOW()
     WHERE id=$1 AND status IN ('reserved','waiting')`,
    [
      handoffId,
      agentName ? String(agentName).slice(0, 200) : null,
      agentUserId ? String(agentUserId).slice(0, 200) : null,
      agentImageUri ? String(agentImageUri).slice(0, 2000) : null,
    ]
  );
}

// The agent leaving ends the conversation for the customer: Genesys has torn the
// interaction down, so nothing more can be delivered to it.
export async function markMessagingHandoffDisconnected(handoffId, agentName = null) {
  const result = await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs SET status='disconnected',
       agent_name=COALESCE($2,agent_name), agent_typing_until=NULL, updated_at=NOW()
     WHERE id=$1 AND status IN ('assigned','connected')
     RETURNING *`,
    [handoffId, agentName ? String(agentName).slice(0, 200) : null]
  );
  return result.rows[0] || null;
}

// Every browser poll would otherwise hit the Genesys conversation API, so the
// lookup is claimed at most once per interval across all callers.
export async function claimHandoffAgentLookup(handoffId, minimumIntervalSeconds = 5) {
  const result = await getPostgresPool().query(
    `UPDATE genesys_widget_handoffs SET agent_polled_at=NOW()
     WHERE id=$1 AND status IN ('waiting','assigned','connected')
       AND genesys_conversation_id IS NOT NULL
       AND (agent_polled_at IS NULL OR agent_polled_at < NOW() - ($2 || ' seconds')::interval)
     RETURNING id`,
    [handoffId, String(Math.max(1, Math.floor(minimumIntervalSeconds)))]
  );
  return result.rowCount > 0;
}

export async function getMessagingHandoffBySession(sessionId) {
  const result = await getPostgresPool().query(
    `SELECT * FROM genesys_widget_handoffs
     WHERE session_id=$1 AND channel='messaging' AND expires_at > NOW() LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

export async function upsertVoiceHandoffFromNotification({
  sessionId = null,
  telnyxCallId = null,
  status,
  genesysConversationId,
  queueId = null,
  queueName = null,
  agentName = null,
  agentUserId = null,
  pool = getPostgresPool(),
}) {
  if (!["waiting", "assigned", "connected", "disconnected"].includes(status)) {
    throw new Error(`Unsupported Genesys voice handoff status ${status}`);
  }
  if (!sessionId && !telnyxCallId) {
    throw new Error("A widget session ID or Telnyx call control ID is required");
  }
  const result = await pool.query(
    `WITH selected_session AS (
       SELECT s.id,s.expires_at
       FROM widget_sessions s
       JOIN widgets w ON w.id=s.widget_id
       WHERE s.channel='voice' AND s.status IN ('active','completed')
         AND s.expires_at > NOW() AND w.enabled=TRUE
         AND (($8::uuid IS NOT NULL AND s.id=$8::uuid)
           OR ($8::uuid IS NULL AND $9::text IS NOT NULL AND s.telnyx_call_id=$9::text))
       ORDER BY s.created_at DESC
       LIMIT 1
     )
     INSERT INTO genesys_widget_handoffs
       (id,session_id,channel,status,genesys_conversation_id,queue_id,queue_name,
        agent_name,agent_user_id,claimed_at,expires_at)
     SELECT $1,s.id,'voice',$2,$3,$4,$5,$6,$7,
       CASE WHEN $2='connected' THEN NOW() ELSE NULL END,
       s.expires_at
     FROM selected_session s
     ON CONFLICT (session_id) DO UPDATE SET
       status=CASE
         WHEN genesys_widget_handoffs.status IN ('failed','disconnected','completed')
           THEN genesys_widget_handoffs.status
         WHEN EXCLUDED.status='disconnected' THEN 'disconnected'
         WHEN genesys_widget_handoffs.status='connected' THEN 'connected'
         WHEN EXCLUDED.status='connected' THEN 'connected'
         WHEN genesys_widget_handoffs.status='assigned' THEN 'assigned'
         WHEN EXCLUDED.status='assigned' THEN 'assigned'
         ELSE 'waiting'
       END,
       genesys_conversation_id=EXCLUDED.genesys_conversation_id,
       queue_id=COALESCE(EXCLUDED.queue_id,genesys_widget_handoffs.queue_id),
       queue_name=COALESCE(EXCLUDED.queue_name,genesys_widget_handoffs.queue_name),
       agent_name=COALESCE(EXCLUDED.agent_name,genesys_widget_handoffs.agent_name),
       agent_user_id=COALESCE(EXCLUDED.agent_user_id,genesys_widget_handoffs.agent_user_id),
       claimed_at=CASE
         WHEN EXCLUDED.status='connected' THEN COALESCE(genesys_widget_handoffs.claimed_at,NOW())
         ELSE genesys_widget_handoffs.claimed_at
       END,
       updated_at=NOW()
     RETURNING *`,
    [
      randomUUID(),
      status,
      genesysConversationId,
      queueId,
      queueName,
      agentName ? String(agentName).slice(0, 200) : null,
      agentUserId ? String(agentUserId).slice(0, 200) : null,
      sessionId,
      telnyxCallId ? String(telnyxCallId).slice(0, 200) : null,
    ]
  );
  return result.rows[0] || null;
}

export async function getVoiceHandoffBySession(sessionId) {
  const result = await getPostgresPool().query(
    `SELECT * FROM genesys_widget_handoffs
     WHERE session_id=$1 AND channel='voice' AND expires_at > NOW() LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

export async function findMessagingHandoffByAddress({ integrationId, remoteAddress }) {
  const result = await getPostgresPool().query(
    `SELECT * FROM genesys_widget_handoffs
     WHERE genesys_integration_id=$1 AND genesys_remote_address=$2
       AND channel='messaging' AND expires_at > NOW()
     LIMIT 1`,
    [integrationId, remoteAddress]
  );
  return result.rows[0] || null;
}

export async function claimWidgetWebhookEvent({ source, eventId, eventType }) {
  const result = await getPostgresPool().query(
    `INSERT INTO widget_webhook_events(source,event_id,event_type,expires_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,
    [source, eventId, eventType || null, expiresAt()]
  );
  return result.rowCount === 1;
}

export async function storeHandoffMessage({
  handoffId,
  providerMessageId,
  direction,
  sender,
  senderName = null,
  senderImageUri = null,
  messageType = "Text",
  text = null,
  attachments = [],
  createdAt = new Date(),
}) {
  const result = await getPostgresPool().query(
    `INSERT INTO widget_handoff_messages
      (id,handoff_id,provider_message_id,direction,sender,sender_name,sender_image_uri,message_type,text,attachments,created_at,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     ON CONFLICT (handoff_id,provider_message_id) DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      handoffId,
      providerMessageId,
      direction,
      sender,
      senderName ? String(senderName).slice(0, 200) : null,
      senderImageUri ? String(senderImageUri).slice(0, 2000) : null,
      messageType,
      text,
      JSON.stringify(attachments),
      createdAt,
      expiresAt(),
    ]
  );
  return result.rows[0] || null;
}

// Agent attachments live on Genesys hosts that force a download, so the customer
// only ever receives a signed link to this application's own proxy for them.
function serializedAttachments(row, sessionId) {
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  if (row.sender !== "agent" || !sessionId) return attachments;
  return attachments.map((attachment, index) => ({
    ...attachment,
    // The expiry is stored with the message, so every poll produces the exact
    // same media URL. Changing an <audio src> while it is playing reloads it.
    url: attachment.url
      ? agentAttachmentDownloadPath(sessionId, row.id, index, { expiresAt: row.expires_at })
      : null,
  }));
}

export async function listHandoffMessages(handoffId, after = null, sessionId = null) {
  const result = await getPostgresPool().query(
    `SELECT m.*, h.agent_image_uri AS handoff_agent_image_uri
     FROM widget_handoff_messages m
     JOIN genesys_widget_handoffs h ON h.id=m.handoff_id
     WHERE m.handoff_id=$1 AND ($2::timestamptz IS NULL OR m.created_at > $2)
     ORDER BY m.created_at, m.id LIMIT 200`,
    [handoffId, after]
  );
  return result.rows.map((row) => ({
    id: row.provider_message_id,
    role: row.sender === "customer" ? "user" : row.sender === "agent" ? "human" : "system",
    agentName: row.sender_name || null,
    agentAvatarId: row.sender_image_uri || row.handoff_agent_image_uri ? row.id : null,
    content: row.text || "",
    type: row.message_type,
    attachments: serializedAttachments(row, sessionId),
    createdAt: row.created_at,
  }));
}

export async function getHandoffMessageAttachment({ sessionId, messageId, index }) {
  if (!Number.isInteger(index) || index < 0) return null;
  const result = await getPostgresPool().query(
    `SELECT m.attachments
     FROM widget_handoff_messages m
     JOIN genesys_widget_handoffs h ON h.id=m.handoff_id
     WHERE h.session_id=$1 AND m.id::text=$2 AND m.sender='agent'
       AND h.expires_at > NOW() AND m.expires_at > NOW()
     LIMIT 1`,
    [sessionId, messageId]
  );
  const attachments = result.rows[0]?.attachments;
  return Array.isArray(attachments) ? attachments[index] || null : null;
}

export async function getHandoffMessageProfileImage({ sessionId, messageId }) {
  const result = await getPostgresPool().query(
    `SELECT COALESCE(m.sender_image_uri,h.agent_image_uri) AS sender_image_uri
     FROM widget_handoff_messages m
     JOIN genesys_widget_handoffs h ON h.id=m.handoff_id
     WHERE h.session_id=$1 AND m.id::text=$2 AND m.sender='agent'
       AND h.expires_at > NOW() AND m.expires_at > NOW()
     LIMIT 1`,
    [sessionId, messageId]
  );
  return result.rows[0]?.sender_image_uri || null;
}

export function serializeMessagingHandoff(row) {
  return publicHandoff(row);
}

export function serializeVoiceHandoff(row) {
  return publicHandoff(row);
}
