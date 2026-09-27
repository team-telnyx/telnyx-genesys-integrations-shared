import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig, publicWidgetConfig, assertPublishableWidgetConfig } from '../lib/widgets/config.js';
import { videoWidgetConfiguration, resolveVideoAccessGroups } from '../lib/genesys/video-installer.mjs';
import { disconnectVideoConversation, authorizeVideoAgent, videoConversationState, videoInboundMessage } from '../lib/genesys/video-conversation.mjs';
import { evaluateWidgetDecisions } from '../lib/widgets/decisions.js';
import { createWidgetInfrastructureState } from '../lib/widgets/infrastructure-state.js';
const uuid = '22222222-2222-4222-8222-222222222222';
const participant = (purpose, state, extra = {}) => ({ purpose, messages: [{ state }], ...extra });

test('video inherits live agent visibility, not the administration group in the current infrastructure manifest', async () => {
  const context = {
    integrationsApi: { getIntegrationConfigCurrent: async (id) => {
      assert.equal(id, 'shared-panel');
      return { properties: { groups: ['agents', 'agents'] } };
    } },
    groupsApi: { getGroup: async (id) => ({ id, name: id }) },
  };
  assert.deepEqual(await resolveVideoAccessGroups({ context, infrastructure: {
    access: { group: { id: 'admins' } }, resources: { interactionWidgetId: 'shared-panel' },
  } }), [{ id: 'agents', name: 'agents' }]);
  for (const access of [{ groups: [{ id: 'legacy' }] }, { group: { id: 'legacy' } }]) {
    assert.deepEqual(await resolveVideoAccessGroups({ context, infrastructure: { access } }), [{ id: 'legacy', name: 'legacy' }]);
  }
  context.integrationsApi.getIntegrationConfigCurrent = async () => ({ properties: { groups: [] } });
  await assert.rejects(resolveVideoAccessGroups({ context, infrastructure: {
    access: { group: { id: 'admins' } }, resources: { interactionWidgetId: 'shared-panel' },
  } }), /access groups/);
  await assert.rejects(resolveVideoAccessGroups({ context, infrastructure: null }), /access groups/);
});

test('old widgets default to video disabled; video-only widgets require a Genesys queue, no assistant or trunk', () => {
  const old = structuredClone(DEFAULT_WIDGET_CONFIG); delete old.channels.video;
  assert.equal(parseWidgetConfig(old).channels.video.enabled, false);
  const config = parseWidgetConfig(old);
  config.channels.messaging.enabled = false; config.channels.voice.enabled = false; config.channels.video.enabled = true;
  config.allowedOrigins = ['https://example.com'];
  assert.throws(() => assertPublishableWidgetConfig(config), /Genesys Cloud video queue/);
  config.channels.video.genesys.queueId = uuid;
  assert.doesNotThrow(() => assertPublishableWidgetConfig(config));
  config.behavior.defaultSurface = 'video';
  assert.equal(parseWidgetConfig(config).behavior.defaultSurface, 'video');
  assert.equal(publicWidgetConfig(config).channels.video.genesys, undefined);
});

test('video queue changes require infrastructure reconciliation while scenes and playlist do not', () => {
  const config = parseWidgetConfig(DEFAULT_WIDGET_CONFIG); config.channels.video.enabled = true;
  const fingerprint = () => createWidgetInfrastructureState({ config }).fingerprint;
  const before = fingerprint(); config.channels.video.genesys.queueId = uuid;
  const changed = fingerprint(); assert.notEqual(before, changed);
  config.channels.video.scenes.default = 'split'; config.channels.video.waiting.items = [{ source: 'url', url: 'https://example.com/ad.mp4', label: 'Ad' }];
  assert.equal(fingerprint(), changed);
});

test('video configuration validates playlist URLs and constrains scene selection', () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.video.waiting.items = [{ source: 'url', url: 'javascript:alert(1)' }];
  assert.throws(() => parseWidgetConfig(config));
  config.channels.video.waiting.items = [];
  config.channels.video.scenes = { available: ['split'], default: 'pip' };
  assert.equal(parseWidgetConfig(config).channels.video.scenes.default, 'split');
});

test('decision channel selection supports video and keeps the meaning of legacy both', () => {
  const config = parseWidgetConfig(DEFAULT_WIDGET_CONFIG); config.channels.voice.enabled = true; config.channels.video.enabled = true;
  config.decisions = { enabled: true, variables: [], strategy: 'first-match', rules: [{ id: 'r', enabled: true, priority: 1, match: 'all', conditions: [], actions: [{ type: 'channels', value: 'video' }] }] };
  assert.deepEqual(evaluateWidgetDecisions(config).channels, ['video']);
  config.decisions.rules[0].actions[0].value = 'both';
  assert.deepEqual(evaluateWidgetDecisions(config).channels, ['messaging', 'voice']);
});

test('Genesys interaction panel is scoped to the configured queue, groups and Open Messaging with video permissions', () => {
  const body = videoWidgetConfiguration({ name: 'Video', baseUrl: 'https://example.com', groups: [{ id: 'g' }], queueId: uuid });
  assert.deepEqual(body.properties.queueIdFilterList, [uuid]);
  assert.deepEqual(body.properties.groups, ['g']);
  assert.equal(body.properties.communicationTypeFilter, 'open');
  assert.equal(body.properties.permissions, 'camera,microphone,display-capture,fullscreen');
  assert.match(body.properties.url, /conversationId={{gcConversationId}}/);
  assert.throws(() => videoWidgetConfiguration({ groups: [] }), /access group/);
});

test('video handoff contains the validated queue and correlation without room credentials', () => {
  const message = videoInboundMessage({ sessionId: uuid, queueId: 'q', queueName: 'Video' });
  assert.equal(message.channel.metadata.customAttributes.telnyx_ai_queue_id, 'q');
  assert.equal(message.channel.metadata.customAttributes.telnyx_ai_channel, 'video');
  assert.equal(message.channel.from.id, `telnyx-video:${uuid}`);
  assert.doesNotMatch(JSON.stringify(message), /refreshToken|roomId|Bearer/);
});

test('Genesys assignment, acceptance, transfer and disconnect map to distinct video states', () => {
  assert.equal(videoConversationState({ participants: [] }).status, 'waiting');
  assert.equal(videoConversationState({ participants: [participant('agent', 'alerting', { userId: 'a' })] }).status, 'assigned');
  assert.equal(videoConversationState({ participants: [participant('agent', 'connected', { userId: 'a' })] }).status, 'connected');
  assert.equal(videoConversationState({ participants: [participant('agent', 'disconnected'), participant('acd', 'connected')] }).status, 'waiting');
  assert.equal(videoConversationState({ participants: [participant('agent', 'disconnected')] }).status, 'disconnected');
});

test('agent authorization rejects outsiders and former agents, distinguishes an offered conversation from an accepted one', async () => {
  const input = { conversationId: uuid, accessToken: 'test-token', fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'a' }) }) };
  const authorize = (participants, allowCompleted = false) => authorizeVideoAgent({ ...input, allowCompleted, conversationsApi: { getConversation: async () => ({ participants }) } });
  await assert.rejects(authorize([participant('agent', 'connected', { userId: 'b' })]), { status: 403 });
  await assert.rejects(authorize([participant('agent', 'disconnected', { userId: 'a' })]), { status: 403 });
  assert.equal((await authorize([participant('agent', 'disconnected', { userId: 'a' })], true)).accepted, false);
  await assert.rejects(authorize([participant('agent', 'disconnected', { userId: 'b' })], true), { status: 403 });
  assert.equal((await authorize([participant('agent', 'alerting', { userId: 'a' })])).accepted, false);
  assert.equal((await authorize([participant('agent', 'connected', { userId: 'a' })])).accepted, true);
});


test('normal video disconnect leaves agent wrap-up pending, including cleanup retries', async () => {
  const customer = participant('customer', 'connected', { id: 'customer' });
  const agent = participant('agent', 'connected', { id: 'agent', wrapupRequired: true });
  const pendingAcw = participant('agent', 'disconnected', { id: 'previous-agent', wrapupRequired: true, wrapup: null });
  const conversation = { participants: [customer, agent, pendingAcw] }, calls = [];
  const api = {
    getConversation: async () => conversation,
    postConversationDisconnect: async () => assert.fail('Full teardown would delete agent wrap-up'),
    patchConversationsMessageParticipant: async (id, participantId, options) => {
      assert.equal(id, uuid); assert.deepEqual(options, { body: { state: 'disconnected' } });
      calls.push(participantId);
      conversation.participants.find(p => p.id === participantId).messages[0].state = 'disconnected';
    },
  };
  await disconnectVideoConversation(api, uuid);
  assert.deepEqual(calls, ['customer', 'agent']);
  assert.equal(agent.wrapupRequired, true); assert.equal(pendingAcw.wrapup, null);
  await disconnectVideoConversation(api, uuid);
  assert.deepEqual(calls, ['customer', 'agent'], 'retry must not complete ACW');
});

test('visitor cancellation disconnects queued media and rechecks an agent disconnected by Genesys', async () => {
  const conversation = { participants: [participant('customer', 'connected', { id: 'c' }), participant('agent', 'alerting', { id: 'a' })] };
  const calls = [];
  const api = {
    getConversation: async () => conversation,
    patchConversationsMessageParticipant: async (_id, participantId) => {
      calls.push(participantId); conversation.participants.forEach(p => { p.messages[0].state = 'disconnected'; });
    },
  };
  await disconnectVideoConversation(api, uuid);
  assert.deepEqual(calls, ['c'], 'do not repatch an agent now in wrap-up');
  conversation.participants = [participant('customer', 'connected', { id: 'queued' }), participant('acd', 'connected')];
  await disconnectVideoConversation(api, uuid);
  assert.deepEqual(calls, ['c', 'queued']);
});

test('a partial disconnect is retried without ever force-completing wrap-up', async () => {
  const conversation = { participants: [participant('customer', 'connected', { id: 'c' }), participant('agent', 'connected', { id: 'a' })] };
  let unavailable = true;
  const calls = [];
  const api = {
    getConversation: async () => conversation,
    patchConversationsMessageParticipant: async (_id, id) => {
      calls.push(id); if (id === 'a' && unavailable) throw Object.assign(new Error('Unavailable'), { status: 503 });
      conversation.participants.find(p => p.id === id).messages[0].state = 'disconnected';
    },
  };
  await assert.rejects(disconnectVideoConversation(api, uuid), { status: 503 });
  unavailable = false; await disconnectVideoConversation(api, uuid);
  assert.deepEqual(calls, ['c', 'a', 'a']);
  conversation.participants = [];
  await assert.rejects(disconnectVideoConversation(api, uuid), { status: 503 });
});
