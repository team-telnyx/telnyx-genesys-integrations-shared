import { NextResponse } from 'next/server';
import Telnyx from 'telnyx';

const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  try {
    const message = await telnyx.messages.retrieve(id);
    return NextResponse.json({ 
        status: message.data.to[0].status, // Status is in the recipient array
        data: message.data 
    });
  } catch (error) {
    console.error('Error retrieving message status:', error);
    return NextResponse.json({ error: 'Failed to retrieve status' }, { status: 500 });
  }
}
