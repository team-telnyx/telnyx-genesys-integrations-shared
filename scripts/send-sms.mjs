import dotenv from 'dotenv';
import Telnyx from 'telnyx';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const apiKey = process.env.TELNYX_API_KEY;
const from = process.env.TELNYX_FROM_NUMBER;
const to = process.env.TELNYX_TEST_TO_NUMBER;
const text = process.env.TELNYX_TEST_MESSAGE || 'Test message from the Telnyx Genesys integration';

if (!apiKey || !from || !to) {
  console.error('TELNYX_API_KEY, TELNYX_FROM_NUMBER, and TELNYX_TEST_TO_NUMBER are required');
  process.exit(1);
}

const telnyx = new Telnyx({ apiKey });

async function send() {
  console.log(`Sending SMS from ${from} to ${to}...`);
  try {
    const response = await telnyx.messages.send({
      from: from,
      to: to,
      text
    });
    console.log('✅ SMS Sent!');
    console.log('ID:', response.data.id);
  } catch (e) {
    console.error('❌ Error sending SMS:', e.message);
    if (e.raw) {
      console.error('Details:', JSON.stringify(e.raw, null, 2));
    }
  }
}

send();
