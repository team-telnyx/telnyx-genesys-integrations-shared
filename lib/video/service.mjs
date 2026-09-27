import { createHash } from 'node:crypto';
import { getPostgresPool } from '../postgres.mjs';
import { defaultRoomsClient } from './rooms.mjs';
import { getConversationsApi, getRoutingApi } from '../genesys/client.js';
import { disconnectVideoConversation, videoConversationState, videoError, videoInboundMessage } from '../genesys/video-conversation.mjs';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const terminal = (row) => ['ending', 'ended', 'failed'].includes(row.state);
const pendingConversation = (row) => !row.agent_joined_at && Date.now() - new Date(row.created_at).getTime() < 60_000;

// Every mutation of one room is serialized across application instances.
export function createVideoService({ pool = getPostgresPool(), rooms = defaultRoomsClient(), conversations = getConversationsApi, routing = getRoutingApi } = {}) {
  async function locked(id, operation) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT * FROM widget_video_sessions WHERE session_id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw videoError('Video session not found', 404);
      const result = await operation(db, row);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  const read = async (id) => (await pool.query('SELECT * FROM widget_video_sessions WHERE session_id=$1', [id])).rows[0];
  const byConversation = async (id) => (await pool.query('SELECT v.*, s.widget_id FROM widget_video_sessions v JOIN widget_sessions s ON s.id=v.session_id WHERE genesys_conversation_id=$1', [id])).rows[0];
  function serialize(row) {
    return { handoff: {
      status: terminal(row) ? 'disconnected' : row.state,
      queueName: row.queue_name, agentName: row.agent_name,
      requestedAt: row.created_at, connectedAt: row.agent_joined_at, disconnectedAt: row.ended_at,
    }, recording: row.recording_enabled, roomId: row.room_id };
  }
  async function start({ sessionId, config, customerName }) {
    const video = config.channels.video;
    if (!video?.genesys?.queueId || !video.genesys.integrationId) throw videoError('Publish the video channel before starting a call', 503);
    const queue = await (await routing()).getRoutingQueue(video.genesys.queueId);
    if (queue.id !== video.genesys.queueId) throw videoError('Genesys video queue is unavailable', 503);
    await pool.query(`INSERT INTO widget_video_sessions(session_id,genesys_integration_id,queue_id,queue_name,recording_enabled,recording_layout)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id) DO NOTHING`,
    [sessionId, video.genesys.integrationId, queue.id, queue.name, video.recording.enabled, video.recording.layout]);
    try {
      // Persist the room before contacting Genesys so a failed handoff can be cleaned up.
      await locked(sessionId, async (db, row) => {
        if (terminal(row)) throw videoError("Video session has ended", 409);
        if (row.room_id) return;
        const base = String(process.env.GC_PUBLIC_BASE_URL || '').replace(/\/$/, '');
        if (!/^https:\/\//.test(base)) throw videoError('Public video webhook URL is not configured', 503);
        const room = await rooms.createRoom({ uniqueName: `genesys-video-${sessionId}`, maxParticipants: 4,
          enableRecording: video.recording.enabled, webhookUrl: `${base}/api/webhooks/telnyx/video` });
        try { await db.query('UPDATE widget_video_sessions SET room_id=$2 WHERE session_id=$1', [sessionId, room.id]); }
        catch (error) { await rooms.deleteRoom(room.id).catch(() => undefined); throw error; }
      });
      await locked(sessionId, async (db, row) => {
        if (terminal(row)) throw videoError("Video session has ended", 409);
        if (row.genesys_conversation_id) return;
        const result = await (await conversations()).postConversationsMessageInboundOpenMessage(row.genesys_integration_id,
          videoInboundMessage({ sessionId, queueId: queue.id, queueName: queue.name, customerName }), { prefetchConversationId: true });
        if (!result?.conversationId) throw videoError('Genesys did not return a conversation ID', 502);
        await db.query("UPDATE widget_video_sessions SET genesys_conversation_id=$2,state='waiting',updated_at=NOW() WHERE session_id=$1", [sessionId, result.conversationId]);
        await db.query("UPDATE widget_sessions SET status='active',expires_at=NOW()+interval '2 minutes' WHERE id=$1", [sessionId]);
      });
      return serialize(await read(sessionId));
    } catch (error) {
      await end(sessionId, 'start_failed').catch(() => undefined);
      throw error;
    }
  }
  async function end(id, reason = 'ended') {
    // Commit the terminal state before remote calls. Failed cleanup remains visible to the sweep.
    await locked(id, async (db, row) => {
      if (row.state === 'ended' && !row.cleanup_pending) return;
      await db.query("UPDATE widget_video_sessions SET state='ending',cleanup_pending=TRUE,ended_at=COALESCE(ended_at,NOW()),last_error=$2 WHERE session_id=$1", [id, reason]);
    });
    return locked(id, async (db, row) => {
      if (row.state === 'ended' && !row.cleanup_pending) return serialize(row);
      const errors = [];
      if (row.genesys_conversation_id) {
        try { await disconnectVideoConversation(await conversations(), row.genesys_conversation_id); }
        catch (error) {
          // A prefetched ID can precede the actual conversation. Retry an early
          // cancellation so a queued interaction cannot appear after we leave.
          const status = Number(error.status);
          if (![404, 410].includes(status) || (status === 404 && pendingConversation(row))) errors.push('Genesys disconnect pending');
        }
      }
      if (row.room_id) {
        try {
          const sessions = await rooms.listSessions(row.room_id);
          for (const session of sessions) if (session.active) await rooms.endSession(session.id);
          await rooms.deleteRoom(row.room_id);
        } catch (error) { if (error.providerStatus !== 404) errors.push('Telnyx room cleanup failed'); }
      }
      const result = (await db.query(`UPDATE widget_video_sessions SET state='ended',cleanup_pending=$2,last_error=$3,updated_at=NOW() WHERE session_id=$1 RETURNING *`, [id, errors.length > 0, errors.join('; ') || null])).rows[0];
      await db.query("UPDATE widget_sessions SET status='completed',expires_at=GREATEST(expires_at,NOW()+interval '1 day') WHERE id=$1", [id]);
      await db.query('DELETE FROM widget_video_tokens WHERE session_id=$1', [id]);
      return serialize(result);
    });
  }
  async function state(id, { touch = false } = {}) {
    let row = await read(id);
    if (!row) throw videoError('Video session not found', 404);
    if (!terminal(row) && row.genesys_conversation_id) {
      let conversation;
      try { conversation = await (await conversations()).getConversation(row.genesys_conversation_id); }
      catch (error) {
        if (Number(error.status) !== 404) throw error;
        if (!pendingConversation(row)) return end(id, 'genesys_conversation_missing');
        if (touch) await pool.query("UPDATE widget_sessions SET last_seen_at=NOW(),expires_at=NOW()+interval '2 minutes' WHERE id=$1 AND status='active'", [id]);
        return serialize(row);
      }
      const presence = videoConversationState(conversation);
      if (presence.status === 'disconnected') return end(id, 'genesys_disconnected');
      // A participant token cannot be revoked individually. End the room when
      // an accepted agent leaves the assignment, including a Genesys transfer.
      if (row.agent_joined_at && row.agent_user_id !== (presence.agent?.userId || null)) return end(id, 'agent_assignment_changed');
      row = await locked(id, async (db, current) => {
        if (terminal(current)) return current;
        const sameAgent = current.agent_user_id === presence.agent?.userId;
        const status = presence.status === 'connected' && !(sameAgent && current.agent_joined_at) ? 'assigned' : presence.status;
        return (await db.query(`UPDATE widget_video_sessions SET state=$2,agent_user_id=$3,agent_name=$4,
          agent_joined_at=CASE WHEN agent_user_id IS NOT DISTINCT FROM $3 THEN agent_joined_at ELSE NULL END,updated_at=NOW()
          WHERE session_id=$1 RETURNING *`, [id, status, presence.agent?.userId || null, presence.agent?.name || null])).rows[0];
      });
    }
    if (touch && !terminal(row)) await pool.query("UPDATE widget_sessions SET last_seen_at=NOW(),expires_at=NOW()+interval '2 minutes' WHERE id=$1 AND status='active'", [id]);
    return serialize(row);
  }
  async function join(id, { owner = 'customer', refreshToken, agent } = {}) {
    return locked(id, async (db, row) => {
      if (terminal(row) || !row.room_id) throw videoError('Video session has ended', 409);
      let token;
      if (refreshToken) {
        const valid = (await db.query('SELECT token_hash FROM widget_video_tokens WHERE token_hash=$1 AND session_id=$2 AND owner=$3 AND expires_at>NOW()', [hash(refreshToken), id, owner])).rows[0];
        if (!valid) throw videoError('Invalid video refresh token', 403);
        token = await rooms.refreshJoinToken(row.room_id, refreshToken);
      } else {
        token = await rooms.generateJoinToken(row.room_id);
      }
      await db.query(`INSERT INTO widget_video_tokens(token_hash,session_id,owner,expires_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(token_hash) DO NOTHING`, [hash(token.refreshToken), id, owner, token.refreshExpiresAt || new Date(Date.now() + 3600_000)]);
      if (agent) await db.query("UPDATE widget_video_sessions SET state='connected',agent_user_id=$2,agent_name=$3,agent_joined_at=COALESCE(agent_joined_at,NOW()),updated_at=NOW() WHERE session_id=$1", [id, agent.id, agent.name]);
      return { join: { ...token, roomId: row.room_id }, ...serialize({ ...row, ...(agent ? { state: 'connected', agent_name: agent.name } : {}) }) };
    });
  }
  async function sweep() {
    const stale = (await pool.query(`SELECT v.session_id FROM widget_video_sessions v JOIN widget_sessions s ON s.id=v.session_id JOIN widgets w ON w.id=s.widget_id
      WHERE v.cleanup_pending OR (v.state NOT IN ('ended','failed') AND (s.expires_at<=NOW() OR NOT w.enabled OR s.status='failed')) LIMIT 50`)).rows;
    for (const row of stale) await end(row.session_id, 'expired').catch((error) => console.warn('[video-cleanup]', error.message));
    const { composeVideoRecording } = await import('./webhooks.mjs');
    const pending = (await pool.query("SELECT session_id FROM widget_video_sessions WHERE recording_enabled AND ended_at IS NOT NULL AND composition_id IS NULL AND composition_state IS DISTINCT FROM 'audio_only' LIMIT 50")).rows;
    for (const row of pending) await composeVideoRecording(row.session_id, { pool, rooms }).catch((error) => console.warn('[video-recording]', error.message));
  }
  return { start, read, byConversation, state, join, end, sweep, serialize };
}
