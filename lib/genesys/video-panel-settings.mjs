import { isDeepStrictEqual } from 'node:util';
import { genesysApiOrigin } from './api-origin.mjs';
import { VIDEO_WIDGET_TYPE, videoWidgetConfiguration } from './video-installer.mjs';

// Used by Genesys Panel Manager, but not exposed by the generated Platform SDK.
// Keep the adapter isolated: an unavailable API must fail publication explicitly.
export const VIDEO_PANEL_SETTINGS_PATH = '/api/v2/apps/agentui/panels/settings';
export const PROFILE_PANEL = Object.freeze({ type: 'BuiltInInterapption', panelId: 'external-contact-acd-profile-panel&builtInExternalContactsInterapptionsProvider' });
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

export function panelSettingsApi({ environment, accessToken, fetchImpl = fetch }) {
  async function request(method, body) {
    const response = await fetchImpl(`${genesysApiOrigin({ GC_ENVIRONMENT: environment })}${VIDEO_PANEL_SETTINGS_PATH}`, {
      method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw fail(response.status === 403
      ? 'The Genesys integration needs Agent UI > Default Panels > View and Edit permissions.'
      : `Genesys Panel Manager ${method} failed (${response.status}). The auto-open setting was not verified.`, response.status === 403 ? 403 : 502);
    const result = await response.json();
    if (!result?.settings || typeof result.settings !== 'object' || Array.isArray(result.settings)) throw fail('Genesys returned an unsupported Panel Manager configuration.');
    return result;
  }
  return { get: () => request('GET'), put: (body) => request('PUT', body) };
}

export function isInstallationVideoPanel(config, baseUrl) {
  try {
    const url = new URL(config?.properties?.url);
    return url.origin === new URL(baseUrl).origin && url.pathname === '/genesys/video-widget';
  } catch { return false; }
}

async function loadPanel(integrationsApi, id) {
  if (!id) return null;
  try {
    const [integration, config] = await Promise.all([
      integrationsApi.getIntegration(id), integrationsApi.getIntegrationConfigCurrent(id),
    ]);
    return { id, integration, config };
  } catch (error) { if (error.status === 404) return null; throw error; }
}

function matchesQueue(panel, queueId) {
  const properties = panel?.config?.properties || {};
  const types = String(properties.communicationTypeFilter || '').split(',').map(value => value.trim());
  return panel?.integration?.intendedState === 'ENABLED' && Boolean(properties.groups?.length)
    && (!properties.communicationTypeFilter || types.includes('open'))
    && (!properties.queueIdFilterList?.length || properties.queueIdFilterList.includes(queueId));
}

export async function readVideoPanelStatus({ settingsApi, integrationsApi, baseUrl, queueId }) {
  const settings = await settingsApi.get();
  const selected = settings.settings.Open;
  const panel = selected?.type === 'Integration' ? await loadPanel(integrationsApi, selected.panelId) : null;
  const owned = Boolean(panel && isInstallationVideoPanel(panel.config, baseUrl));
  return {
    enabled: owned && matchesQueue(panel, queueId),
    defaultPanel: panel?.integration?.name || (selected?.type === 'BuiltInInterapption' ? 'Genesys built-in panel' : 'No default panel'),
    replacesOtherPanel: Boolean(selected && !owned),
    nativeSizeSupported: false,
  };
}

export async function preserveVideoPanelDefaultBeforeUpdate({ panelId, ...options }) {
  const selected = (await options.settingsApi.get()).settings.Open;
  if (selected?.type !== 'Integration' || selected.panelId !== panelId) return null;
  const panel = await loadPanel(options.integrationsApi, panelId);
  if (!panel || !isInstallationVideoPanel(panel.config, options.baseUrl)) return null;
  const queueId = panel.config?.properties?.queueIdFilterList?.[0];
  if (!queueId) throw fail('The existing video default has no queue filter. Select its queues in Genesys before changing routing.', 409);
  if (!matchesQueue(panel, queueId)) return null;
  // Detach auto-opening from the widget's manual panel before that panel changes
  // queues or is deactivated. Otherwise changing routing would also enable the
  // new queue even though Studio showed its auto-open toggle as disabled.
  return configureVideoPanelQueue({ ...options, queueId, enabled: true });
}

// The setting is queue-wide. One shared default panel can match several video
// queues; each widget's original panel remains available for manual opening.
// The caller serializes changes and saves recovery state durably via `save`.
export async function configureVideoPanelQueue({ settingsApi, integrationsApi, baseUrl, groups, queueId, enabled, name, state = {}, save }) {
  if (!queueId || typeof enabled !== 'boolean') throw fail('Select a queue and an auto-open setting.', 400);
  if (!groups?.length) throw fail('Configure the agent panel access groups first.', 400);
  const initial = await settingsApi.get();
  const selected = initial.settings.Open;
  const selectedPanel = selected?.type === 'Integration' ? await loadPanel(integrationsApi, selected.panelId) : null;
  const currentVideo = selectedPanel && isInstallationVideoPanel(selectedPanel.config, baseUrl) ? selectedPanel : null;
  let managed = await loadPanel(integrationsApi, state.panelId);
  if (managed && managed.config?.properties?.url && !isInstallationVideoPanel(managed.config, baseUrl)) {
    throw fail('The managed video panel URL was changed in Genesys. Restore it before changing auto-open.', 409);
  }
  // A disabled toggle must not replace another integration's default.
  if (!enabled && !currentVideo && !managed) return { enabled: false, changed: false };
  const queuesOf = panel => {
    if (!panel) return [];
    const ids = panel.config?.properties?.queueIdFilterList;
    if (!ids?.length && panel.config?.properties?.url) throw fail('The existing video panel has no queue filter. Select its queues in Genesys before changing auto-open.', 409);
    return ids || [];
  };
  const managedQueues = managed?.integration?.intendedState === 'ENABLED' ? queuesOf(managed) : state.queueIds || [];
  const currentQueues = currentVideo?.integration?.intendedState === 'ENABLED' ? queuesOf(currentVideo) : [];
  const queues = new Set([...managedQueues, ...currentQueues]);
  if (enabled) queues.add(queueId); else queues.delete(queueId);
  const queueIds = [...queues].sort();
  const ownsDefault = Boolean(currentVideo);
  const previousOpenPanel = currentVideo
    ? state.previousOpenPanel || PROFILE_PANEL
    : enabled ? selected || PROFILE_PANEL : state.previousOpenPanel || PROFILE_PANEL;

  async function changeDefault(next) {
    const latest = await settingsApi.get();
    if (!isDeepStrictEqual(latest.settings.Open, selected)) throw fail('The Open Messaging default changed during publication. Refresh the video settings and publish again.', 409);
    if (!isDeepStrictEqual(latest.settings.Open, next)) await settingsApi.put({ ...latest, settings: { ...latest.settings, Open: next } });
    const verified = await settingsApi.get();
    if (!isDeepStrictEqual(verified.settings.Open, next)) throw fail('Genesys did not retain the requested default video panel.');
  }

  if (!queueIds.length) {
    if (ownsDefault) await changeDefault(previousOpenPanel);
    if (managed) await integrationsApi.patchIntegration(managed.id, { body: { intendedState: 'DISABLED' } });
    await save({ ...state, queueIds, previousOpenPanel });
    return { enabled: false, changed: true, queueIds };
  }

  if (!managed) {
    if (!enabled && !ownsDefault) return { enabled: false, changed: false };
    // Recovery after creation before saving state: reuse a unique named panel.
    const candidates = [];
    for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
      const page = await integrationsApi.getIntegrations({ integrationType: VIDEO_WIDGET_TYPE, pageSize: 100, pageNumber });
      candidates.push(...(page.entities || []).filter(item => item.name === name));
      if (!page.nextUri) break;
      if (pageNumber === 100) throw fail('Genesys integration inventory is too large.');
    }
    if (candidates.length > 1) throw fail('More than one automatic video panel has the same name.', 409);
    const integration = candidates[0] || await integrationsApi.postIntegrations({ body: { name, integrationType: { id: VIDEO_WIDGET_TYPE } } });
    managed = await loadPanel(integrationsApi, integration.id);
    if (!managed || (managed.config?.properties?.url && !isInstallationVideoPanel(managed.config, baseUrl))) throw fail('The automatic video panel name is already in use.', 409);
  }
  // Save the resource ID and original default before touching remote settings.
  // A failed publish can then retry without duplicating panels or losing restore data.
  await save({ panelId: managed.id, previousOpenPanel, queueIds });
  const body = videoWidgetConfiguration({ current: managed.config, name, baseUrl, groups, queueId: queueIds[0] });
  body.properties.queueIdFilterList = queueIds;
  await integrationsApi.putIntegrationConfigCurrent(managed.id, { body });
  const active = enabled || ownsDefault;
  await integrationsApi.patchIntegration(managed.id, { body: { intendedState: active ? 'ENABLED' : 'DISABLED' } });
  if (active) await changeDefault({ type: 'Integration', panelId: managed.id });
  const verifiedPanel = await loadPanel(integrationsApi, managed.id);
  if (!isDeepStrictEqual(verifiedPanel?.config?.properties?.queueIdFilterList, queueIds)
    || verifiedPanel?.config?.properties?.communicationTypeFilter !== 'open'
    || (active && verifiedPanel?.integration?.intendedState !== 'ENABLED')) throw fail('Genesys did not retain the requested video queue filter.');
  return { enabled: enabled && active, changed: true, panelId: managed.id, queueIds };
}
