import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseAttachmentByteRange } from '../widgets/attachment-ranges.js';

export const MAX_VIDEO_MEDIA_BYTES = 64 * 1048576;
export const MAX_VIDEO_MEDIA_ITEMS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const directory = () => path.join(process.env.WIDGET_ASSET_DIR || path.join(process.cwd(), '.widget-assets'), 'video');
const filePath = (id, type) => path.join(directory(), `${id}.${type === 'video/mp4' ? 'mp4' : 'webm'}`);
const view = (row) => ({ id: row.id, name: row.name, contentType: row.content_type,
  byteSize: Number(row.byte_size), createdAt: row.created_at, url: `/api/video/media/${row.id}` });

// Check the container instead of trusting the filename or browser MIME type.
export function sniffVideoType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) return null;
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    const brand = bytes.toString('ascii', 8, 12);
    if (size >= 16 && size <= bytes.length && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(brand)) return 'video/mp4';
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    && bytes.subarray(4, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return 'video/webm';
  return null;
}

// Bound the body before parsing multipart, including requests without Content-Length.
export async function readVideoUpload(request, maximumBytes = MAX_VIDEO_MEDIA_BYTES) {
  const limit = maximumBytes + 65536;
  if (Number(request.headers.get('content-length')) > limit) throw fail('Video exceeds the 64 MB limit', 413);
  const reader = request.body?.getReader();
  if (!reader) throw fail('Video file is required');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw fail('Video exceeds the 64 MB limit', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let form;
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData(); }
  catch { throw fail('Invalid video upload'); }
  const files = form.getAll('file');
  const file = files[0];
  if (files.length !== 1 || !file || typeof file.arrayBuffer !== 'function') throw fail('One video file is required');
  if (file.size > maximumBytes) throw fail('Video exceeds the 64 MB limit', 413);
  return { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
}

export async function listVideoMedia(pool, organizationId) {
  const result = await pool.query('SELECT * FROM widget_video_media WHERE genesys_organization_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC', [organizationId]);
  return result.rows.map(view);
}

export async function storeVideoMedia(pool, { name, bytes, actor }) {
  if (!actor?.organizationId) throw fail('Genesys organization is required', 403);
  if (!bytes?.length) throw fail('Video file is empty');
  if (bytes.length > MAX_VIDEO_MEDIA_BYTES) throw fail('Video exceeds the 64 MB limit', 413);
  const contentType = sniffVideoType(bytes);
  if (!contentType) throw fail('Upload an MP4 or WebM video');
  const id = randomUUID(), target = filePath(id, contentType), temporary = `${target}.tmp`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [847221, 6]);
    const count = await client.query('SELECT count(*)::int AS count FROM widget_video_media WHERE genesys_organization_id=$1 AND deleted_at IS NULL', [actor.organizationId]);
    if (count.rows[0].count >= MAX_VIDEO_MEDIA_ITEMS) throw fail('Media library is full (200 videos). Delete unused videos first.', 409);
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
    await rename(temporary, target);
    const result = await client.query(`INSERT INTO widget_video_media
      (id, genesys_organization_id, name, content_type, byte_size, created_by_genesys_user_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, actor.organizationId, String(name || 'Video').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'Video', contentType, bytes.length, actor.userId]);
    await client.query('COMMIT');
    return view(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await Promise.all([rm(target, { force: true }), rm(temporary, { force: true })]);
    throw error;
  } finally { client.release(); }
}

// Call within the draft/clone/publish transaction. Shared locks prevent a delete
// from racing the first reference to a file, including references from another widget.
export async function assertVideoMediaReferences(client, config, organizationId) {
  const ids = [...new Set((config?.channels?.video?.waiting?.items || []).filter((item) => item.source === 'library').map((item) => item.mediaId))].sort();
  if (!ids.length) return;
  const result = await client.query(`SELECT id FROM widget_video_media
    WHERE id=ANY($1::uuid[]) AND genesys_organization_id=$2 AND deleted_at IS NULL ORDER BY id FOR SHARE`, [ids, organizationId]);
  if (result.rowCount !== ids.length) throw fail('A waiting video is unavailable. Remove it from the playlist or upload it again.');
}

export async function deleteVideoMedia(pool, id, organizationId) {
  if (!UUID.test(id)) throw fail('Invalid video ID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM widget_video_media WHERE id=$1 AND genesys_organization_id=$2 FOR UPDATE', [id, organizationId])).rows[0];
    if (!row) throw fail('Video not found', 404);
    const used = await client.query(`SELECT 1 FROM widget_revisions r
      WHERE r.config->'channels'->'video'->'waiting'->'items' @> $1::jsonb
      AND (r.state IN ('draft','published') OR EXISTS (
        SELECT 1 FROM widget_sessions s JOIN widget_video_sessions v ON v.session_id=s.id
        WHERE s.revision_id=r.id AND v.state IN ('starting','waiting','assigned','connected')
      )) LIMIT 1`, [JSON.stringify([{ source: 'library', mediaId: id }])]);
    if (used.rowCount) throw fail('This video is used by a widget. Remove it from its playlists, save and publish the changes before deleting it. Active video calls must finish first.', 409);
    await client.query('UPDATE widget_video_media SET deleted_at=COALESCE(deleted_at,NOW()) WHERE id=$1', [id]);
    await client.query('COMMIT');
    // A repeated DELETE also retries an interrupted disk cleanup.
    await rm(filePath(id, row.content_type), { force: true });
    return { deleted: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

// Public playlist assets are addressed by random IDs, just like hosted HTTPS
// playlist URLs. Stream from the persistent asset volume, including byte ranges.
export async function videoMediaResponse(pool, id, { rangeHeader, head = false } = {}) {
  if (!UUID.test(id)) return new Response(null, { status: 404 });
  const row = (await pool.query('SELECT * FROM widget_video_media WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
  if (!row) return new Response(null, { status: 404 });
  const total = Number(row.byte_size);
  const range = rangeHeader ? parseAttachmentByteRange(rangeHeader, total) : null;
  if (rangeHeader && !range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  let file;
  try { file = await open(filePath(id, row.content_type), 'r'); }
  catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
  const headers = { 'Content-Type': row.content_type, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(range ? range.end - range.start + 1 : total) };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
  if (head) { await file.close(); return new Response(null, { status: range ? 206 : 200, headers }); }
  return new Response(Readable.toWeb(file.createReadStream(range || {})), { status: range ? 206 : 200, headers });
}
