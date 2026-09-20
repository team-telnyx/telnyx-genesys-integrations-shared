import test from 'node:test';
import assert from 'node:assert/strict';
import {deleteGenesysOauthClient} from '../lib/genesys/oauth-client-delete.mjs';
const missing=()=>{throw Object.assign(Error('missing'),{status:404});};
test('active OAuth is deactivated before deletion and absence is verified',async()=>{
 const calls=[];let client={name:'admin',authorizedGrantType:'CODE',state:'active',registeredRedirectUri:['https://example.com/callback'],scope:['users'],secret:'never resend'};
 const api={getOauthClient:async()=>{calls.push('get');return client||missing();},putOauthClient:async(id,body)=>{calls.push('put');assert.equal(body.state,'inactive');assert.equal(body.secret,undefined);assert.deepEqual(body.scope,['users']);client=body;},deleteOauthClient:async()=>{calls.push('delete');assert.equal(client.state,'inactive');client=null;}};
 assert.deepEqual(await deleteGenesysOauthClient(api,'test'),{deleted:true});
 assert.deepEqual(calls,['get','put','get','delete','get']);
});
test('missing OAuth is safe to retry',async()=>assert.deepEqual(await deleteGenesysOauthClient({getOauthClient:missing},'test'),{alreadyMissing:true}));
test('deactivation failure does not attempt deletion',async()=>{
 await assert.rejects(deleteGenesysOauthClient({getOauthClient:async()=>({state:'active'}),putOauthClient:async()=>{throw Error('forbidden');},deleteOauthClient:async()=>assert.fail('must not delete')},'test'),/forbidden/);
});
test('inactive OAuth skips update and verifies deletion',async()=>{
 let exists=true;
 const result=await deleteGenesysOauthClient({getOauthClient:async()=>exists?{state:'inactive'}:missing(),putOauthClient:async()=>assert.fail('already inactive'),deleteOauthClient:async()=>{exists=false;}},'test');
 assert.equal(result.deleted,true);
});
test('successful HTTP delete without actual absence is not reported as deleted',async()=>{
 await assert.rejects(deleteGenesysOauthClient({getOauthClient:async()=>({state:'inactive'}),deleteOauthClient:async()=>{}},'test'),/still exists/);
});
