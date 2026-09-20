import dotenv from 'dotenv';
import Telnyx from 'telnyx';
import platformClient from 'purecloud-platform-client-v2';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testTelnyx() {
  console.log('\n📡 Testing Telnyx API connection...');
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) throw new Error('TELNYX_API_KEY missing');
    
    const telnyx = new Telnyx({ apiKey });
    const balance = await telnyx.balance.retrieve();
    
    console.log('✅ Telnyx Connected!');
    console.log(`   Balance: ${balance.data.balance} ${balance.data.currency}`);
    return true;
  } catch (error) {
    console.error('❌ Telnyx Error:', error.message);
    return false;
  }
}

async function testGenesys() {
  console.log('\n📡 Testing Genesys Cloud API connection...');
  try {
    const clientId = process.env.GC_CLIENT_CRED_CLIENT_ID;
    const clientSecret = process.env.GC_CLIENT_CRED_CLIENT_SECRET;
    const environment = process.env.GC_ENVIRONMENT;

    if (!clientId || !clientSecret || !environment) {
      throw new Error('Genesys credentials missing (GC_CLIENT_CRED_CLIENT_ID, GC_CLIENT_CRED_CLIENT_SECRET, GC_ENVIRONMENT)');
    }

    const client = platformClient.ApiClient.instance;
    client.setEnvironment(environment);

    await client.loginClientCredentialsGrant(clientId, clientSecret);
    console.log('✅ Genesys Auth Successful (Client Credentials)');

    const usersApi = new platformClient.UsersApi();
    // getUsersMe works for user context, but for client credentials we might not have a "me".
    // Let's try getting org info or just verify the token is valid by making a simple call.
    // getAuthorizationMe is often good.
    // Or just listing users with limit 1.
    const users = await usersApi.getUsers({ pageSize: 1 });
    console.log(`   Fetched ${users.entities.length} user(s) to verify access.`);

    return true;
  } catch (error) {
    console.error('❌ Genesys Error:', error.message || error);
    // console.error(JSON.stringify(error, null, 2));
    return false;
  }
}

async function run() {
  console.log('🚀 Starting API Connection Tests');
  
  const telnyxOk = await testTelnyx();
  const genesysOk = await testGenesys();

  console.log('\nSummary:');
  console.log(`Telnyx:  ${telnyxOk ? '✅' : '❌'}`);
  console.log(`Genesys: ${genesysOk ? '✅' : '❌'}`);
  
  if (!telnyxOk || !genesysOk) process.exit(1);
}

run();
