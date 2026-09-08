import { NextResponse } from 'next/server';

import { getNotificationsApi } from '@/lib/genesys/client';

function toErrorResponse(error) {
  const status = error?.status || error?.statusCode || 500;
  const message = error?.body?.message || error?.message || 'Genesys notification subscription request failed';
  return NextResponse.json({ error: message }, { status });
}

function normalizeSubscriptions(body) {
  const rawSubscriptions = Array.isArray(body) ? body : body?.subscriptions;
  return (rawSubscriptions || [])
    .map((subscription) => (typeof subscription === 'string' ? { id: subscription } : subscription))
    .filter((subscription) => subscription?.id)
    .map((subscription) => ({ id: subscription.id }));
}

export async function GET(_request, { params }) {
  try {
    const { channelId } = await params;
    const notificationsApi = await getNotificationsApi();
    const subscriptions = await notificationsApi.getNotificationsChannelSubscriptions(channelId);
    return NextResponse.json(subscriptions);
  } catch (error) {
    console.error('Error listing Genesys notification subscriptions:', error);
    return toErrorResponse(error);
  }
}

export async function POST(request, { params }) {
  try {
    const { channelId } = await params;
    const body = await request.json();
    const subscriptions = normalizeSubscriptions(body);
    const notificationsApi = await getNotificationsApi();
    const response = await notificationsApi.postNotificationsChannelSubscriptions(channelId, subscriptions, {
      ignoreErrors: body?.ignoreErrors ?? true,
    });
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('Error adding Genesys notification subscriptions:', error);
    return toErrorResponse(error);
  }
}

export async function PUT(request, { params }) {
  try {
    const { channelId } = await params;
    const body = await request.json();
    const subscriptions = normalizeSubscriptions(body);
    const notificationsApi = await getNotificationsApi();
    const response = await notificationsApi.putNotificationsChannelSubscriptions(channelId, subscriptions, {
      ignoreErrors: body?.ignoreErrors ?? true,
    });
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error replacing Genesys notification subscriptions:', error);
    return toErrorResponse(error);
  }
}

export async function DELETE(request, { params }) {
  try {
    const { channelId } = await params;
    const { searchParams } = new URL(request.url);
    const topicId = searchParams.get('topicId');
    const notificationsApi = await getNotificationsApi();

    if (!topicId) {
      const response = await notificationsApi.deleteNotificationsChannelSubscriptions(channelId);
      return NextResponse.json(response || { subscriptions: [] });
    }

    const current = await notificationsApi.getNotificationsChannelSubscriptions(channelId);
    const remaining = (current.entities || current || [])
      .filter((subscription) => subscription.id !== topicId)
      .map((subscription) => ({ id: subscription.id }));
    const response = await notificationsApi.putNotificationsChannelSubscriptions(channelId, remaining, { ignoreErrors: true });
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error deleting Genesys notification subscriptions:', error);
    return toErrorResponse(error);
  }
}
