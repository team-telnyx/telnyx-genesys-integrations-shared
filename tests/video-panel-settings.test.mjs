import test from 'node:test';
import assert from 'node:assert/strict';
import { configureVideoPanelQueue, preserveVideoPanelDefaultBeforeUpdate, readVideoPanelStatus, panelSettingsApi, PROFILE_PANEL } from '../lib/genesys/video-panel-settings.mjs';
import { parseWidgetConfig, DEFAULT_WIDGET_CONFIG, publicWidgetConfig } from '../lib/widgets/config.js';

const baseUrl = 'https://example.com';
function fixture({ legacy = false, external = false } = {}) {
  let settings = { settings: { Call: structuredClone(PROFILE_PANEL), Email: { type: 'custom', panelId: 'keep-email' }, Open: external ? { type: 'Integration', panelId: 'crm' } : legacy ? { type: 'Integration', panelId: 'legacy' } : structuredClone(PROFILE_PANEL) } };
  const panels = new Map(), writes = [];
  let state = {}, counter = 0;
  function add(id, queueIds = ['video'], url = `${baseUrl}/genesys/video-widget`) {
    panels.set(id, { integration: { id, name: id, intendedState: 'ENABLED' }, config: { properties: { url, groups: ['agents'], communicationTypeFilter: 'open', queueIdFilterList: queueIds } } });
  }
  if (legacy) add('legacy');
  if (external) add('crm', ['sales'], 'https://crm.example.com/');
  const integrationsApi = {
    getIntegration: async id => { if (!panels.has(id)) throw { status: 404 }; return structuredClone(panels.get(id).integration); },
    getIntegrationConfigCurrent: async id => structuredClone(panels.get(id).config),
    getIntegrations: async () => ({ entities: [...panels.values()].map(p => structuredClone(p.integration)) }),
    postIntegrations: async ({ body }) => { const id = `new-${++counter}`; panels.set(id, { integration: { id, name: body.name, intendedState: 'DISABLED' }, config: {} }); return { id }; },
    putIntegrationConfigCurrent: async (id, { body }) => { writes.push(['config', id]); panels.get(id).config = structuredClone(body); },
    patchIntegration: async (id, { body }) => { Object.assign(panels.get(id).integration, body); writes.push(['activation', id, body.intendedState]); },
  };
  const settingsApi = { get: async () => structuredClone(settings), put: async body => { settings = structuredClone(body); writes.push(['default', settings.settings.Open]); return structuredClone(settings); } };
  const config = { settingsApi, integrationsApi, baseUrl, groups: [{ id: 'agents' }], name: 'Test Video Auto Open', save: async value => { state = structuredClone(value); } };
  return {
    config, panels, writes, get settings() { return settings; }, get state() { return state; },
    apply: (queueId, enabled) => configureVideoPanelQueue({ ...config, state, queueId, enabled }),
    status: queueId => readVideoPanelStatus({ ...config, queueId }),
  };
}

test('reads actual Genesys queue scope, ignoring unrelated Open Messaging and inactive panels', async () => {
  const f = fixture({ legacy: true });
  assert.equal((await f.status('video')).enabled, true);
  assert.equal((await f.status('support')).enabled, false);
  f.panels.get('legacy').config.properties.communicationTypeFilter = 'call';
  assert.equal((await f.status('video')).enabled, false);
  f.panels.get('legacy').config.properties.communicationTypeFilter = 'open';
  f.panels.get('legacy').integration.intendedState = 'DISABLED';
  assert.equal((await f.status('video')).enabled, false);
});

test('queue toggles preserve other queues, all unrelated channel defaults and manual video panels', async () => {
  const f = fixture({ legacy: true });
  const defaults = structuredClone(f.settings.settings);
  await f.apply('support', true);
  assert.deepEqual(f.state.queueIds, ['support', 'video']);
  assert.equal((await f.status('video')).enabled, true);
  assert.equal((await f.status('support')).enabled, true);
  assert.equal((await f.status('sales')).enabled, false);
  assert.deepEqual(f.settings.settings.Call, defaults.Call);
  assert.deepEqual(f.settings.settings.Email, defaults.Email);
  assert.equal(f.panels.get('legacy').integration.intendedState, 'ENABLED');
  assert.deepEqual(f.panels.get('legacy').config.properties.queueIdFilterList, ['video']);
  await f.apply('support', false);
  assert.equal((await f.status('support')).enabled, false);
  assert.equal((await f.status('video')).enabled, true);
  assert.equal(f.panels.size, 2, 'reuses one shared automatic panel');
  await f.apply('video', false);
  assert.deepEqual(f.settings.settings.Open, PROFILE_PANEL);
  assert.equal(f.panels.get(f.state.panelId).integration.intendedState, 'DISABLED');
  await f.apply('sales', true);
  assert.deepEqual(f.state.queueIds, ['sales'], 'disabled queues do not silently return');
});

test('last queue restores the previous default and disabling an unrelated queue cannot take it over', async () => {
  const f = fixture({ external: true });
  const previous = structuredClone(f.settings.settings.Open);
  await f.apply('support', false);
  assert.deepEqual(f.writes, []);
  await f.apply('support', true);
  assert.deepEqual(f.state.previousOpenPanel, previous);
  await f.apply('support', false);
  assert.deepEqual(f.settings.settings.Open, previous);
  assert.equal(f.panels.get('crm').integration.intendedState, 'ENABLED');
});

test('changing the routing queue of a legacy default does not silently enable auto-open in the new queue', async () => {
  const f = fixture({ legacy: true });
  await preserveVideoPanelDefaultBeforeUpdate({ ...f.config, state: f.state, panelId: 'legacy' });
  f.panels.get('legacy').config.properties.queueIdFilterList = ['support'];
  assert.equal((await f.status('video')).enabled, true);
  assert.equal((await f.status('support')).enabled, false);
  const other = fixture({ external: true });
  await preserveVideoPanelDefaultBeforeUpdate({ ...other.config, state: other.state, panelId: 'manual-video' });
  assert.deepEqual(other.writes, []);
});

test('cleanup does not overwrite a new default selected by a Genesys administrator', async () => {
  const f = fixture();
  await f.apply('support', true);
  f.settings.settings.Open = { type: 'Integration', panelId: 'different' };
  await f.apply('support', false);
  assert.deepEqual(f.settings.settings.Open, { type: 'Integration', panelId: 'different' });
});

test('failed remote writes retain recovery state and retry without duplicate panels', async () => {
  const f = fixture();
  const put = f.config.settingsApi.put;
  f.config.settingsApi.put = async () => { throw new Error('temporary outage'); };
  await assert.rejects(f.apply('support', true), /temporary outage/);
  assert.ok(f.state.panelId);
  assert.equal(f.panels.size, 1);
  f.config.settingsApi.put = put;
  await f.apply('support', true);
  assert.equal(f.panels.size, 1);
  assert.equal((await f.status('support')).enabled, true);
});

test('rejects concurrent default changes, unexpected panel ownership and unbounded legacy filters', async () => {
  const f = fixture();
  const save = f.config.save;
  f.config.save = async value => { await save(value); f.settings.settings.Open = { type: 'Integration', panelId: 'concurrent' }; };
  await assert.rejects(f.apply('support', true), { status: 409 });
  assert.equal(f.settings.settings.Open.panelId, 'concurrent');
  const legacy = fixture({ legacy: true });
  legacy.panels.get('legacy').config.properties.queueIdFilterList = [];
  await assert.rejects(legacy.apply('support', true), /no queue filter/);
  assert.deepEqual(legacy.writes, []);
  const changed = fixture();
  await changed.apply('support', true);
  changed.panels.get(changed.state.panelId).config.properties.url = 'https://another.example.com/';
  await assert.rejects(changed.apply('support', false), /URL was changed/);
});

test('Panel Manager adapter uses the configured region and fails clearly on permission or schema errors', async () => {
  const calls = [];
  const api = panelSettingsApi({ environment: 'mypurecloud.ie', accessToken: 'test', fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ settings: {} }) }; } });
  await api.get(); await api.put({ settings: { Open: PROFILE_PANEL } });
  assert.equal(calls[0].url, 'https://api.mypurecloud.ie/api/v2/apps/agentui/panels/settings');
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), { settings: { Open: PROFILE_PANEL } });
  const denied = panelSettingsApi({ accessToken: 'test', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(denied.get(), /Default Panels/);
  const malformed = panelSettingsApi({ accessToken: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ other: true }) }) });
  await assert.rejects(malformed.get(), /unsupported/);
});

test('old video configs preserve the existing Genesys default until a toggle is changed', () => {
  const config = parseWidgetConfig(DEFAULT_WIDGET_CONFIG);
  assert.equal(config.channels.video.genesys.autoOpen, null);
  config.channels.video.genesys.autoOpen = true;
  assert.equal(parseWidgetConfig(config).channels.video.genesys.autoOpen, true);
  assert.equal(publicWidgetConfig(config).channels.video.genesys, undefined);
  config.channels.video.genesys.autoOpen = 'true';
  assert.throws(() => parseWidgetConfig(config));
});
