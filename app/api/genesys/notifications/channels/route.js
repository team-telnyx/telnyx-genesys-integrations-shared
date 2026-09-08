import { NextResponse } from 'next/server';

import { getNotificationsApi } from '@/lib/genesys/client';

function toErrorResponse(error) {
  const status = error?.status || error?.statusCode || 500;
  const message = error?.body?.message || error?.message || 'Genesys notification channel request failed';
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  try {
    const notificationsApi = await getNotificationsApi();
    const channels = await notificationsApi.getNotificationsChannels();
    return NextResponse.json(channels);
  } catch (error) {
    console.error('Error listing Genesys notification channels:', error);
    return toErrorResponse(error);
  }
}

export async function POST() {
  try {
    const notificationsApi = await getNotificationsApi();
    const channel = await notificationsApi.postNotificationsChannels();
    return NextResponse.json(channel, { status: 201 });
  } catch (error) {
    console.error('Error creating Genesys notification channel:', error);
    return toErrorResponse(error);
  }
}
