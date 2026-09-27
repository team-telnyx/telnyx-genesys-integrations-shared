import { ensureWidgetOpenMessagingIntegration, listAllOpenMessagingIntegrations } from './widget-installer-resources.mjs';
import { publishWidgetMessageFlow } from './widget-message-flow.mjs';
import { widgetResourceBaseName } from './resource-naming.mjs';
import { normalizeTelnyxPublicKey } from "../telnyx/webhooks.mjs";
import { publicGenesysBaseUrl } from './audio-connector-config.mjs';

export const VIDEO_WIDGET_TYPE = 'embedded-client-app-interaction-widget';

export async function resolveVideoAccessGroups({ context, infrastructure }) {
  const sharedPanelId = infrastructure?.resources?.interactionWidgetId;
  // Read the agent panel's current visibility: the manifest's singular group is
  // the administration group and may no longer match agent access.
  const configured = sharedPanelId
    ? (await context.integrationsApi.getIntegrationConfigCurrent(sharedPanelId)).properties?.groups || []
    : infrastructure?.access?.groups || (infrastructure?.access?.group ? [infrastructure.access.group] : []);
  const ids = [...new Set(configured.map((group) => typeof group === 'string' ? group : group?.id).filter(Boolean))];
  if (!ids.length) throw new Error('Configure the Genesys agent interaction widget access groups before publishing video');
  return Promise.all(ids.map(async (id) => {
    const group = await context.groupsApi.getGroup(id);
    return { id: group.id, name: group.name };
  }));
}
export function videoWidgetConfiguration({ current = {}, name, baseUrl, groups, queueId }) {
  if (!groups?.length) throw new Error('At least one Genesys access group is required for video');
  if (!queueId) throw new Error('Select a Genesys Cloud video queue');
  const base = publicGenesysBaseUrl(baseUrl);
  return {
    id: current.id || 'current', name, version: current.version || 1,
    properties: {
      url: `${base}/genesys/video-widget?conversationId={{gcConversationId}}`,
      sandbox: 'allow-scripts,allow-same-origin,allow-forms,allow-modals,allow-popups,allow-presentation',
      permissions: 'camera,microphone,display-capture,fullscreen',
      communicationTypeFilter: 'open', queueIdFilterList: [queueId], groups: [...new Set(groups.map((group) => group.id))],
    },
    advanced: {
      lifecycle: { ephemeral: false, hooks: { focus: false, blur: false, bootstrap: false, stop: false } },
      icon: { vector: `${base}/video.svg` }, monochromicIcon: { vector: `${base}/video.svg` },
      i10n: { 'en-US': { name }, 'pl-PL': { name } },
    },
    notes: 'Telnyx Video Rooms for Genesys Cloud. Accept the Open Messaging interaction to join its video session.',
    credentials: current.credentials || {},
  };
}
async function listAll(load) {
  const result = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await load({ pageSize: 100, pageNumber });
    result.push(...(page.entities || []));
    if (!page.nextUri) return result;
  }
  throw new Error('Genesys inventory exceeded 100 pages');
}
function uniqueMatch(entries, name) {
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error(`More than one Genesys resource is named ${name}`);
  return matches[0] || null;
}
export async function ensureVideoInteractionWidget({ context, widget, config, baseUrl, groups, activate = true }) {
  const name = `${widgetResourceBaseName(widget)} - Video`;
  const queue = await context.routingApi.getRoutingQueue(config.channels.video.genesys.queueId);
  // Validate access before creating remote resources.
  if (!groups?.length) throw new Error('Configure the Genesys widget access groups before publishing video');
  for (const group of groups) await context.groupsApi.getGroup(group.id);
  const integrations = await listAll((options) => context.integrationsApi.getIntegrations({ ...options, integrationType: VIDEO_WIDGET_TYPE }));
  let integration = config.channels.video.genesys.widgetIntegrationId
    ? integrations.find((entry) => entry.id === config.channels.video.genesys.widgetIntegrationId)
    : uniqueMatch(integrations, name);
  if (!integration) integration = await context.integrationsApi.postIntegrations({ body: { name, integrationType: { id: VIDEO_WIDGET_TYPE } } });
  const current = await context.integrationsApi.getIntegrationConfigCurrent(integration.id);
  await context.integrationsApi.putIntegrationConfigCurrent(integration.id, { body: videoWidgetConfiguration({ current, name, baseUrl, groups, queueId: queue.id }) });
  await context.integrationsApi.patchIntegration(integration.id, { body: { intendedState: activate ? 'ENABLED' : 'DISABLED' } });
  return { id: integration.id, name, queue: { id: queue.id, name: queue.name }, autoOpen: 'queue-setting' };
}
export async function ensurePublishedWidgetVideo({ context, widget, config, baseUrl, groups, secret, activatePanel = true, publishFlow = publishWidgetMessageFlow, onProgress = () => {} }) {
  const video = config.channels.video;
  normalizeTelnyxPublicKey(process.env.TELNYX_PUBLIC_KEY);
  const queue = await context.routingApi.getRoutingQueue(video.genesys.queueId);
  if (!groups?.length) throw new Error('Configure the Genesys widget access groups before publishing video');
  for (const group of groups) await context.groupsApi.getGroup(group.id);
  if (String(secret || '').length < 32) throw new Error('Configure the Open Messaging webhook secret before publishing video');
  const name = `${widgetResourceBaseName(widget)} - Video`;
  const flowName = `${name} Routing`;
  const flows = await listAll((options) => context.architectApi.getFlows({ ...options, type: ['inboundshortmessage'], deleted: false }));
  const existingFlow = (video.genesys.flowId && flows.find((entry) => entry.id === video.genesys.flowId)) || uniqueMatch(flows, flowName);
  onProgress({ status: 'running', label: `Configure Genesys video routing: ${queue.name}` });
  const flow = await publishFlow({ environment: context.environment, accessToken: context.accessToken, flowName: existingFlow?.name || flowName, queues: [queue], existingFlow });
  const integrations = await listAllOpenMessagingIntegrations(context.conversationsApi);
  const integration = (await ensureWidgetOpenMessagingIntegration({ conversationsApi: context.conversationsApi, integrations,
    integrationId: video.genesys.integrationId || undefined, baseUrl, secret, name, allowRename: true })).integration;
  if (!integration.recipient?.id) throw new Error('Genesys video recipient is not ready');
  await context.routingApi.putRoutingMessageRecipient(integration.recipient.id, { flow: { id: flow.id } });
  const panel = await ensureVideoInteractionWidget({ context, widget, config, baseUrl, groups, activate: activatePanel });
  onProgress({ status: 'success', label: `Configure Genesys video routing: ${queue.name}`, detail: 'Video queue and agent panel ready' });
  return { integration, flow, panel, genesys: { queueId: queue.id, queueName: queue.name, integrationId: integration.id, flowId: flow.id, widgetIntegrationId: panel.id } };
}
