import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import platformClient from "purecloud-platform-client-v2";
import {
  GENESYS_AUDIO_HANDOFF_SCRIPT_NAME,
  GENESYS_AUDIO_WIDGET_NAME,
  publicGenesysBaseUrl,
} from "../lib/genesys/audio-connector-config.mjs";
import { GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS } from "../lib/genesys/oauth-settings.mjs";

const SCRIPT_NAME = GENESYS_AUDIO_HANDOFF_SCRIPT_NAME;
const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../genesys/scripts/telnyx-ai-handoff-summary.script"
);
const WIDGET_NAME = GENESYS_AUDIO_WIDGET_NAME;
const WIDGET_PATH = "/genesys/ai-conversation-widget";
export const INTERACTION_WIDGET_TYPE = "embedded-client-app-interaction-widget";
// Genesys names conversations delivered through an Open Messaging integration
// `open`. `message` is not a valid interaction-widget communication type and
// makes PUT /integrations/{id}/config/current fail with "Input validation error".
export const INTERACTION_WIDGET_COMMUNICATION_TYPES = "call,open";
const SCRIPT_LOGO_URL_TOKEN = "__TELNYX_LOGO_URL__";
const HANDOFF_SCRIPT_FIELDS = Object.freeze([
  ["Intent", "{{0ca57e1e-7fd4-4472-9ca9-238f0910091e}}"],
  ["Sentiment", "{{58f1d985-c0fd-4076-b099-286147fef4b3}}"],
  ["Handoff reason", "{{635922da-bcc6-4cc4-83b8-c5fa493b83f8}}"],
  ["Target queue", "{{8da18bf2-a3fb-40ce-a248-283509cf7d22}}"],
  ["Channel", "{{b09cd019-3afc-4c95-a40f-545e13b15f3b}}"],
  ["Telnyx correlation", "{{231b724d-bc4b-4412-ad74-01fa1e64cb94}}"],
]);

function required(name, fallback) {
  const value = String(process.env[name] || fallback || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function appBaseUrl() {
  return publicGenesysBaseUrl();
}

function appsBaseUrl(environment) {
  return `https://apps.${environment}`;
}

function genesysApiErrorDetail(error) {
  const body = error?.body || error?.response?.body || error?.response?.data;
  return String(
    body?.errors?.[0]?.detail ||
    body?.errors?.[0]?.message ||
    body?.message ||
    error?.message ||
    error
  );
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function handoffScriptText({ text, bold, width }) {
  return {
    type: "text",
    properties: {
      margin: { typeName: "spacing", value: 0 },
      alignment: { typeName: "alignment", value: "center" },
      width: { typeName: "sizing", value: width },
      height: { typeName: "sizing", value: { sizeType: "auto" } },
      visible: { typeName: "variable" },
      preserveLayoutLocation: { typeName: "boolean", value: false },
      text: { typeName: "interpolatedText", value: text },
      bold: { typeName: "boolean", value: bold },
      italic: { typeName: "boolean", value: false },
      underline: { typeName: "boolean", value: false },
      font: { typeName: "font", value: "Arial, \"Helvetica Neue\", Helvetica, sans-serif" },
      fontSize: { typeName: "integer", value: 12 },
      justification: { typeName: "text", value: "left" },
      backgroundColor: { typeName: "null" },
      textColor: { typeName: "color", value: "#334155" },
      padding: { typeName: "spacing", value: 0 },
    },
  };
}

function handoffScriptFieldRow(label, value, last) {
  return {
    type: "horizontalStackContainer",
    properties: {
      margin: { typeName: "spacing", value: [0, 0, last ? 0 : 10, 0] },
      alignment: { typeName: "alignment", value: "center" },
      width: { typeName: "sizing", value: { sizeType: "stretch", size: 100 } },
      height: { typeName: "sizing", value: { sizeType: "auto" } },
      visible: { typeName: "variable" },
      preserveLayoutLocation: { typeName: "boolean", value: false },
      backgroundColor: { typeName: "null" },
      padding: { typeName: "spacing", value: [6, 0] },
      childArrangement: { typeName: "childArrangement", value: "start" },
      border: { typeName: "border", value: { width: 0, style: "solid", color: "#ffffff" } },
    },
    children: [
      handoffScriptText({
        text: label,
        bold: true,
        width: { sizeType: "pixels", size: 150 },
      }),
      handoffScriptText({
        text: value,
        bold: false,
        width: { sizeType: "stretch", size: 100 },
      }),
    ],
  };
}

export async function renderGenesysAiHandoffScript(baseUrl = appBaseUrl()) {
  const template = await readFile(SCRIPT_PATH, "utf8");
  const occurrences = template.split(SCRIPT_LOGO_URL_TOKEN).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Genesys handoff script must contain exactly one ${SCRIPT_LOGO_URL_TOKEN} token`);
  }
  const logoUrl = `${publicGenesysBaseUrl(baseUrl)}/telnyx_logo_black.png`;
  const script = JSON.parse(template.replace(SCRIPT_LOGO_URL_TOKEN, logoUrl));
  const children = script.pages?.[0]?.rootContainer?.children;
  if (!Array.isArray(children)) throw new Error("Genesys handoff script root container is missing");
  const fieldByValue = new Map(HANDOFF_SCRIPT_FIELDS.map(([label, value], index) => [
    value,
    handoffScriptFieldRow(label, value, index === HANDOFF_SCRIPT_FIELDS.length - 1),
  ]));
  script.pages[0].rootContainer.children = children.map((control) => {
    const text = String(control?.properties?.text?.value || "");
    const field = HANDOFF_SCRIPT_FIELDS.find(([, value]) => text.includes(value));
    return field ? fieldByValue.get(field[1]) : control;
  });
  return `${JSON.stringify(script, null, 2)}\n`;
}

async function listScriptsByName(scriptsApi, name) {
  const [editable, published] = await Promise.all([
    scriptsApi.getScripts({ pageSize: 100, pageNumber: 1, name }),
    scriptsApi.getScriptsPublished({ pageSize: 100, pageNumber: 1, name }),
  ]);
  const byId = new Map();
  for (const script of [...(editable.entities || []), ...(published.entities || [])]) {
    if (script.name === name && script.id) byId.set(script.id, script);
  }
  return [...byId.values()];
}

export async function ensureGenesysAiHandoffScript({
  environment,
  accessToken,
  scriptsApi,
  scriptName = SCRIPT_NAME,
  baseUrl = appBaseUrl(),
}) {
  const existing = await listScriptsByName(scriptsApi, scriptName);
  if (existing.length > 1) {
    throw new Error(`More than one Genesys script is named ${scriptName}`);
  }

  const body = new FormData();
  body.set(
    "file",
    new Blob([await renderGenesysAiHandoffScript(baseUrl)], { type: "application/json" }),
    "telnyx-ai-handoff-summary.script"
  );
  body.set("scriptName", scriptName);
  if (existing[0]?.id) body.set("scriptIdToReplace", existing[0].id);

  const uploadResponse = await fetch(`${appsBaseUrl(environment)}/uploads/v2/scripter`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body,
  });
  const upload = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !upload?.correlationId) {
    throw new Error(
      `Genesys script upload failed (${uploadResponse.status}): ${
        upload?.message || upload?.error || "missing correlation ID"
      }`
    );
  }

  let status;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(1500);
    status = await scriptsApi.getScriptsUploadStatus(upload.correlationId, {
      longPoll: false,
    });
    if (status?.succeeded === true) break;
    if (status?.succeeded === false && status?.errors?.length) {
      throw new Error(`Genesys rejected the script: ${JSON.stringify(status.errors)}`);
    }
  }
  if (status?.succeeded !== true) {
    throw new Error(`Genesys script upload did not complete: ${upload.correlationId}`);
  }

  const uploaded = await listScriptsByName(scriptsApi, scriptName);
  if (uploaded.length !== 1) {
    throw new Error(`Could not uniquely resolve uploaded Genesys script ${scriptName}`);
  }
  await scriptsApi.postScriptsPublished({
    scriptDataVersion: "0",
    body: { scriptId: uploaded[0].id },
  });
  const published = await listScriptsByName(scriptsApi, scriptName);
  return published[0];
}

function managedQuickTunnelCallback(value) {
  try {
    const url = new URL(String(value || ""));
    return (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname) &&
      url.pathname === "/api/auth/callback" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function oauthRedirectUrisForBaseUrl(currentUris, baseUrl) {
  const callbackUrl = `${publicGenesysBaseUrl(baseUrl)}/api/auth/callback`;
  const retained = (Array.isArray(currentUris) ? currentUris : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => !managedQuickTunnelCallback(value) || value === callbackUrl);
  return [...new Set([...retained, callbackUrl])];
}

export async function ensureWidgetOauthRedirectUri(
  oauthApi,
  clientId,
  baseUrl,
  { requiredScopes = [] } = {}
) {
  const callbackUrl = `${publicGenesysBaseUrl(baseUrl)}/api/auth/callback`;
  const client = await oauthApi.getOauthClient(clientId);
  if (client.authorizedGrantType !== "CODE") {
    throw new Error(
      `Genesys OAuth client ${clientId} must use the Code Authorization grant for the widget`
    );
  }
  const registeredRedirectUri = oauthRedirectUrisForBaseUrl(
    client.registeredRedirectUri,
    baseUrl
  );
  const scope = [...new Set([
    ...(Array.isArray(client.scope) ? client.scope : []),
    ...(Array.isArray(requiredScopes) ? requiredScopes : []),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const accessTokenValiditySeconds = GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS;
  if (
    JSON.stringify(registeredRedirectUri) ===
      JSON.stringify(client.registeredRedirectUri || []) &&
    JSON.stringify(scope) === JSON.stringify(client.scope || []) &&
    Number(client.accessTokenValiditySeconds) === accessTokenValiditySeconds
  ) {
    return { updated: false, callbackUrl, client };
  }
  const body = {
    name: client.name,
    authorizedGrantType: client.authorizedGrantType,
    registeredRedirectUri,
    scope,
    accessTokenValiditySeconds,
  };
  for (const field of [
    "roleIds",
    "allowedIPAddresses",
  ]) {
    if (client[field] !== undefined && client[field] !== null) body[field] = client[field];
  }
  const updated = await oauthApi.putOauthClient(clientId, body);
  return {
    updated: true,
    callbackUrl,
    client: updated,
  };
}

async function findExactGroups(groupsApi, selected) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await groupsApi.getGroups({ pageSize: 100, pageNumber });
    entities.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) break;
  }
  return selected.map(({ id, name }) => {
    const group = entities.find((candidate) => candidate.id === id);
    if (!group) throw new Error(`Genesys group ${name} (${id}) was not found`);
    if (group.name !== name) {
      throw new Error(`Genesys group ${id} changed name from ${name} to ${group.name}`);
    }
    return group;
  });
}

async function findExactQueues(routingApi, names) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await routingApi.getRoutingQueues({ pageSize: 100, pageNumber });
    entities.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) break;
  }
  return names.map((name) => {
    const queue = entities.find((candidate) => candidate.name === name);
    if (!queue) throw new Error(`Genesys queue ${name} was not found`);
    return queue;
  });
}

function selectedQueueNames(queuesJson) {
  let names;
  try {
    names = JSON.parse(String(queuesJson || "[]"));
  } catch {
    throw new Error("--queues-json must be a JSON array");
  }
  if (!Array.isArray(names) || !names.length || names.some((name) => !String(name).trim())) {
    throw new Error("--queues-json must contain the queues selected by the installer");
  }
  return [...new Set(names.map((name) => String(name).trim()))];
}

export function selectedGroups(groupsJson) {
  let groups;
  try {
    groups = JSON.parse(String(groupsJson || "[]"));
  } catch {
    throw new Error("--groups-json must be a JSON array");
  }
  if (
    !Array.isArray(groups) ||
    !groups.length ||
    groups.some((group) => !String(group?.id || "").trim() || !String(group?.name || "").trim())
  ) {
    throw new Error("--groups-json must contain the groups selected by the installer");
  }
  const byId = new Map(
    groups.map((group) => [String(group.id).trim(), {
      id: String(group.id).trim(),
      name: String(group.name).trim(),
    }])
  );
  return [...byId.values()];
}

export async function ensureGenesysAiInteractionWidget({
  integrationsApi,
  groupsApi,
  routingApi,
  activate,
  queuesJson,
  groupsJson,
  widgetName = WIDGET_NAME,
  baseUrl = appBaseUrl(),
}) {
  const listing = await integrationsApi.getIntegrations({
    pageSize: 100,
    pageNumber: 1,
    integrationType: INTERACTION_WIDGET_TYPE,
  });
  let integration = (listing.entities || []).find(
    (candidate) => candidate.name === widgetName
  );
  const created = !integration;
  if (!integration) {
    integration = await integrationsApi.postIntegrations({
      body: {
        name: widgetName,
        integrationType: { id: INTERACTION_WIDGET_TYPE },
      },
    });
  }

  const selectedGroupReferences = selectedGroups(groupsJson);
  const queueNames = selectedQueueNames(queuesJson);
  const [groups, queues, current] = await Promise.all([
    findExactGroups(groupsApi, selectedGroupReferences),
    findExactQueues(routingApi, queueNames),
    integrationsApi.getIntegrationConfigCurrent(integration.id),
  ]);

  const normalizedBaseUrl = publicGenesysBaseUrl(baseUrl);
  const widgetUrl = `${normalizedBaseUrl}${WIDGET_PATH}?conversationId={{gcConversationId}}`;
  const iconUrl = `${normalizedBaseUrl}/telnyx_logo_black.png`;
  const groupIds = [...new Set([
    ...((current.properties?.groups || []).map((id) => String(id || "").trim())),
    ...groups.map((group) => group.id),
  ].filter(Boolean))];
  const queueIds = [...new Set([
    ...((current.properties?.queueIdFilterList || []).map((id) => String(id || "").trim())),
    ...queues.map((queue) => queue.id),
  ].filter(Boolean))];
  let config;
  try {
    config = await integrationsApi.putIntegrationConfigCurrent(integration.id, {
      body: {
        id: current.id || "current",
        name: current.name || widgetName,
        version: current.version || 1,
        properties: {
          ...(current.properties || {}),
          sandbox:
            "allow-scripts,allow-same-origin,allow-forms,allow-modals,allow-popups,allow-presentation,allow-downloads",
          communicationTypeFilter: INTERACTION_WIDGET_COMMUNICATION_TYPES,
          groups: groupIds,
          queueIdFilterList: queueIds,
          url: widgetUrl,
        },
        advanced: {
          lifecycle: {
            ephemeral: false,
            hooks: { focus: false, blur: false, bootstrap: false, stop: false },
          },
          icon: { vector: iconUrl },
          monochromicIcon: { vector: iconUrl },
          i10n: {
            "en-US": { name: widgetName },
            "pl-PL": { name: widgetName },
          },
        },
        notes:
          "Telnyx AI handoff conversation, insights, metadata, dynamic variables and costs",
        credentials: current.credentials || {},
      },
    });
  } catch (error) {
    throw new Error(
      `Genesys interaction widget configuration failed: ${genesysApiErrorDetail(error)}`,
      { cause: error }
    );
  }

  if (activate) {
    integration = await integrationsApi.patchIntegration(integration.id, {
      body: { intendedState: "ENABLED" },
    });
  } else if (created && integration.intendedState !== "DISABLED") {
    integration = await integrationsApi.patchIntegration(integration.id, {
      body: { intendedState: "DISABLED" },
    });
  }

  return {
    id: integration.id,
    name: integration.name,
    intendedState: activate ? "ENABLED" : integration.intendedState,
    url: config.properties?.url || widgetUrl,
    groups: groups.map(({ id, name }) => ({ id, name })),
    queues: queues.map(({ id, name }) => ({ id, name })),
  };
}

async function provision({
  activateWidget,
  queuesJson,
  groupsJson,
  resourceName,
  scriptName,
  widgetName,
  widgetOnly = false,
}) {
  const environment = required("GC_ENVIRONMENT");
  const targetName = String(resourceName || WIDGET_NAME).trim();
  if (!targetName) throw new Error("--resource-name cannot be empty");
  const targetScriptName = String(scriptName || targetName).trim();
  const targetWidgetName = String(widgetName || targetName).trim();
  const apiClient = platformClient.ApiClient.instance;
  apiClient.setEnvironment(environment);
  const authData = await apiClient.loginClientCredentialsGrant(
    required("GC_CLIENT_CRED_CLIENT_ID"),
    required("GC_CLIENT_CRED_CLIENT_SECRET")
  );
  const accessToken = authData?.accessToken || apiClient.authData?.accessToken;
  if (!accessToken) throw new Error("Genesys access token was not returned");

  const oauth = await ensureWidgetOauthRedirectUri(
    new platformClient.OAuthApi(),
    required("GC_CLIENT_ID"),
    appBaseUrl()
  );
  const script = widgetOnly
    ? null
    : await ensureGenesysAiHandoffScript({
        environment,
        accessToken,
        scriptsApi: new platformClient.ScriptsApi(),
        scriptName: targetScriptName,
      });
  const widget = await ensureGenesysAiInteractionWidget({
    integrationsApi: new platformClient.IntegrationsApi(),
    groupsApi: new platformClient.GroupsApi(),
    routingApi: new platformClient.RoutingApi(),
    activate: activateWidget,
    queuesJson,
    groupsJson,
    widgetName: targetWidgetName,
  });
  return {
    script: script
      ? { id: script.id, name: script.name, versionId: script.versionId || null }
      : null,
    widget,
    oauth: { clientId: required("GC_CLIENT_ID"), callbackUrl: oauth.callbackUrl, updated: oauth.updated },
  };
}

function cliOption(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? String(argv[index + 1] || "").trim() : "";
}

async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  if (args.has("--help") || !args.has("--apply")) {
    console.log(
      "Usage: node --env-file=.env scripts/provision-genesys-ai-agent-experience.mjs --apply --queues-json=<json> --groups-json=<json> [--activate-widget]\n" +
        "Imports and publishes the native handoff summary script and configures the light-only interaction widget."
    );
    process.exitCode = args.has("--help") ? 0 : 2;
    return;
  }
  const result = await provision({
    activateWidget: args.has("--activate-widget"),
    queuesJson: cliOption(argv, "queues-json"),
    groupsJson: cliOption(argv, "groups-json"),
    resourceName: cliOption(argv, "resource-name"),
    scriptName: cliOption(argv, "script-name"),
    widgetName: cliOption(argv, "widget-name"),
    widgetOnly: args.has("--widget-only"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      JSON.stringify({ status: error?.status || error?.response?.status, error: error?.message })
    );
    process.exitCode = 1;
  });
}
