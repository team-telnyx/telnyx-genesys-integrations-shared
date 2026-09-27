import { NextResponse } from 'next/server';
import { requireSameOrigin, requireWidgetAdmin } from '@/lib/genesys/admin-auth';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { listVideoMedia, readVideoUpload, storeVideoMedia } from '@/lib/video/media-library.mjs';

export const runtime = 'nodejs';

function failure(error) {
  return NextResponse.json({ error: error.status ? error.message : 'Unable to access the video library' }, { status: error.status || 500 });
}

export async function GET(request) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ media: await listVideoMedia(getPostgresPool(), auth.actor.organizationId) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return failure(error); }
}

export async function POST(request) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const file = await readVideoUpload(request);
    const media = await storeVideoMedia(getPostgresPool(), { ...file, actor: auth.actor });
    return NextResponse.json({ media }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
