import { createHash } from "node:crypto";

import { normalizePublicApplicationOrigin } from "./public-origin-manager.mjs";
import { universalGenesysHandoffToolDefinition } from "./handoff-tool-definition.mjs";
import { installationResourceNames } from "./installation-scope.mjs";

const DEFAULT_NAMES = installationResourceNames();
export const WIDGET_ADMIN_ROLE_NAME = DEFAULT_NAMES.adminRole;
export const WIDGET_ADMIN_GROUP_NAME = DEFAULT_NAMES.adminGroup;
export const WIDGET_ADMIN_CLIENT_APP_NAME = DEFAULT_NAMES.adminClientApplication;
export const WIDGET_OPEN_MESSAGING_NAME = DEFAULT_NAMES.widgetOpenMessaging;
export const WIDGET_MESSAGING_SETTING_NAME = DEFAULT_NAMES.installationName;
export const WIDGET_CLIENT_APP_INTEGRATION_TYPE = "embedded-client-app";
export const WIDGET_HANDOFF_TOOL_DISPLAY_NAME = DEFAULT_NAMES.widgetHandoffTool;

const CLIENT_APP_SANDBOX = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-modals",
  "allow-popups",
].join(",");

export function widgetAdminUrl(baseUrl) {
  return `${normalizePublicApplicationOrigin(baseUrl)}/genesys/widget-admin`;
}

export function widgetOauthCallbackUrl(baseUrl) {
  return `${normalizePublicApplicationOrigin(baseUrl)}/api/auth/callback`;
}

export function widgetOpenMessagingWebhookUrl(baseUrl, integrationId) {
  const id = String(integrationId || "").trim();
  if (!id) throw new Error("Genesys Open Messaging integration ID is required");
  return `${normalizePublicApplicationOrigin(baseUrl)}/api/webhooks/genesys/open-messaging/${encodeURIComponent(id)}`;
}

export function widgetMessagingHandoffUrl(baseUrl) {
  return `${normalizePublicApplicationOrigin(baseUrl)}/api/widgets/handoff/messaging`;
}

function openMessagingStatus(integration) {
  return String(integration?.createStatus || integration?.status || "").trim().toLowerCase();
}

function openMessagingErrorDetail(integration) {
  return integration?.createError?.message ||
    integration?.createError?.status ||
    integration?.createError ||
    integration?.status ||
    "unknown provisioning error";
}

function isOpenMessagingProvisioningError(error) {
  const detail = [error?.message, error?.body, error?.response?.body]
    .map((value) => typeof value === "string" ? value : JSON.stringify(value || ""))
    .join(" ");
  return /create integration has not completed|integration.*(?:creating|pending|provision)/i.test(detail);
}

function typingDirectionEnabled(setting, direction) {
  return String(setting?.event?.typing?.on?.[direction] || "").toLowerCase() === "enabled";
}

export async function ensureWidgetTypingMessagingSetting({ conversationsApi }) {
  const listing = await conversationsApi.getConversationsMessagingSettings({
    pageSize: 100,
    pageNumber: 1,
  });
  let setting = (listing?.entities || []).find(
    (entry) => entry.name === WIDGET_MESSAGING_SETTING_NAME
  );
  const desired = {
    name: WIDGET_MESSAGING_SETTING_NAME,
    event: { typing: { on: { inbound: "Enabled", outbound: "Enabled" } } },
  };
  if (!setting) {
    return conversationsApi.postConversationsMessagingSettings(desired);
  }
  if (!typingDirectionEnabled(setting, "inbound") || !typingDirectionEnabled(setting, "outbound")) {
    setting = await conversationsApi.patchConversationsMessagingSetting(setting.id, desired);
  }
  return setting;
}

async function waitForOpenMessagingProvisioning({
  getIntegration,
  integration,
  maxAttempts = 60,
  delayMs = 1_000,
}) {
  if (!getIntegration) return integration;
  let current = integration;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    current = { ...current, ...(await getIntegration(integration.id) || {}) };
    const status = openMessagingStatus(current);
    if (current.createError || status === "failed" || status === "error") {
      throw new Error(
        `Genesys Open Messaging integration creation failed: ${openMessagingErrorDetail(current)}`
      );
    }
    if (
      current.recipient?.id ||
      ["complete", "completed", "succeeded", "active", "ready"].includes(status)
    ) {
      return current;
    }
  }
  throw new Error(
    `Genesys Open Messaging integration ${integration.id} did not finish provisioning within ${Math.ceil(maxAttempts * delayMs / 1000)} seconds`
  );
}

export function widgetHandoffSecretIdentifier(token) {
  const normalized = String(token || "").trim();
  if (normalized.length < 32) throw new Error("WIDGET_HANDOFF_API_KEY must contain at least 32 characters");
  return `genesys-widget-handoff-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export function widgetHandoffToolDefinition({
  baseUrl,
  integrationSecretIdentifier,
  queues = [],
  defaultQueue = null,
  displayName = WIDGET_HANDOFF_TOOL_DISPLAY_NAME,
  functionName,
  targetName,
}) {
  return universalGenesysHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier,
    queues,
    defaultQueue,
    displayName,
    functionName,
    targetName,
  });
}

export function widgetClientAppConfiguration({
  baseUrl,
  groupIds,
  current = {},
  name = WIDGET_ADMIN_CLIENT_APP_NAME,
}) {
  const groups = [...new Set((groupIds || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!groups.length) throw new Error("At least one Genesys access group is required");
  return {
    id: current.id || "current",
    name: current.name || name,
    version: current.version || 1,
    properties: {
      ...(current.properties || {}),
      displayType: "standalone",
      sandbox: CLIENT_APP_SANDBOX,
      url: widgetAdminUrl(baseUrl),
      groups,
    },
    advanced: {
      ...(current.advanced || {}),
      lifecycle: {
        ephemeral: false,
        hooks: { focus: false, blur: false, bootstrap: false, stop: false },
      },
      i10n: {
        ...current.advanced?.i10n,
        "en-US": { name },
        "pl-PL": { name },
      },
    },
    notes:
      "Administration of Telnyx AI messaging and WebRTC widgets. Authorization is verified server-side using the configured Genesys role.",
    credentials: current.credentials || {},
  };
}

export async function listAllGenesysGroups(groupsApi) {
  const groups = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await groupsApi.getGroups({ pageSize: 100, pageNumber });
    groups.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return groups;
  }
  throw new Error("Genesys group pagination exceeded 100 pages");
}

export async function ensureWidgetAccessGroup({
  groupsApi,
  existingGroups,
  name,
}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName || normalizedName.length > 100) {
    throw new Error("Genesys group name must contain between 1 and 100 characters");
  }
  const existing = exactSingleByName(existingGroups, normalizedName, "Genesys group");
  if (existing) return { group: existing, created: false };
  const group = await groupsApi.postGroups({
    name: normalizedName,
    description: "Access group created by the Telnyx AI Widget deployment manager",
    type: "official",
    rulesVisible: true,
    visibility: "public",
    rolesEnabled: true,
  });
  return { group, created: true };
}

export async function listAllGenesysQueues(routingApi) {
  const queues = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await routingApi.getRoutingQueues({ pageSize: 100, pageNumber });
    queues.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return queues;
  }
  throw new Error("Genesys queue pagination exceeded 100 pages");
}

export async function listAllGenesysRoles(authorizationApi) {
  const roles = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await authorizationApi.getAuthorizationRoles({
      pageSize: 100,
      pageNumber,
      userCount: true,
    });
    roles.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return roles;
  }
  throw new Error("Genesys role pagination exceeded 100 pages");
}

export async function listAllOpenMessagingIntegrations(conversationsApi) {
  const integrations = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await conversationsApi.getConversationsMessagingIntegrationsOpen({
      pageSize: 100,
      pageNumber,
    });
    integrations.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return integrations;
  }
  throw new Error("Genesys Open Messaging pagination exceeded 100 pages");
}

function exactSingleByName(entries, name, type) {
  const matches = (entries || []).filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error(`More than one ${type} is named ${name}`);
  return matches[0] || null;
}

export async function ensureWidgetAdminRole({
  authorizationApi,
  existingRoles,
  roleId,
  name = WIDGET_ADMIN_ROLE_NAME,
}) {
  let existing = roleId
    ? (existingRoles || []).find((role) => role.id === roleId)
    : exactSingleByName(existingRoles, name, "Genesys role");
  if (roleId && !existing) throw new Error(`Configured Genesys widget role ${roleId} was not found`);
  if (existing) {
    if (existing.name !== name) {
      throw new Error(`Genesys role ${existing.id} is named ${existing.name}; expected ${name}`);
    }
    return { role: existing, created: false };
  }
  const role = await authorizationApi.postAuthorizationRoles({
    name,
    description:
      "Grants access to the Telnyx AI Widget administration application. Application API authorization remains server-side.",
    permissions: [],
    permissionPolicies: [],
  });
  return { role, created: true };
}

export async function ensureWidgetRoleGroupGrant({
  authorizationApi,
  roleId,
  groupIds,
  divisionId,
}) {
  const subjects = [...new Set((groupIds || []).map(String).map((value) => value.trim()).filter(Boolean))];
  if (!subjects.length) throw new Error("At least one Genesys group is required for the widget role");
  if (!divisionId) throw new Error("Genesys home division ID is required");
  await authorizationApi.postAuthorizationRole(
    roleId,
    { subjectIds: subjects, divisionIds: [divisionId] },
    { subjectType: "PC_GROUP" }
  );
  return { roleId, groupIds: subjects, divisionId };
}

export async function ensureWidgetClientApplication({
  integrationsApi,
  integrations,
  integrationId,
  baseUrl,
  groupIds,
  name = WIDGET_ADMIN_CLIENT_APP_NAME,
  activate = true,
}) {
  let integration = integrationId
    ? (integrations || []).find((entry) => entry.id === integrationId)
    : exactSingleByName(integrations, name, "Genesys Client Application");
  if (integrationId && !integration) {
    integration = await integrationsApi.getIntegration(integrationId);
  }
  if (integration && integration.integrationType?.id !== WIDGET_CLIENT_APP_INTEGRATION_TYPE) {
    throw new Error(
      `Genesys integration ${integration.id} has type ${integration.integrationType?.id || "unknown"}; expected ${WIDGET_CLIENT_APP_INTEGRATION_TYPE}`
    );
  }
  if (integration && integration.name !== name) {
    throw new Error(`Genesys Client Application ${integration.id} is named ${integration.name}; expected ${name}`);
  }
  const created = !integration;
  if (!integration) {
    integration = await integrationsApi.postIntegrations({
      body: { name, integrationType: { id: WIDGET_CLIENT_APP_INTEGRATION_TYPE } },
    });
  }
  const current = await integrationsApi.getIntegrationConfigCurrent(integration.id);
  const config = widgetClientAppConfiguration({ baseUrl, groupIds, current, name });
  await integrationsApi.putIntegrationConfigCurrent(integration.id, { body: config });
  if (activate && integration.intendedState !== "ENABLED") {
    integration = await integrationsApi.patchIntegration(integration.id, {
      body: { intendedState: "ENABLED" },
    });
  }
  return { integration, config, created };
}

export async function ensureWidgetOpenMessagingIntegration({
  conversationsApi,
  integrations,
  integrationId,
  baseUrl,
  secret,
  name = WIDGET_OPEN_MESSAGING_NAME,
  supportedContent,
  allowRename = false,
}) {
  const token = String(secret || "").trim();
  if (token.length < 32) {
    throw new Error("GC_OPEN_MESSAGING_SECRET must contain at least 32 characters");
  }
  let integration = integrationId
    ? (integrations || []).find((entry) => entry.id === integrationId)
    : exactSingleByName(integrations, name, "Genesys Open Messaging integration");
  if (integrationId && !integration) {
    try {
      integration = await conversationsApi.getConversationsMessagingIntegrationsOpenIntegrationId(
        integrationId
      );
    } catch (error) {
      const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
      if (status !== 404) throw error;
      integration = null;
    }
  }
  if (integration && integration.name !== name && !allowRename) {
    throw new Error(`Open Messaging integration ${integration.id} is named ${integration.name}; expected ${name}`);
  }
  const typingSetting = typeof conversationsApi.getConversationsMessagingSettings === "function"
    ? await ensureWidgetTypingMessagingSetting({ conversationsApi })
    : null;
  const created = !integration;
  if (!integration) {
    // The outbound webhook contains the integration ID, which does not exist
    // before creation. Create with a valid placeholder on the same origin and
    // immediately patch the final integration-scoped URL.
    integration = await conversationsApi.postConversationsMessagingIntegrationsOpen({
      name,
      ...(supportedContent ? { supportedContent } : {}),
      ...(typingSetting?.id ? { messagingSetting: { id: typingSetting.id } } : {}),
      outboundNotificationWebhookUrl:
        `${normalizePublicApplicationOrigin(baseUrl)}/api/webhooks/genesys/open-messaging/pending`,
      outboundNotificationWebhookSignatureSecretToken: token,
    });
  }
  const getIntegration =
    conversationsApi.getConversationsMessagingIntegrationsOpenIntegrationId?.bind(
      conversationsApi
    );
  integration = await waitForOpenMessagingProvisioning({
    getIntegration,
    integration,
  });
  const body = {
    name,
    supportedContent: supportedContent || integration.supportedContent,
    messagingSetting: typingSetting?.id ? { id: typingSetting.id } : integration.messagingSetting,
    outboundNotificationWebhookUrl: widgetOpenMessagingWebhookUrl(baseUrl, integration.id),
    outboundNotificationWebhookSignatureSecretToken: token,
    webhookHeaders: integration.webhookHeaders || {},
  };
  let updated;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      updated = await conversationsApi.patchConversationsMessagingIntegrationsOpenIntegrationId(
        integration.id,
        body
      );
      break;
    } catch (error) {
      if (!isOpenMessagingProvisioningError(error) || !getIntegration || attempt === 29) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      integration = await waitForOpenMessagingProvisioning({
        getIntegration,
        integration,
        maxAttempts: 1,
        delayMs: 0,
      }).catch((waitError) => {
        if (/did not finish provisioning/.test(waitError.message)) return integration;
        throw waitError;
      });
    }
  }
  let readyIntegration = { ...integration, ...body, ...(updated || {}) };

  // Genesys may return before an Open Messaging integration has finished its
  // asynchronous creation. The inbound recipient is needed by Message
  // Routing, so do not hand an incomplete object to the installer when the SDK
  // exposes the integration status endpoint.
  if (!readyIntegration.recipient?.id && getIntegration) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const current = await getIntegration(integration.id);
      readyIntegration = { ...readyIntegration, ...(current || {}) };
      const status = String(
        readyIntegration.createStatus || readyIntegration.status || ""
      ).toLowerCase();
      if (readyIntegration.createError || status === "failed" || status === "error") {
        const detail =
          readyIntegration.createError?.message ||
          readyIntegration.createError?.status ||
          readyIntegration.createError ||
          readyIntegration.status;
        throw new Error(`Genesys Open Messaging integration creation failed: ${detail}`);
      }
      if (readyIntegration.recipient?.id) break;
    }
  }

  if (!readyIntegration.recipient?.id && getIntegration) {
    throw new Error(
      `Genesys Open Messaging integration ${integration.id} did not expose an inbound recipient within 20 seconds`
    );
  }
  return { integration: readyIntegration, created };
}
