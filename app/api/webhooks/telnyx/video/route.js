import { NextResponse } from 'next/server';
import { hydrateRuntimeSecrets } from '@/lib/genesys/encrypted-secret-store.mjs';
import { verifyAndParseTelnyxWebhookRequest } from '@/lib/telnyx/webhooks.mjs';
import { processVideoWebhook } from '@/lib/video/webhooks.mjs';
export const runtime = 'nodejs';
export async function POST(request) {
  try {
    await hydrateRuntimeSecrets({ required: false });
    const { event } = await verifyAndParseTelnyxWebhookRequest(request);
    return NextResponse.json(await processVideoWebhook(event));
  } catch (error) {
    const status = Number(error.status || 500);
    if (status >= 500) console.error('[video-webhook]', error.message);
    return NextResponse.json({ error: status >= 500 ? 'Video webhook processing failed' : error.message }, { status });
  }
}
