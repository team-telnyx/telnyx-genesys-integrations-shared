import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createVideoService } from '../lib/video/service.mjs';
import { processVideoWebhook } from '../lib/video/webhooks.mjs';
import { DEFAULT_WIDGET_CONFIG } from '../lib/widgets/config.js';

// Requires an explicitly selected disposable PostgreSQL database.
test('video service: concurrent starts, token ownership, assignment, cleanup retries and webhook ordering', { skip: !process.env.VIDEO_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.VIDEO_TEST_DATABASE_URL;
  process.env.GC_PUBLIC_BASE_URL = 'https://video-test.example.com';
  const { ensurePostgresSchema } = await import('../lib/postgres-schema.mjs');
  const { getPostgresPool, closePostgresPool } = await import('../lib/postgres.mjs');
  await ensurePostgresSchema();
  const pool = getPostgresPool();
  const widgetId = randomUUID(), revisionId = randomUUID();
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  Object.assign(config.channels.video, { enabled: true, genesys: { queueId: 'queue', integrationId: 'integration' } });
  let creates = 0, inbound = 0, deletes = 0, disconnects = 0, failDelete = false;
  let conversation = { participants: [{ id: 'customer', purpose: 'customer', messages: [{ state: 'connected' }] }] }, conversationPending = false;
  const rooms = {
    createRoom: async () => ({ id: `room-${++creates}` }),
    generateJoinToken: async () => ({ token: 'join', refreshToken: randomUUID() }),
    refreshJoinToken: async (_, refreshToken) => ({ token: 'new-join', refreshToken }),
    listSessions: async () => [],
    deleteRoom: async () => { deletes++; if (failDelete) throw new Error('controlled unavailable'); },
    createComposition: async () => ({ id: 'composition', status: 'enqueued' }),
  };
  const conversations = async () => ({
    postConversationsMessageInboundOpenMessage: async () => ({ conversationId: `conversation-${++inbound}` }),
    getConversation: async () => { if (conversationPending) throw Object.assign(new Error('Conversation is materializing'), { status: 404 }); return conversation; },
    patchConversationsMessageParticipant: async (_id, participantId, { body }) => { disconnects++; assert.deepEqual(body, { state: 'disconnected' }); for (const participant of conversation.participants.filter(p => p.id === participantId)) participant.messages.forEach(message => { message.state = 'disconnected'; }); },
  });
  const service = createVideoService({ pool, rooms, conversations, routing: async () => ({ getRoutingQueue: async () => ({ id: 'queue', name: 'Video' }) }) });
  const session = async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO widget_sessions(id,widget_id,revision_id,channel,origin,expires_at) VALUES($1,$2,$3,'video','https://example.com',NOW()+interval '1 hour')", [id, widgetId, revisionId]);
    return id;
  };
  try {
    await pool.query('INSERT INTO widgets(id,public_id,name,normalized_name,installation_key) VALUES($1,$2,$2,$2,$2)', [widgetId, `video-test-${widgetId}`]);
    await pool.query("INSERT INTO widget_revisions(id,widget_id,version,state,config) VALUES($1,$2,1,'published',$3)", [revisionId, widgetId, config]);
    const id = await session();
    const starts = await Promise.all([service.start({ sessionId: id, config }), service.start({ sessionId: id, config })]);
    assert.equal(creates, 1); assert.equal(inbound, 1); assert.equal(starts[0].handoff.status, 'waiting');
    const joined = await service.join(id);
    assert.equal((await service.join(id, { refreshToken: joined.join.refreshToken })).join.token, 'new-join');
    await assert.rejects(service.join(id, { refreshToken: joined.join.refreshToken, owner: 'agent:other' }), { status: 403 });
    const second = await session(); await service.start({ sessionId: second, config });
    await assert.rejects(service.join(second, { refreshToken: joined.join.refreshToken }), { status: 403 });
    conversation = { participants: [{ id: 'agent-participant', purpose: 'agent', userId: 'agent', name: 'Agent', messages: [{ state: 'connected' }] }] };
    assert.equal((await service.state(id)).handoff.status, 'assigned');
    await service.join(id, { owner: 'agent:agent', agent: { id: 'agent', name: 'Agent' } });
    assert.equal((await service.state(id)).handoff.status, 'connected');
    failDelete = true;
    await service.end(id); assert.equal((await service.read(id)).cleanup_pending, true);
    await assert.rejects(service.join(id), { status: 409 });
    assert.equal((await pool.query('SELECT * FROM widget_video_tokens WHERE session_id=$1', [id])).rowCount, 0);
    failDelete = false; await service.end(id); assert.equal((await service.read(id)).cleanup_pending, false);
    const previousDeletes = deletes, previousDisconnects = disconnects;
    await service.end(id); assert.equal(deletes, previousDeletes); assert.equal(disconnects, previousDisconnects);
    const row = await service.read(second);
    const webhook = (suffix, type) => ({ data: { id: `${second}-${suffix}`, event_type: type, payload: { room_id: row.room_id, session_id: 'session', recording_id: 'recording', type: 'video' } } });
    const deps = { pool, rooms, end: (sessionId) => service.end(sessionId) };
    await processVideoWebhook(webhook('complete', 'video.room.recording.completed'), deps);
    await processVideoWebhook(webhook('start', 'video.room.recording.started'), deps);
    assert.equal((await service.read(second)).recordings[0].status, 'completed');
    assert.equal((await processVideoWebhook(webhook('complete', 'video.room.recording.completed'), deps)).duplicate, true);
    await processVideoWebhook(webhook('end', 'video.room.session.ended'), deps);
    assert.equal((await service.read(second)).composition_id, 'composition');
    conversation = { participants: [{ id: 'agent-participant', purpose: 'agent', userId: 'agent', messages: [{ state: 'connected' }] }] };
    const transferred = await session(); await service.start({ sessionId: transferred, config });
    await service.join(transferred, { owner: 'agent:agent', agent: { id: 'agent', name: 'Agent' } });
    conversation = { participants: [{ id: 'next-agent-participant', purpose: 'agent', userId: 'next-agent', messages: [{ state: 'connected' }] }] };
    assert.equal((await service.state(transferred)).handoff.status, 'disconnected');
    await assert.rejects(service.join(transferred), { status: 409 });
    const stale = await session(); await service.start({ sessionId: stale, config });
    await pool.query("UPDATE widget_sessions SET expires_at=NOW()-interval '1 minute' WHERE id=$1", [stale]);
    await service.sweep(); assert.equal((await service.read(stale)).state, 'ended');
    const pending = await session(); await service.start({ sessionId: pending, config });
    conversationPending = true;
    assert.equal((await service.state(pending, { touch: true })).handoff.status, 'waiting');
    assert.equal((await service.read(pending)).state, 'waiting');
    await service.end(pending);
    assert.equal((await service.read(pending)).cleanup_pending, true);
    await assert.rejects(service.join(pending), { status: 409 });
    conversationPending = false;
    await service.sweep();
    assert.equal((await service.read(pending)).cleanup_pending, false);
    const missing = await session(); await service.start({ sessionId: missing, config });
    await pool.query("UPDATE widget_video_sessions SET created_at=NOW()-interval '2 minutes' WHERE session_id=$1", [missing]);
    conversationPending = true;
    assert.equal((await service.state(missing)).handoff.status, 'disconnected');
    assert.equal((await service.read(missing)).cleanup_pending, false);
  } finally {
    await pool.query('DELETE FROM widgets WHERE id=$1', [widgetId]);
    await closePostgresPool();
  }
});
