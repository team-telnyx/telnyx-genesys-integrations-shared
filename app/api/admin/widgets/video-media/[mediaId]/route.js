import { NextResponse } from 'next/server';
import { requireSameOrigin, requireWidgetAdmin } from '@/lib/genesys/admin-auth';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { deleteVideoMedia } from '@/lib/video/media-library.mjs';

export async function DELETE(request, { params }) {
  const originError = await requireSameOrigin(request);
  if (originError) return originError;
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  try {
    const { mediaId } = await params;
    return NextResponse.json(await deleteVideoMedia(getPostgresPool(), mediaId, auth.actor.organizationId));
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : 'Unable to delete the video' }, { status: error.status || 500 });
  }
}
