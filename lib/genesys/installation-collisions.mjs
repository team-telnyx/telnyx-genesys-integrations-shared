import Telnyx from "telnyx";

import { listAllOpenMessagingIntegrations } from "./widget-installer-resources.mjs";
import { installationResourceNames } from "./installation-scope.mjs";

function resourceName(entry) {
  return String(entry?.display_name || entry?.name || "").trim();
}

function resourceId(entry) {
  return String(entry?.id || "").trim() || null;
}

function entry(type, resource, { owned = false, url = null } = {}) {
  return {
    type,
    id: resourceId(resource),
    name: resourceName(resource),
    owned,
    url,
  };
}

function relatedName(name) {
  const normalized = String(name || "").trim();
  const installationName = installationResourceNames().installationName;
  return normalized === installationName || normalized.startsWith(`${installationName} - `);
}

function currentClientApplicationUrl(config) {
  return String(config?.properties?.url || "").trim() || null;
}

function sameOriginUrl(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

async function listTelnyxAssistants(telnyx) {
  const assistants = [];
  let pageNumber = 1;
  let totalPages = 1;
  do {
    const response = await telnyx.ai.assistants.list({
      query: { page: { number: pageNumber, size: 100 } },
    });
    if (!Array.isArray(response?.data)) {
      throw new Error("Telnyx assistant collision scan returned an unexpected response");
    }
    assistants.push(...response.data);
    totalPages = Math.max(1, Number(response.meta?.total_pages || 1));
    pageNumber += 1;
  } while (pageNumber <= totalPages);
  return assistants;
}

async function listTelnyxTools(telnyx) {
  const tools = [];
  const listing = telnyx.ai.tools.list();
  if (listing?.[Symbol.asyncIterator]) {
    for await (const tool of listing) tools.push(tool);
  } else {
    const response = await listing;
    tools.push(...(response?.data || response || []));
  }
  return tools;
}

async function listArchitectFlows(architectApi) {
  const flows = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await architectApi.getFlows({
      pageNumber,
      pageSize: 100,
    });
    flows.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return flows;
  }
  throw new Error("Genesys flow collision scan exceeded 100 pages");
}

async function listGenesysIntegrations(integrationsApi, integrationType) {
  const integrations = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await integrationsApi.getIntegrations({
      pageNumber,
      pageSize: 100,
      integrationType,
    });
    integrations.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return integrations;
  }
  throw new Error(`Genesys ${integrationType} collision scan exceeded 100 pages`);
}

async function listGenesysScripts(scriptsApi) {
  const scripts = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await scriptsApi.getScripts({ pageNumber, pageSize: 100 });
    scripts.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return scripts;
  }
  throw new Error("Genesys script collision scan exceeded 100 pages");
}

export function analyzeInstallationCollisions({
  names,
  inventory = {},
  ownedIds = [],
  baseUrl = "",
} = {}) {
  const owned = new Set((ownedIds || []).map(String).filter(Boolean));
  const targets = new Map([
    ["Genesys group", new Set([names.adminGroup])],
    ["Genesys role", new Set([names.adminRole])],
    ["Genesys Client Application", new Set([
      names.adminClientApplication,
      names.audioInteractionWidget,
    ])],
    ["Genesys Audio Connector", new Set([names.installationName])],
    ["Genesys script", new Set([names.audioHandoffScript])],
    ["Genesys OAuth client", new Set([names.adminOauthClient])],
    ["Genesys Open Messaging", new Set([names.widgetOpenMessaging])],
    ["Genesys Architect flow", new Set([names.widgetMessageFlow, names.callbacks])],
    ["Telnyx assistant", new Set([names.installationName])],
    ["Telnyx tool", new Set([names.widgetHandoffTool, names.sharedHangupTool])],
  ]);
  const configuredOwned = (type, value) =>
    owned.has(resourceId(value)) && targets.get(type)?.has(resourceName(value));
  const resources = [
    ...(inventory.groups || []).map((value) => entry("Genesys group", value, { owned: configuredOwned("Genesys group", value) })),
    ...(inventory.roles || []).map((value) => entry("Genesys role", value, { owned: configuredOwned("Genesys role", value) })),
    ...(inventory.clientApplications || []).map((value) => {
      const url = currentClientApplicationUrl(value.config);
      return entry("Genesys Client Application", value, {
        owned: targets.get("Genesys Client Application")?.has(resourceName(value)) && (
          owned.has(resourceId(value)) || sameOriginUrl(url, baseUrl)
        ),
        url,
      });
    }),
    ...(inventory.audioConnectors || []).map((value) => entry(
      "Genesys Audio Connector",
      value,
      { owned: configuredOwned("Genesys Audio Connector", value) }
    )),
    ...(inventory.scripts || []).map((value) => entry("Genesys script", value, { owned: configuredOwned("Genesys script", value) })),
    ...(inventory.oauthClients || []).map((value) => entry("Genesys OAuth client", value, { owned: configuredOwned("Genesys OAuth client", value) })),
    ...(inventory.openMessaging || []).map((value) => entry("Genesys Open Messaging", value, { owned: configuredOwned("Genesys Open Messaging", value) })),
    ...(inventory.flows || []).map((value) => entry("Genesys Architect flow", value, { owned: configuredOwned("Genesys Architect flow", value) })),
    ...(inventory.telnyxAssistants || []).map((value) => entry("Telnyx assistant", value, { owned: configuredOwned("Telnyx assistant", value) })),
    ...(inventory.telnyxTools || []).map((value) => entry("Telnyx tool", value, { owned: configuredOwned("Telnyx tool", value) })),
  ].filter(({ name }) => name);

  const collisions = resources.filter((resource) =>
    !resource.owned && targets.get(resource.type)?.has(resource.name)
  );
  const related = resources.filter((resource) =>
    !collisions.includes(resource) && !resource.owned && relatedName(resource.name)
  );
  const ownedResources = resources.filter((resource) => resource.owned);
  return { collisions, related, owned: ownedResources, scanned: resources.length };
}

export async function inspectInstallationCollisions({
  context,
  names,
  baseUrl,
  telnyxApiKey,
  ownedIds = [],
} = {}) {
  const telnyx = new Telnyx({ apiKey: telnyxApiKey });
  const [
    oauthPage,
    openMessaging,
    flows,
    interactionWidgets,
    audioConnectors,
    scripts,
    telnyxAssistants,
    telnyxTools,
  ] = await Promise.all([
    context.oauthApi.getOauthClients(),
    listAllOpenMessagingIntegrations(context.conversationsApi),
    listArchitectFlows(context.architectApi),
    listGenesysIntegrations(
      context.integrationsApi,
      "embedded-client-app-interaction-widget"
    ),
    listGenesysIntegrations(context.integrationsApi, "audio-connector"),
    listGenesysScripts(context.scriptsApi),
    listTelnyxAssistants(telnyx),
    listTelnyxTools(telnyx),
  ]);
  const clientApplications = await Promise.all([
    ...(context.clientApplications || []),
    ...interactionWidgets,
  ].map(async (application) => {
    let config = null;
    try {
      config = await context.integrationsApi.getIntegrationConfigCurrent(application.id);
    } catch {
      // A disabled or partially provisioned application is still reported by
      // name; lack of config deliberately prevents treating it as owned.
    }
    return { ...application, config };
  }));
  return analyzeInstallationCollisions({
    names,
    baseUrl,
    ownedIds,
    inventory: {
      groups: context.groups,
      roles: context.roles,
      clientApplications,
      audioConnectors,
      scripts,
      oauthClients: oauthPage?.entities || [],
      openMessaging,
      flows,
      telnyxAssistants,
      telnyxTools,
    },
  });
}
