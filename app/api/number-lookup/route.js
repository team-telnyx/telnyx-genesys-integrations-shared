import { NextResponse } from 'next/server';
import Telnyx from 'telnyx';

const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });

export async function POST(request) {
  try {
    const body = await request.json();
    const { number, carrierLookup, callerLookup } = body;

    if (!number) {
      return NextResponse.json(
        { error: 'Missing required field: number' },
        { status: 400 }
      );
    }

    const type = [];
    if (carrierLookup) type.push('carrier');
    if (callerLookup) type.push('caller-name');

    console.log(`Looking up number: ${number} (Carrier: ${carrierLookup}, Caller: ${callerLookup})`);

    // In legacy, webhook_url was set to api/nl. Here, we can do the same if async is needed.
    // However, retrieve() typically returns sync response if possible, or async if type is extensive.
    // Let's mirror legacy logic with webhook_url.
    let origin = process.env.APP_URL;
    if (!origin) {
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
        const proto = request.headers.get('x-forwarded-proto') || 'https';
        origin = `${proto}://${host}`;
    }
    const webhookUrl = `${origin}/api/genesys/number-lookup/webhook`;

    const response = await telnyx.numberLookup.retrieve(number, {
      type: type,
      webhook_url: webhookUrl,
      use_profile_webhooks: false
    });

    return NextResponse.json({ success: true, data: response.data });

  } catch (error) {
    console.error('Error looking up number:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to lookup number' },
      { status: 500 }
    );
  }
}
