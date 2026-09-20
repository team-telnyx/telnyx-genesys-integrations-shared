import test from 'node:test';
import assert from 'node:assert/strict';

test('legacy TTS resource inherits organization scope from its aggregate',async()=>{
 globalThis.__telnyxGenesysPostgres={pool:{query:async(_sql,values)=>{
  assert.deepEqual(values,['organization']);
  return {rows:[{id:'tts',provider:'genesys',resource_type:'tts_connector',scope_type:'installation',aggregate_scope_type:'organization',ownership:'managed'},
   {id:'admin',provider:'genesys',resource_type:'client_application',scope_type:'installation',aggregate_scope_type:'installation',ownership:'managed'}]};
 }}};
 const {listDestroyableManagedResources}=await import('../lib/genesys/managed-resource-registry.mjs');
 const rows=await listDestroyableManagedResources('organization');
 assert.equal(rows[0].scopeType,'organization');
 assert.equal(rows[1].scopeType,'installation');
});
