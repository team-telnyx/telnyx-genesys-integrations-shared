import { NextResponse } from 'next/server';

import { getNotificationsApi } from '@/lib/genesys/client';
import { buildTopicCatalogue } from '@/lib/genesys/notification-topics.mjs';

function toErrorResponse(error) {
  const status = error?.status || error?.statusCode || 500;
  const message = error?.body?.message || error?.message || 'Genesys notifications request failed';
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  try {
    const notificationsApi = await getNotificationsApi();
    const response = await notificationsApi.getNotificationsAvailabletopics({ includePreview: true });
    const catalogue = buildTopicCatalogue(response.entities || []);
    return NextResponse.json({ ...catalogue, count: catalogue.topics.length });
  } catch (error) {
    console.error('Error fetching Genesys notification topics:', error);
    return toErrorResponse(error);
  }
}
