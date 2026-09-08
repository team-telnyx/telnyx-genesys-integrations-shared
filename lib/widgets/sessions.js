import { randomUUID } from "node:crypto";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { parseWidgetConfigIfCurrent } from "./config.js";
import { createOpaqueSessionToken, hashSessionToken } from "./session-tokens.js";

function expiryDate(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function normalizedSession(row) {
  if (!row) return null;
  const config = parseWidgetConfigIfCurrent(row.config);
  return config ? { ...row, config } : null;
}

export async function createWidgetSession({ widget, channel, origin }) {
  const sessionToken = createOpaqueSessionToken();
  const id = randomUUID();
  const expiresAt = expiryDate(widget.config.behavior.inactivityMinutes);
  await getPostgresPool().query(
    `INSERT INTO widget_sessions
      (id, widget_id, revision_id, channel, status, origin, expires_at, session_token_hash)
     VALUES ($1,$2,$3,$4,'initializing',$5,$6,$7)`,
    [
      id,
      widget.id,
      widget.revision_id,
      channel,
      origin,
      expiresAt,
      hashSessionToken(sessionToken),
    ]
  );
  return { id, sessionToken, expiresAt };
}

export async function activateMessagingSession(id, telnyxConversationId) {
  const result = await getPostgresPool().query(
    `UPDATE widget_sessions
     SET status='active', telnyx_conversation_id=$2, updated_at=NOW(), last_seen_at=NOW()
     WHERE id=$1
     RETURNING id, channel, status, expires_at, created_at`,
    [id, telnyxConversationId]
  );
  return result.rows[0] || null;
}

export async function activateVoiceSession(id) {
  const result = await getPostgresPool().query(
    `UPDATE widget_sessions
     SET status='active', updated_at=NOW(), last_seen_at=NOW()
     WHERE id=$1 AND channel='voice'
     RETURNING id, channel, status, expires_at, created_at`,
    [id]
  );
  return result.rows[0] || null;
}

export async function updateVoiceSessionState(session, { status, telnyxCallId }) {
  const result = await getPostgresPool().query(
    `UPDATE widget_sessions
     SET status=CASE
           WHEN status IN ('completed', 'failed') THEN status
           ELSE $2
         END,
         telnyx_call_id=COALESCE($3, telnyx_call_id),
         last_seen_at=NOW(),
         updated_at=NOW()
     WHERE id=$1 AND channel='voice'
     RETURNING id, channel, status, telnyx_call_id, expires_at`,
    [session.id, status, telnyxCallId || null]
  );
  return result.rows[0] || null;
}

export async function failWidgetSession(id) {
  await getPostgresPool().query(
    "UPDATE widget_sessions SET status='failed', updated_at=NOW() WHERE id=$1",
    [id]
  );
}

export async function getWidgetSessionByToken(token) {
  if (!token || !String(token).startsWith("wss_")) return null;
  const result = await getPostgresPool().query(
    `SELECT s.*, w.public_id, w.enabled AS widget_enabled, r.config
     FROM widget_sessions s
     JOIN widgets w ON w.id=s.widget_id
     JOIN widget_revisions r ON r.id=s.revision_id
     WHERE s.session_token_hash=$1
       AND s.status='active'
       AND s.expires_at > NOW()
       AND w.enabled=TRUE
     LIMIT 1`,
    [hashSessionToken(token)]
  );
  return normalizedSession(result.rows[0]);
}

export async function getWidgetVoiceSessionByToken(token) {
  if (!token || !String(token).startsWith("wss_")) return null;
  const result = await getPostgresPool().query(
    `SELECT s.*, w.public_id, w.enabled AS widget_enabled, r.config
     FROM widget_sessions s
     JOIN widgets w ON w.id=s.widget_id
     JOIN widget_revisions r ON r.id=s.revision_id
     WHERE s.session_token_hash=$1
       AND s.channel='voice'
       AND s.status IN ('active','completed','failed')
       AND s.expires_at > NOW()
       AND w.enabled=TRUE
     LIMIT 1`,
    [hashSessionToken(token)]
  );
  return normalizedSession(result.rows[0]);
}

export async function touchWidgetSession(session) {
  const minutes = session.config.behavior.inactivityMinutes;
  const result = await getPostgresPool().query(
    `UPDATE widget_sessions
     SET last_seen_at=NOW(), updated_at=NOW(), expires_at=$2
     WHERE id=$1 AND status='active'
     RETURNING expires_at`,
    [session.id, expiryDate(minutes)]
  );
  return result.rows[0]?.expires_at || null;
}
