import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDeletionPlan } from '../lib/genesys/deletion-executor.mjs';
const flow = { id: 'flow', displayName: 'Flow', provider: 'genesys' };
const app = { id: 'app', displayName: 'Admin', provider: 'genesys', logicalKey: 'admin_client_application' };
const oauth = { id: 'oauth', provider: 'genesys', logicalKey: 'admin_oauth_client' };
const run = (plan, selected, remove, markFailed = async () => {}) => executeDeletionPlan({ plan, selected, remove, markFailed, markDeleted: async () => {} });
test('provider and database reporting failures do not abort processing or remove access', async () => {
 const calls=[]; const other={id:'other'};
 const result=await run([app, flow, other, oauth],[app,flow,other,oauth],async r=>{calls.push(r.id);if(r.id==='flow')throw Error('provider conflict');},async()=>{throw Error('database unavailable');});
 assert.deepEqual(calls,['flow','other']);assert.equal(result.failed,1);assert.equal(result.skipped,2);
 assert.equal(result.results[0].error,'provider conflict');assert.equal(result.results[0].trackingError,'database unavailable');
});
test('unselected resources prevent administration removal',async()=>{
 const result=await run([flow,app],[app],async()=>assert.fail('must retain access'));
 assert.equal(result.skipped,1);
});
test('administration resources follow successful cleanup and app is last',async()=>{
 const calls=[];const result=await run([app,oauth,flow],[app,oauth,flow],async r=>calls.push(r.id));
 assert.deepEqual(calls,['flow','oauth','app']);assert.equal(result.administrationAccessDeleted,true);
});
test('failed dependent preserves its dependency',async()=>{
 const dependent={...flow,dependencies:[{resourceId:'connector'}]};const connector={id:'connector'};
 const result=await run([dependent,connector],[dependent,connector],async r=>{assert.equal(r.id,'flow');throw Error('in use');});
 assert.equal(result.skipped,1);
});
test('external resources do not prevent final removal of installation access', async()=>{
 const result=await run([{id:'external',ownership:'external'},app],[app],async()=>{});
 assert.equal(result.deleted,1);
});
test('failure saving successful deletion retains administration access',async()=>{
 const result=await executeDeletionPlan({plan:[flow,app],selected:[app,flow],remove:async()=>{},markDeleted:async()=>{throw Error('write failed');},markFailed:async()=>{}});
 assert.equal(result.failed,1);assert.equal(result.skipped,1);assert.equal(result.administrationAccessDeleted,false);
});
test('shared organization TTS does not block removal of installation access',async()=>{
 const shared={id:'tts',scopeType:'organization',ownership:'managed'};
 const calls=[];const result=await run([shared,app,oauth],[app,oauth],async r=>calls.push(r.id));
 assert.deepEqual(calls,['oauth','app']);assert.equal(result.skipped,0);
});
