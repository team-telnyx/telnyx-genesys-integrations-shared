import { getPostgresPool } from '../postgres.mjs';
import { defaultRoomsClient } from './rooms.mjs';
import { createVideoService } from './service.mjs';

export async function processVideoWebhook(event, { pool = getPostgresPool(), rooms = defaultRoomsClient(), end = (id) => createVideoService({ pool, rooms }).end(id, 'room_ended') } = {}) {
  const data = event?.data || event;
  const payload = data?.payload;
  const type = data?.event_type;
  if (!data?.id || !payload || !String(type).startsWith('video.room.')) return { matched: false };
  const db = await pool.connect();
  let id, ended = false;
  try {
    await db.query('BEGIN');
    const row = (await db.query('SELECT * FROM widget_video_sessions WHERE room_id=$1 OR composition_id=$2 FOR UPDATE', [payload.room_id || null, payload.composition_id || null])).rows[0];
    if (!row) { await db.query('COMMIT'); return { matched: false }; }
    id = row.session_id;
    const claim = await db.query(`INSERT INTO widget_webhook_events(source,event_id,event_type,expires_at) VALUES('telnyx-video',$1,$2,NOW()+interval '7 days') ON CONFLICT DO NOTHING RETURNING event_id`, [data.id, type]);
    if (!claim.rowCount) { await db.query('COMMIT'); return { matched: true, duplicate: true }; }
    if (payload.session_id) await db.query('UPDATE widget_video_sessions SET room_session_id=$2 WHERE session_id=$1', [id, payload.session_id]);
    if (type === 'video.room.recording.started' || type === 'video.room.recording.completed') {
      const recordings = row.recordings || [];
      const existing = recordings.find((item) => item.recording_id === payload.recording_id);
      // Late started events must not reverse a completed recording.
      const item = { ...existing, recording_id: payload.recording_id, type: payload.type || existing?.type,
        participant_id: payload.participant_id || existing?.participant_id,
        status: existing?.status === 'completed' || type.endsWith('.completed') ? 'completed' : 'started' };
      if (item.recording_id) await db.query('UPDATE widget_video_sessions SET recordings=$2::jsonb WHERE session_id=$1', [id, JSON.stringify([...recordings.filter((old) => old.recording_id !== item.recording_id), item])]);
    }
    if (type === 'video.room.session.ended') {
      ended = true;
      await db.query("UPDATE widget_video_sessions SET ended_at=COALESCE(ended_at,NOW()),state='ending',cleanup_pending=TRUE WHERE session_id=$1", [id]);
    }
    if (type === 'video.room.composition.completed') await db.query("UPDATE widget_video_sessions SET composition_state='completed' WHERE session_id=$1", [id]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
  if (ended) await end(id);
  await composeVideoRecording(id, { pool, rooms });
  return { matched: true };
}

export async function composeVideoRecording(id, { pool = getPostgresPool(), rooms = defaultRoomsClient() } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const row = (await db.query('SELECT * FROM widget_video_sessions WHERE session_id=$1 FOR UPDATE', [id])).rows[0];
    const recordings = row?.recordings || [];
    if (!row?.recording_enabled || !row.ended_at || row.composition_id || !recordings.length || recordings.some((item) => item.status !== 'completed')) { await db.query('COMMIT'); return; }
    const videos = recordings.filter((item) => item.type === 'video');
    if (!videos.length) {
      await db.query("UPDATE widget_video_sessions SET composition_state='audio_only' WHERE session_id=$1", [id]);
    } else {
      const composition = await rooms.createComposition({ sessionId: row.room_session_id, layout: row.recording_layout,
        main: videos[0].recording_id, secondary: videos[1]?.recording_id,
        webhookUrl: `${String(process.env.GC_PUBLIC_BASE_URL || '').replace(/\/$/, '')}/api/webhooks/telnyx/video` });
      await db.query('UPDATE widget_video_sessions SET composition_id=$2,composition_state=$3 WHERE session_id=$1', [id, composition.id, composition.status || 'enqueued']);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
