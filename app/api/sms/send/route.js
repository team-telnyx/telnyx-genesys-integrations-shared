import { NextResponse } from 'next/server';
import Telnyx from 'telnyx';

const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });

export async function POST(request) {
  try {
    const body = await request.json();
    const { to, text, from } = body;

    if (!to || !text) {
      return NextResponse.json(
        { error: 'Missing required fields: to, text' },
        { status: 400 }
      );
    }

    const sender = from || process.env.TELNYX_FROM_NUMBER;
    const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
    
    // Construct webhook URL dynamically if possible, or use configured env var
    // Legacy used: `${process.env.API_SERVER_URL}/api/sms/inbound`
    // We'll use the APP_URL or request origin
    let origin = process.env.APP_URL;
    if (!origin) {
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
        const proto = request.headers.get('x-forwarded-proto') || 'https';
        origin = `${proto}://${host}`;
    }
    const webhookUrl = `${origin}/api/genesys/sms/inbound`;

    console.log(`Sending SMS to ${to} from ${sender}`);

    const response = await telnyx.messages.send({
      from: sender,
      to: to,
      text: text,
      messaging_profile_id: messagingProfileId,
      webhook_url: webhookUrl,
      use_profile_webhooks: false,
      tags: ["Genesys Cloud"]
    });

    return NextResponse.json({ 
        success: true, 
        messageId: response.data.id, 
        data: response.data 
    });

  } catch (error) {
    console.error('Error sending SMS:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to send SMS' },
      { status: 500 }
    );
  }
}
