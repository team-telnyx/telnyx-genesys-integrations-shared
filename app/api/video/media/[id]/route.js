import { getPostgresPool } from '@/lib/postgres.mjs';
import { videoMediaResponse } from '@/lib/video/media-library.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) {
  const { id } = await params;
  return videoMediaResponse(getPostgresPool(), id, { rangeHeader: request.headers.get('range') });
}
export async function HEAD(request, { params }) {
  const { id } = await params;
  return videoMediaResponse(getPostgresPool(), id, { head: true });
}
