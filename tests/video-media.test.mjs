import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_VIDEO_MEDIA_BYTES, sniffVideoType, readVideoUpload, storeVideoMedia, listVideoMedia, assertVideoMediaReferences, deleteVideoMedia, videoMediaResponse } from '../lib/video/media-library.mjs';
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig, publicWidgetConfig } from '../lib/widgets/config.js';

const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'), Buffer.alloc(500, 7)]);
const webm = Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810242858102', 'hex');
const withVideo = (id) => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.video.waiting.items = [{ source: 'library', mediaId: id, url: '', label: 'Waiting' }];
  return config;
};

test('video container validation rejects renamed images, documents and Matroska', () => {
  assert.equal(sniffVideoType(mp4), 'video/mp4'); assert.equal(sniffVideoType(webm), 'video/webm');
  const avif = Buffer.from(mp4); avif.write('avif', 8);
  assert.equal(sniffVideoType(avif), null);
  assert.equal(sniffVideoType(Buffer.from('<html>not a video</html>')), null);
  assert.equal(sniffVideoType(Buffer.from('1a45dfa34d6174726f736b61000000000000', 'hex')), null);
  assert.equal(sniffVideoType(Buffer.alloc(0)), null);
});

test('multipart upload bounds declared and streamed bytes, requires exactly one file', async () => {
  const form = new FormData(); form.append('file', new Blob([mp4], { type: 'video/mp4' }), 'waiting.mp4');
  const parsed = await readVideoUpload(new Request('https://example.test/upload', { method: 'POST', body: form }));
  assert.equal(parsed.name, 'waiting.mp4'); assert.deepEqual(parsed.bytes, mp4);
  await assert.rejects(readVideoUpload(new Request('https://example.test/upload', { method: 'POST', body: 'x', headers: { 'Content-Length': String(MAX_VIDEO_MEDIA_BYTES + 65537) } })), { status: 413 });
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
  await assert.rejects(readVideoUpload(new Request('https://example.test/upload', { method: 'POST', body: stream, duplex: 'half' }), 10), { status: 413 });
  assert.equal(cancelled, true);
  form.append('file', new Blob([mp4]), 'another.mp4');
  await assert.rejects(readVideoUpload(new Request('https://example.test/upload', { method: 'POST', body: form })), { status: 400 });
  await assert.rejects(readVideoUpload(new Request('https://example.test/upload', { method: 'POST', body: 'not multipart' })), { status: 400 });
});

test('widget configurations accept a mixed playlist and reject invalid library IDs or insecure URLs', () => {
  const id = randomUUID(), config = withVideo(id);
  config.channels.video.waiting.items.push({ source: 'url', url: 'https://example.test/video.webm', label: 'External' });
  assert.equal(parseWidgetConfig(config).channels.video.waiting.items.length, 2);
  assert.equal(publicWidgetConfig(config).channels.video.waiting.items[0].mediaId, id);
  assert.throws(() => parseWidgetConfig(withVideo('../escape')));
  config.channels.video.waiting.items[1].url = 'http://example.test/insecure.mp4';
  assert.throws(() => parseWidgetConfig(config));
});

test('PostgreSQL library isolates organizations, protects references and streams full/ranged files', { skip: !process.env.VIDEO_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.VIDEO_TEST_DATABASE_URL;
  const root = await mkdtemp(path.join(os.tmpdir(), 'genesys-video-media-'));
  process.env.WIDGET_ASSET_DIR = root;
  const { ensurePostgresSchema } = await import('../lib/postgres-schema.mjs');
  const { getPostgresPool, closePostgresPool } = await import('../lib/postgres.mjs');
  await ensurePostgresSchema(); const pool = getPostgresPool();
  const actor = { organizationId: randomUUID(), userId: 'test' }, other = randomUUID();
  const widget = randomUUID(), revision = randomUUID();
  try {
    await assert.rejects(storeVideoMedia(pool, { bytes: Buffer.from('invalid'), name: 'fake.mp4', actor }), { status: 400 });
    const media = await storeVideoMedia(pool, { bytes: mp4, name: '../waiting\n.mp4', actor });
    assert.equal(media.contentType, 'video/mp4'); assert.equal(media.byteSize, mp4.length);
    assert.equal((await listVideoMedia(pool, actor.organizationId)).length, 1);
    assert.deepEqual(await listVideoMedia(pool, other), []);
    assert.deepEqual(await readdir(path.join(root, 'video')), [`${media.id}.mp4`]);
    await assert.rejects(assertVideoMediaReferences(pool, withVideo(media.id), other), { status: 400 });
    await assert.rejects(deleteVideoMedia(pool, media.id, other), { status: 404 });
    const full = await videoMediaResponse(pool, media.id);
    assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), mp4);
    const partial = await videoMediaResponse(pool, media.id, { rangeHeader: 'bytes=10-39' });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 10-39/${mp4.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), mp4.subarray(10, 40));
    const tail = await videoMediaResponse(pool, media.id, { rangeHeader: 'bytes=-7' });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), mp4.subarray(-7));
    const invalid = await videoMediaResponse(pool, media.id, { rangeHeader: 'bytes=9999-' });
    assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${mp4.length}`);
    const head = await videoMediaResponse(pool, media.id, { head: true });
    assert.equal(head.headers.get('content-length'), String(mp4.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await videoMediaResponse(pool, '../escape')).status, 404);
    await pool.query('INSERT INTO widgets(id,public_id,name,normalized_name,installation_key,genesys_organization_id) VALUES($1,$2,$2,$2,$2,$3)', [widget, `media-test-${widget}`, actor.organizationId]);
    await pool.query("INSERT INTO widget_revisions(id,widget_id,version,state,config) VALUES($1,$2,1,'draft',$3)", [revision, widget, withVideo(media.id)]);
    await assert.rejects(deleteVideoMedia(pool, media.id, actor.organizationId), { status: 409 });
    await pool.query("UPDATE widget_revisions SET state='published' WHERE id=$1", [revision]);
    await assert.rejects(deleteVideoMedia(pool, media.id, actor.organizationId), { status: 409 });
    await pool.query("UPDATE widget_revisions SET state='archived' WHERE id=$1", [revision]);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await assertVideoMediaReferences(tx, withVideo(media.id), actor.organizationId);
      let finished = false;
      const deleting = deleteVideoMedia(pool, media.id, actor.organizationId).finally(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(finished, false, 'deletion waits for the referencing transaction');
      await tx.query("UPDATE widget_revisions SET state='draft' WHERE id=$1", [revision]);
      await tx.query('COMMIT');
      await assert.rejects(deleting, { status: 409 });
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    await pool.query('DELETE FROM widgets WHERE id=$1', [widget]);
    assert.deepEqual(await deleteVideoMedia(pool, media.id, actor.organizationId), { deleted: true });
    assert.equal((await videoMediaResponse(pool, media.id)).status, 404);
    await assert.rejects(assertVideoMediaReferences(pool, withVideo(media.id), actor.organizationId), { status: 400 });
    assert.deepEqual(await listVideoMedia(pool, actor.organizationId), []);
    assert.deepEqual(await readdir(path.join(root, 'video')), []);
    await pool.query(`INSERT INTO widget_video_media(id,genesys_organization_id,name,content_type,byte_size)
      SELECT gen_random_uuid(),$1,'quota','video/mp4',1 FROM generate_series(1,200)`, [actor.organizationId]);
    await assert.rejects(storeVideoMedia(pool, { bytes: mp4, name: 'full.mp4', actor }), { status: 409 });
    assert.deepEqual(await readdir(path.join(root, 'video')), []);
  } finally {
    await pool.query('DELETE FROM widgets WHERE id=$1', [widget]);
    await pool.query('DELETE FROM widget_video_media WHERE genesys_organization_id=$1', [actor.organizationId]);
    await closePostgresPool(); await rm(root, { recursive: true, force: true }); delete process.env.WIDGET_ASSET_DIR;
  }
});
