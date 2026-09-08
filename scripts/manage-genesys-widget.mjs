import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import platformClient from "purecloud-platform-client-v2";
import Telnyx from "telnyx";

import {
  getQuickTunnelStatus,
  isCloudflareQuickTunnelUrl,
  startCloudflareQuickTunnel,
  stopCloudflareQuickTunnel,
} from "../lib/genesys/cloudflare-quick-tunnel.mjs";
import { saveInstallerEnvironmentValues } from "../lib/genesys/installer-environment.mjs";
import {
  encryptedSecretStoreConfigured,
  hydrateRuntimeSecrets,
  partitionManagedRuntimeValues,
  saveEncryptedRuntimeSecrets,
} from "../lib/genesys/encrypted-secret-store.mjs";
import {
  checkPostgresStatus,
  isPostgresConfigured,
} from "../lib/postgres.mjs";
import { ensurePostgresSchema } from "../lib/postgres-schema.mjs";
import {
  verifyGenesysPlatformAccess,
  verifyTelnyxPlatformAccess,
} from "../lib/genesys/platform-preflight.mjs";
import {
  normalizePublicApplicationOrigin,
  synchronizeAllManagedDeploymentUrls,
  updateManagedPublicOrigin,
} from "../lib/genesys/public-origin-manager.mjs";
import {
  ensureWidgetAccessGroup,
  ensureWidgetAdminRole,
  ensureWidgetClientApplication,
  ensureWidgetOpenMessagingIntegration,
  ensureWidgetRoleGroupGrant,
  listAllGenesysGroups,
  listAllGenesysQueues,
  listAllGenesysRoles,
  listAllOpenMessagingIntegrations,
  WIDGET_CLIENT_APP_INTEGRATION_TYPE,
  widgetAdminUrl,
  widgetHandoffSecretIdentifier,
  widgetHandoffToolDefinition,
  widgetOpenMessagingWebhookUrl,
} from "../lib/genesys/widget-installer-resources.mjs";
import { installationResourceNames } from "../lib/genesys/installation-scope.mjs";
import {
  registerManagedAgentExperience,
  registerManagedResourceBatch,
} from "../lib/genesys/managed-resource-registry.mjs";
import {
  widgetResourceBaseName,
  widgetVoiceQueueFunctionName,
} from "../lib/genesys/resource-naming.mjs";
import { GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS } from "../lib/genesys/oauth-settings.mjs";
import {
  publishWidgetMessageFlow,
  widgetMessageFlowSupportsAgentExperience,
} from "../lib/genesys/widget-message-flow.mjs";
import { publishWidgetVoiceFlow } from "../lib/genesys/widget-voice-flow.mjs";
import {
  ensureWidgetVoiceDidPool,
  ensureWidgetVoiceIvrRoute,
} from "../lib/genesys/widget-voice-routing.mjs";
import {
  deleteManagedWidgetRecord,
  ensureManagedWidgetRecord,
} from "../lib/widgets/deployment-store.mjs";
import {
  deleteWidgetVoiceDidAllocation,
  reserveWidgetVoiceDid,
  updateWidgetVoiceDidAllocation,
  WIDGET_VOICE_DID_NAMESPACE_END,
  WIDGET_VOICE_DID_NAMESPACE_START,
} from "../lib/widgets/voice-did-allocation.mjs";
import {
  hardenGenesysSdkClient,
  normalizeGenesysEnvironment,
} from "../lib/genesys/tts-connector-genesys.mjs";
import {
  ensureGenesysAiHandoffScript,
  ensureGenesysAiInteractionWidget,
  ensureWidgetOauthRedirectUri,
} from "./provision-genesys-ai-agent-experience.mjs";
import { hangupToolDefinition } from "./provision-telnyx-genesys-assistant.mjs";
import {
  ADMIN_SHARED_HANDOFF_TOOL_KEY,
  ADMIN_SHARED_HANGUP_TOOL_KEY,
  ADMIN_SHARED_INVITE_TOOL_KEY,
  ADMIN_SHARED_SKIP_TURN_TOOL_KEY,
  ADMIN_SIP_TRANSFER_TOOL_KEY,
  ADMIN_VOICE_QUEUE_TOOL_KEY,
  getAdminManagedTool,
  registerAdminManagedTelnyxTool,
} from "../lib/genesys/admin-managed-tools.mjs";
import {
  ensureAdminManagedInsightProfile,
  trackAdminAssistantInsightAssignment,
} from "../lib/genesys/admin-managed-insights.mjs";
import {
  assistantSharedToolIds,
  attachedGenesysHandoffTools,
  findSharedGenesysHandoffTool,
  mergeGenesysHandoffQueues,
  reconciledAssistantToolIds,
  telnyxToolDefinition,
  telnyxToolDisplayName,
  telnyxToolFunctionName,
  findTelnyxToolByName,
  telnyxToolId,
} from "../lib/genesys/handoff-tool-definition.mjs";
import {
  attachedGenesysCallHandoffTools,
  attachedTransferTools,
  findMatchingTransferTool,
  genesysSipInviteToolDefinition,
  genesysSipTransferToolDefinition,
  genesysSkipTurnToolDefinition,
  genesysVoiceQueueToolDefinition,
  normalizeGenesysSipUri,
  normalizeTelnyxWebCallerNumber,
  TELNYX_END_USER_TARGET_TEMPLATE,
} from "../lib/genesys/sip-transfer-tool.mjs";
import {
  buildGenesysSipUri,
  loadGenesysDidPools,
  loadGenesysSipInventory,
  resolveGenesysByocTrunk,
} from "../lib/genesys/sip-destination.mjs";
import {
  upsertGenesysUniversalHandoffInstructions,
} from "../lib/genesys/handoff-assistant-instructions.mjs";

export const GENESYS_WIDGET_STATE_DIRECTORY = ".genesys-widget";
export const PRIMARY_WIDGET_INFRASTRUCTURE_ID = "WEBCHAT";
export const PRIMARY_WIDGET_INFRASTRUCTURE_NAME = installationResourceNames().installationName;
export const PRIMARY_WIDGET_MESSAGE_FLOW_NAME = installationResourceNames().widgetMessageFlow;
export const WIDGET_SECRET_VARIABLES = Object.freeze([
  "WIDGET_SESSION_SIGNING_SECRET",
  "WIDGET_HANDOFF_API_KEY",
  "GC_OPEN_MESSAGING_SECRET",
]);
export const WIDGET_INSTALLER_VARIABLES = Object.freeze([
  "GC_INSTALLATION_KEY",
  "GC_INSTALLATION_NAME",
  "GC_ENVIRONMENT",
  "GC_CLIENT_ID",
  "GC_CLIENT_SECRET",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "GC_ORGANIZATION_ID",
  "GC_WIDGET_ADMIN_GROUP_ID",
  "GC_WIDGET_ADMIN_ROLE_ID",
  "GC_PUBLIC_BASE_URL",
  "GC_OPEN_MESSAGING_SECRET",
  "GC_OPEN_MESSAGING_SECRETS_JSON",
  "TELNYX_API_KEY",
  "TELNYX_WIDGET_CALLER_NUMBER",
  "WIDGET_SESSION_SIGNING_SECRET",
  "WIDGET_HANDOFF_API_KEY",
  "GENESYS_HANDOFF_API_KEY",
  "DATABASE_URL",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "PGSSLMODE",
]);

const REQUIRED_BOOTSTRAP_VARIABLES = Object.freeze([
  "GC_ENVIRONMENT",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "TELNYX_API_KEY",
]);
const MASKED_VARIABLES = new Set([
  "GC_CLIENT_SECRET",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "TELNYX_API_KEY",
  "POSTGRES_PASSWORD",
  "GENESYS_HANDOFF_API_KEY",
  ...WIDGET_SECRET_VARIABLES,
]);

function stateDirectory(options = {}) {
  return path.resolve(String(options["state-dir"] || GENESYS_WIDGET_STATE_DIRECTORY));
}

function required(name, environment = process.env) {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function csv(value) {
  return [...new Set(String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function widgetDeploymentName(applicationName, deploymentId) {
  const base = String(applicationName || "Widget").trim();
  if (!base || base.length > 120) throw new Error("Widget deployment name must contain 1-120 characters");
  // The deployment ID remains the immutable state key, but is deliberately not
  // exposed in user-facing resource names.
  if (deploymentId && !/^[A-F0-9]{6}$/i.test(String(deploymentId).trim())) {
    throw new Error("Widget deployment ID must contain 6 hexadecimal characters");
  }
  return widgetResourceBaseName(base);
}

function widgetDeploymentResourceNames(
  deploymentName,
  installationNames = installationResourceNames()
) {
  return {
    clientApplication: installationNames.adminClientApplication,
    role: installationNames.adminRole,
    openMessaging: deploymentName,
    messageFlow: deploymentName,
    voiceFlow: deploymentName,
    voiceIvr: deploymentName,
    voiceDidPool: deploymentName,
    telnyxHandoffTool: installationNames.widgetHandoffTool,
    sharedHangupTool: installationNames.sharedHangupTool,
    audioHandoffScript: installationNames.audioHandoffScript,
    audioInteractionWidget: installationNames.audioInteractionWidget,
    telnyxTransferTool: deploymentName,
    telnyxVoiceQueueTool: deploymentName,
    assistant: deploymentName,
  };
}

function databaseConfigurationPresent(environment = process.env) {
  return isPostgresConfigured(environment);
}

export function missingWidgetConfiguration(environment = process.env) {
  const missing = [
    ...REQUIRED_BOOTSTRAP_VARIABLES,
    "GC_PUBLIC_BASE_URL",
    ...WIDGET_SECRET_VARIABLES,
  ].filter((name) => !String(environment[name] || "").trim());
  if (!databaseConfigurationPresent(environment)) missing.push("DATABASE_URL or POSTGRES_* variables");
  return missing;
}

export function generateWidgetSecrets(names = WIDGET_SECRET_VARIABLES) {
  const requested = new Set(names);
  const generated = Object.fromEntries(
    WIDGET_SECRET_VARIABLES
      .filter((name) => requested.has(name))
      .map((name) => [name, randomBytes(32).toString("hex")])
  );
  if (generated.WIDGET_HANDOFF_API_KEY) {
    generated.GENESYS_HANDOFF_API_KEY = generated.WIDGET_HANDOFF_API_KEY;
  }
  return generated;
}

function widgetHandoffApiKey(environment = process.env) {
  return required(
    environment.GENESYS_HANDOFF_API_KEY ? "GENESYS_HANDOFF_API_KEY" : "WIDGET_HANDOFF_API_KEY",
    environment
  );
}

export async function saveWidgetEnvironmentValues({
  values,
  environment = process.env,
  envFile = path.resolve(".env"),
  replaceNames = [],
} = {}) {
  if (!encryptedSecretStoreConfigured(environment)) {
    return saveInstallerEnvironmentValues({
      values,
      allowedNames: WIDGET_INSTALLER_VARIABLES,
      replaceNames,
      environment,
      envFile,
    });
  }
  const { managed, plaintext } = partitionManagedRuntimeValues(values);
  if (Object.keys(managed).length) {
    await saveEncryptedRuntimeSecrets(managed);
    Object.assign(environment, managed);
  }
  if (!Object.keys(plaintext).length) {
    return { saved: Object.keys(managed), envFile: "encrypted PostgreSQL secret store" };
  }
  const saved = await saveInstallerEnvironmentValues({
    values: plaintext,
    allowedNames: WIDGET_INSTALLER_VARIABLES,
    replaceNames,
    environment,
    envFile,
  });
  return { ...saved, saved: [...Object.keys(managed), ...saved.saved] };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export async function listManagedWidgetDeployments({ options = {} } = {}) {
  const directory = path.join(stateDirectory(options), "deployments");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const deployments = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directory, entry.name);
    const deployment = JSON.parse(await readFile(filePath, "utf8"));
    if (deployment.schemaVersion !== 1 || !deployment.deployment?.id) {
      throw new Error(`Unsupported managed widget deployment manifest ${filePath}`);
    }
    deployments.push({ ...deployment, filePath });
  }
  return deployments.sort((left, right) => left.deployment.id.localeCompare(right.deployment.id));
}

export async function readWidgetInfrastructureManifest({ options = {} } = {}) {
  const filePath = path.join(stateDirectory(options), "infrastructure.json");
  try {
    const manifest = JSON.parse(await readFile(filePath, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.deployment?.id !== PRIMARY_WIDGET_INFRASTRUCTURE_ID) {
      throw new Error(`Unsupported Web Chat infrastructure manifest ${filePath}`);
    }
    return { ...manifest, filePath };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function listClientApplications(integrationsApi) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await integrationsApi.getIntegrations({
      pageSize: 100,
      pageNumber,
      integrationType: WIDGET_CLIENT_APP_INTEGRATION_TYPE,
    });
    entries.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error("Genesys Client Application pagination exceeded 100 pages");
}

export async function listInboundMessageFlows(architectApi, { includeUnpublished = false } = {}) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await architectApi.getFlows({
      // Architect exposes the UI's "Inbound Message" flow type under its
      // historical Public API enum name INBOUNDSHORTMESSAGE.
      type: ["INBOUNDSHORTMESSAGE"],
      pageSize: 100,
      pageNumber,
      deleted: false,
    });
    entries.push(...(page.entities || []).filter(
      (flow) => includeUnpublished || Boolean(flow.publishedVersion?.id)
    ));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error("Genesys inbound message flow pagination exceeded 100 pages");
}

async function listInboundCallFlows(architectApi, { includeUnpublished = false } = {}) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await architectApi.getFlows({
      type: ["INBOUNDCALL"],
      pageSize: 100,
      pageNumber,
      deleted: false,
    });
    entries.push(...(page.entities || []).filter(
      (flow) => includeUnpublished || Boolean(flow.publishedVersion?.id)
    ));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error("Genesys inbound call flow pagination exceeded 100 pages");
}

async function connectGenesysWidget() {
  const environment = normalizeGenesysEnvironment(required("GC_ENVIRONMENT"));
  const apiClient = platformClient.ApiClient.instance;
  hardenGenesysSdkClient(apiClient);
  apiClient.setEnvironment(environment);
  apiClient.timeout = 30_000;
  const auth = await apiClient.loginClientCredentialsGrant(
    required("GC_CLIENT_CRED_CLIENT_ID"),
    required("GC_CLIENT_CRED_CLIENT_SECRET")
  );
  if (!(auth?.accessToken || apiClient.authData?.accessToken)) {
    throw new Error("Genesys access token was not returned");
  }
  const organizationApi = new platformClient.OrganizationApi();
  const authorizationApi = new platformClient.AuthorizationApi();
  const integrationsApi = new platformClient.IntegrationsApi();
  const conversationsApi = new platformClient.ConversationsApi();
  const groupsApi = new platformClient.GroupsApi();
  const routingApi = new platformClient.RoutingApi();
  const architectApi = new platformClient.ArchitectApi();
  const telephonyApi = new platformClient.TelephonyProvidersEdgeApi();
  const oauthApi = new platformClient.OAuthApi();
  const scriptsApi = new platformClient.ScriptsApi();
  const [organization, homeDivision, roles, clientApplications, openMessaging, groups, queues, allMessageFlows] =
    await Promise.all([
      organizationApi.getOrganizationsMe(),
      authorizationApi.getAuthorizationDivisionsHome(),
      listAllGenesysRoles(authorizationApi),
      listClientApplications(integrationsApi),
      listAllOpenMessagingIntegrations(conversationsApi),
      listAllGenesysGroups(groupsApi),
      listAllGenesysQueues(routingApi),
      listInboundMessageFlows(architectApi, { includeUnpublished: true }),
    ]);
  return {
    accessToken: auth?.accessToken || apiClient.authData?.accessToken,
    environment,
    organization,
    homeDivision,
    authorizationApi,
    integrationsApi,
    conversationsApi,
    groupsApi,
    routingApi,
    architectApi,
    telephonyApi,
    oauthApi,
    scriptsApi,
    roles,
    clientApplications,
    openMessaging,
    groups,
    queues,
    allMessageFlows,
    messageFlows: allMessageFlows.filter((flow) => Boolean(flow.publishedVersion?.id)),
  };
}

function exactResources(context, { groupIds, queueIds, allowNoGroups = false }) {
  const groups = groupIds.map((id) => {
    const group = context.groups.find((entry) => entry.id === id);
    if (!group) throw new Error(`Genesys group ${id} was not found`);
    if (group.type && String(group.type).toLowerCase() !== "official") {
      throw new Error(`Genesys group ${group.name} (${id}) must be an official group`);
    }
    return { id: group.id, name: group.name };
  });
  if (!groups.length && !allowNoGroups) throw new Error("At least one --group-id is required");
  const queues = queueIds.map((id) => {
    const queue = context.queues.find((entry) => entry.id === id);
    if (!queue) throw new Error(`Genesys queue ${id || "(missing)"} was not found`);
    return { id: queue.id, name: queue.name };
  });
  if (!queues.length) throw new Error("Select at least one Genesys handoff queue");
  return { groups, queues };
}

function namedResource(entries, name, type) {
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error(`More than one ${type} is named ${name}`);
  return matches[0] || null;
}

export async function createWidgetInstallationPlan({
  options = {},
  context: suppliedContext,
} = {}) {
  const context = suppliedContext || await connectGenesysWidget();
  const publicBaseUrl = normalizePublicApplicationOrigin(options.url || process.env.GC_PUBLIC_BASE_URL);
  const requestedAllowedOrigins = csv(options["allowed-origin"] || options["allowed-origins"]);
  if (!requestedAllowedOrigins.length) {
    throw new Error("At least one customer website embedding origin is required");
  }
  const allowedOrigins = addWidgetAdministrationOrigin(
    parseAllowedOrigins(requestedAllowedOrigins.join(",")),
    publicBaseUrl
  );
  const deploymentId = String(options.id || randomBytes(3).toString("hex")).toUpperCase();
  const deploymentName = widgetDeploymentName(
    options.name || "Telnyx AI Widget",
    deploymentId
  );
  const installationNames = installationResourceNames();
  const resourceNames = widgetDeploymentResourceNames(deploymentName, installationNames);
  const createGroupNames = csv(options["create-group-name"]);
  const selected = exactResources(context, {
    groupIds: csv(options["group-id"] || options.groups),
    queueIds: csv(options["queue-id"] || options["queue-ids"]),
    allowNoGroups: createGroupNames.length > 0,
  });
  const messageFlowId = String(options["message-flow-id"] || "").trim();
  const messageFlow = messageFlowId
    ? context.messageFlows.find((flow) => flow.id === messageFlowId)
    : null;
  if (messageFlowId && !messageFlow) {
    throw new Error(`Genesys inbound message flow ${messageFlowId} was not found`);
  }
  const assistantId = String(options["messaging-assistant-id"] || "").trim();
  const createAssistant = options["create-assistant"] === true || !assistantId;
  const voiceEnabled = options["enable-voice"] === true || ["1", "true", "yes"]
    .includes(String(options["enable-voice"] || "").trim().toLowerCase());
  const requestedVoiceAssistantId = String(options["voice-assistant-id"] || "").trim();
  const voiceAssistantUsesMessaging = !requestedVoiceAssistantId || (
    !createAssistant && requestedVoiceAssistantId === assistantId
  );
  let sipDestination = null;
  let genesysSipUri = null;
  if (voiceEnabled) {
    const trunkId = String(options["genesys-trunk-id"] || "").trim();
    if (trunkId) {
      const inventory = context.sipInventory || await loadGenesysSipInventory({
        telephonyApi: context.telephonyApi,
        architectApi: context.architectApi,
        environment: context.environment,
      });
      const trunk = resolveGenesysByocTrunk(inventory, trunkId);
      sipDestination = {
        mode: "managed-did",
        trunk,
        namespace: {
          start: WIDGET_VOICE_DID_NAMESPACE_START,
          end: WIDGET_VOICE_DID_NAMESPACE_END,
          allocation: "first-free-single-number-pool",
        },
      };
    } else {
      genesysSipUri = normalizeGenesysSipUri(options["genesys-sip-uri"]);
      sipDestination = { mode: "manual", genesysSipUri };
    }
  }
  const webCallerNumber = voiceEnabled
    ? normalizeTelnyxWebCallerNumber(
        options["web-caller-number"] ||
        options["voice-transfer-from"] ||
        process.env.TELNYX_WIDGET_CALLER_NUMBER
      )
    : null;
  const voiceRegion = String(options["voice-region"] || "auto").trim();
  if (![
    "auto", "eu", "us-east", "us-central", "us-west", "ca-central", "apac", "south-asia",
  ].includes(voiceRegion)) {
    throw new Error(`Unsupported --voice-region: ${voiceRegion}`);
  }
  const role = namedResource(context.roles, installationNames.adminRole, "Genesys role");
  const clientApp = namedResource(
    context.clientApplications,
    installationNames.adminClientApplication,
    "Genesys Client Application"
  );
  const openMessaging = namedResource(
    context.openMessaging,
    resourceNames.openMessaging,
    "Genesys Open Messaging integration"
  );
  const plan = {
    schemaVersion: 2,
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    environment: context.environment,
    organization: { id: context.organization.id, name: context.organization.name },
    publicBaseUrl,
    deployment: {
      id: deploymentId,
      applicationName: String(options.name || "Telnyx AI Widget").trim(),
      name: deploymentName,
    },
    access: {
      groups: selected.groups,
      createGroups: createGroupNames.map((name) => ({ name })),
    },
    messaging: {
      queues: selected.queues,
      assistant: {
        operation: createAssistant ? "create-or-update-managed" : "reuse",
        id: createAssistant ? null : assistantId,
        name: createAssistant ? resourceNames.assistant : null,
      },
      routingFlow: messageFlow
        ? { operation: "reuse", id: messageFlow.id, name: messageFlow.name }
        : { operation: "create-or-update-managed", id: null, name: resourceNames.messageFlow },
      allowedOrigins,
    },
    voice: {
      enabled: voiceEnabled,
      assistant: voiceEnabled
        ? {
            operation: voiceAssistantUsesMessaging ? "same-as-messaging" : "reuse",
            id: voiceAssistantUsesMessaging ? null : requestedVoiceAssistantId,
          }
        : null,
      assistantId: voiceAssistantUsesMessaging ? null : requestedVoiceAssistantId,
      assistantVersionId: String(options["voice-assistant-version-id"] || "main").trim() || "main",
      genesysSipUri,
      sipDestination,
      callerNumber: webCallerNumber,
      transferFrom: voiceEnabled ? TELNYX_END_USER_TARGET_TEMPLATE : null,
      transferTargetName: String(options["voice-transfer-target-name"] || "Genesys Cloud").trim(),
      region: voiceRegion,
      routingFlow: voiceEnabled && sipDestination?.mode === "managed-did"
        ? { operation: "create-or-update-managed", id: null, name: resourceNames.voiceFlow }
        : null,
    },
    resources: {
      role: { operation: role ? "reuse" : "create", id: role?.id || null, name: installationNames.adminRole },
      oauthClient: {
        operation: process.env.GC_CLIENT_ID ? "reuse-and-update" : "create",
        id: process.env.GC_CLIENT_ID || null,
      },
      clientApplication: {
        operation: clientApp ? "reuse-and-update" : "create",
        id: clientApp?.id || null,
        name: installationNames.adminClientApplication,
        url: widgetAdminUrl(publicBaseUrl),
      },
      openMessaging: {
        operation: openMessaging ? "reuse-and-update" : "create",
        id: openMessaging?.id || null,
        name: resourceNames.openMessaging,
        outboundWebhookUrl: openMessaging
          ? widgetOpenMessagingWebhookUrl(publicBaseUrl, openMessaging.id)
          : null,
      },
      voiceDidPool: voiceEnabled && sipDestination?.mode === "managed-did"
        ? { operation: "create-or-update-managed", id: null, name: resourceNames.voiceDidPool }
        : null,
      voiceIvr: voiceEnabled && sipDestination?.mode === "managed-did"
        ? { operation: "create-or-update-managed", id: null, name: resourceNames.voiceIvr }
        : null,
      telnyxHandoffTool: {
        operation: "create-or-update-managed",
        name: resourceNames.telnyxHandoffTool,
      },
      telnyxTransferTool: voiceEnabled
        ? { operation: "create-or-update-managed", name: resourceNames.telnyxTransferTool }
        : null,
      telnyxVoiceQueueTool: voiceEnabled
        ? {
            operation: "create-or-update-managed",
            name: resourceNames.telnyxVoiceQueueTool,
            functionName: widgetVoiceQueueFunctionName({ publicId: deploymentId }),
          }
        : null,
      widget: { operation: "create-or-update-managed", name: deploymentName },
    },
    resourceNames,
  };
  const outputPath = path.join(stateDirectory(options), "plans", `${plan.planId}.json`);
  await writeJsonAtomic(outputPath, plan);
  return { plan, outputPath };
}

function predefinedWidgetAccess(context, environment = process.env) {
  const names = installationResourceNames(environment);
  const groupId = String(environment.GC_WIDGET_ADMIN_GROUP_ID || "").trim();
  const roleId = String(environment.GC_WIDGET_ADMIN_ROLE_ID || "").trim();
  const group = groupId
    ? context.groups.find((entry) => entry.id === groupId)
    : namedResource(context.groups, names.adminGroup, "Genesys group");
  if (!group) {
    throw new Error(
      `${names.adminGroup}${groupId ? ` (${groupId})` : ""} is missing; rerun genesys:deploy`
    );
  }
  if (group.name !== names.adminGroup) {
    throw new Error(
      `Genesys group ${groupId} is named ${group.name}; expected ${names.adminGroup}`
    );
  }
  const role = roleId
    ? context.roles.find((entry) => entry.id === roleId)
    : namedResource(context.roles, names.adminRole, "Genesys role");
  if (!role) {
    throw new Error(
      `${names.adminRole}${roleId ? ` (${roleId})` : ""} is missing; rerun genesys:deploy`
    );
  }
  if (role.name !== names.adminRole) {
    throw new Error(
      `Genesys role ${roleId} is named ${role.name}; expected ${names.adminRole}`
    );
  }
  return {
    group: { id: group.id, name: group.name },
    role: { id: role.id, name: role.name },
  };
}

function exactWidgetInfrastructureQueues(context, queueIds, defaultQueueId) {
  const queues = [...new Set(queueIds || [])].map((id) => {
    const queue = context.queues.find((entry) => entry.id === id);
    if (!queue) throw new Error(`Genesys queue ${id || "(missing)"} was not found`);
    return { id: queue.id, name: queue.name };
  });
  if (!queues.length) throw new Error("Select at least one Genesys handoff queue");
  const defaultQueue = queues.find((queue) => queue.id === defaultQueueId);
  if (!defaultQueue) {
    throw new Error("Default Genesys queue must be selected in the global allowlist");
  }
  return { queues, defaultQueue };
}

export async function createWidgetInfrastructurePlan({
  queueIds = [],
  defaultQueueId = "",
  managedHandoffTool = null,
  context: suppliedContext,
  telnyx: suppliedTelnyx,
  options = {},
} = {}) {
  const context = suppliedContext || await connectGenesysWidget();
  const names = installationResourceNames();
  const publicBaseUrl = normalizePublicApplicationOrigin(process.env.GC_PUBLIC_BASE_URL);
  const access = predefinedWidgetAccess(context);
  const policy = exactWidgetInfrastructureQueues(context, queueIds, defaultQueueId);
  const flow = namedResource(
    context.allMessageFlows || context.messageFlows,
    names.widgetMessageFlow,
    "Genesys inbound message flow"
  );
  const openMessaging = namedResource(
    context.openMessaging,
    names.widgetOpenMessaging,
    "Genesys Open Messaging integration"
  );
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const infrastructure = await readWidgetInfrastructureManifest({ options });
  const { listManagedAudioDeployments } = await import("./manage-genesys-audio.mjs");
  const audioDeployments = await listManagedAudioDeployments({ options });
  const preferredToolIds = [
    managedHandoffTool?.remoteToolId,
    infrastructure?.resources?.telnyxHandoffToolId,
    ...audioDeployments.map((deployment) => deployment.resources?.toolId),
  ];
  const handoffTool = await findSharedGenesysHandoffTool(telnyx, {
    preferredToolIds,
    displayName: names.widgetHandoffTool,
  });
  const currentRecipient = openMessaging?.recipient?.id
    ? await context.routingApi.getRoutingMessageRecipient(openMessaging.recipient.id).catch(() => null)
    : null;
  const deployedQueueIds = (infrastructure?.messaging?.queues || []).map(({ id }) => id).sort();
  const desiredQueueIds = policy.queues.map(({ id }) => id).sort();
  const queuePolicyChanged = Boolean(
    !infrastructure ||
    JSON.stringify(deployedQueueIds) !== JSON.stringify(desiredQueueIds) ||
    infrastructure.messaging?.defaultQueue?.id !== policy.defaultQueue.id
  );
  const flowPublished = Boolean(flow?.publishedVersion?.id || flow?.publishedVersion);
  const agentExperienceChanged = Boolean(
    !widgetMessageFlowSupportsAgentExperience(flow) ||
    !infrastructure?.resources?.scriptId ||
    !infrastructure?.resources?.interactionWidgetId
  );
  const publicUrlChanged = Boolean(infrastructure?.publicBaseUrl !== publicBaseUrl);
  const openMessagingChanged = Boolean(
    !openMessaging ||
    openMessaging.outboundNotificationWebhookUrl !== widgetOpenMessagingWebhookUrl(publicBaseUrl, openMessaging.id)
  );
  const recipientChanged = Boolean(
    !currentRecipient ||
    currentRecipient.flow?.id !== flow?.id
  );
  const changes = {
    isCreate: !infrastructure,
    queuePolicyChanged,
    agentExperienceChanged,
    architectFlowChanged: !flow || !flowPublished || queuePolicyChanged || agentExperienceChanged,
    openMessagingChanged,
    recipientChanged,
    handoffToolChanged: !handoffTool || queuePolicyChanged || publicUrlChanged,
    manifestChanged: !infrastructure || queuePolicyChanged || publicUrlChanged || openMessagingChanged || recipientChanged || !handoffTool || agentExperienceChanged,
  };
  changes.hasChanges = Object.entries(changes).some(([key, changed]) => key !== "isCreate" && changed);
  const plan = {
    schemaVersion: 1,
    planId: randomUUID(),
    operation: "widget-infrastructure",
    createdAt: new Date().toISOString(),
    environment: context.environment,
    organization: { id: context.organization.id, name: context.organization.name },
    changes,
    publicBaseUrl,
    deployment: {
      id: PRIMARY_WIDGET_INFRASTRUCTURE_ID,
      applicationName: names.widgetInfrastructure,
      name: names.widgetInfrastructure,
    },
    access,
    messaging: {
      queues: policy.queues,
      defaultQueue: policy.defaultQueue,
      routingFlow: {
        operation: "create-or-update-managed",
        id: flow?.id || null,
        name: names.widgetMessageFlow,
      },
    },
    resources: {
      openMessaging: {
        operation: "ensure",
        id: openMessaging?.id || null,
        name: names.widgetOpenMessaging,
      },
      telnyxHandoffTool: {
        operation: handoffTool ? "ensure" : "create",
        id: handoffTool ? telnyxToolId(handoffTool) : null,
        name: names.widgetHandoffTool,
        functionName: "request_genesys_human_handoff",
        registryId: managedHandoffTool?.id || null,
      },
      handoffScript: { name: names.audioHandoffScript },
      interactionWidget: { name: names.audioInteractionWidget },
    },
    installation: {
      key: names.installationKey,
      name: names.installationName,
    },
  };
  const outputPath = path.join(stateDirectory(options), "plans", `${plan.planId}.json`);
  await writeJsonAtomic(outputPath, plan);
  return { plan, outputPath };
}

function sharedHandoffToolMatches(tool, definition) {
  const current = telnyxToolDefinition(tool);
  const currentQueues = current?.webhook?.body_parameters?.properties?.queue_name?.enum || [];
  const desiredQueues = definition.webhook.body_parameters.properties.queue_name.enum || [];
  return Boolean(
    current &&
    telnyxToolDisplayName(tool) === definition.display_name &&
    current.webhook?.name === definition.webhook.name &&
    current.webhook?.url === definition.webhook.url &&
    current.webhook?.method === definition.webhook.method &&
    desiredQueues.every((name) => currentQueues.includes(name))
  );
}

export async function applyWidgetInfrastructurePlan(planPath, {
  context: suppliedContext,
  telnyx: suppliedTelnyx,
  options = {},
  onProgress = () => {},
} = {}) {
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8"));
  if (plan.schemaVersion !== 1 || plan.operation !== "widget-infrastructure") {
    throw new Error("Unsupported Web Chat infrastructure plan; create a new plan");
  }
  const context = suppliedContext || await runWidgetDeploymentStep({
    ordinal: 0,
    onProgress,
    label: "Load current Genesys Web Chat infrastructure inventory",
    operation: connectGenesysWidget,
    successDetail: "loaded",
  });
  const changes = plan.changes || {
    architectFlowChanged: true,
    openMessagingChanged: true,
    recipientChanged: true,
    handoffToolChanged: true,
    manifestChanged: true,
  };
  const access = await runWidgetDeploymentStep({
    ordinal: 0,
    onProgress,
    label: "Validate the predefined Genesys administrator group and role",
    operation: async () => {
      assertPlanContext(plan, context);
      const current = predefinedWidgetAccess(context);
      if (current.group.id !== plan.access.group.id || current.role.id !== plan.access.role.id) {
        throw new Error("Predefined Genesys administrator access changed after plan review");
      }
      return current;
    },
    successDetail: `${plan.access.group.name} · ${plan.access.role.name}`,
  });
  const policy = await runWidgetDeploymentStep({
    ordinal: 0,
    onProgress,
    label: "Validate the global Genesys handoff queue policy",
    operation: async () => exactWidgetInfrastructureQueues(
      context,
      plan.messaging.queues.map(({ id }) => id),
      plan.messaging.defaultQueue.id
    ),
    successDetail: ({ queues, defaultQueue }) =>
      `${queues.map(({ name }) => name).join(", ")} · default ${defaultQueue.name}`,
  });
  const handoffScript = await runWidgetDeploymentStep({
    ordinal: 1,
    onProgress,
    label: `Ensure Genesys handoff script for messaging: ${plan.resources.handoffScript.name}`,
    operation: () => ensureGenesysAiHandoffScript({
      environment: context.environment,
      accessToken: context.accessToken,
      scriptsApi: context.scriptsApi,
      scriptName: plan.resources.handoffScript.name,
      baseUrl: plan.publicBaseUrl,
    }),
    successDetail: (result) => `published · ${result.id}`,
  });
  const existingFlow = (context.allMessageFlows || context.messageFlows).find((entry) =>
    entry.id === plan.messaging.routingFlow.id || entry.name === plan.messaging.routingFlow.name
  );
  const messageFlow = await runWidgetDeploymentStep({
    ordinal: 1,
    onProgress,
    label: `${changes.architectFlowChanged ? "Publish" : "Reuse"} shared Genesys Architect flow: ${plan.messaging.routingFlow.name}`,
    operation: () => changes.architectFlowChanged
      ? publishWidgetMessageFlow({
        environment: context.environment,
        accessToken: context.accessToken,
        flowName: plan.messaging.routingFlow.name,
        queues: policy.queues,
        existingFlow,
        handoffScriptId: handoffScript.id,
      })
      : existingFlow,
    successDetail: (result) => changes.architectFlowChanged
      ? `${existingFlow ? "updated" : "created"} and published · ${result.id}`
      : `unchanged · ${result.id}`,
  });
  const interactionWidget = await runWidgetDeploymentStep({
    ordinal: 2,
    onProgress,
    label: `Enable the Genesys interaction widget for calls and messages: ${plan.resources.interactionWidget.name}`,
    operation: () => ensureGenesysAiInteractionWidget({
      integrationsApi: context.integrationsApi,
      groupsApi: context.groupsApi,
      routingApi: context.routingApi,
      activate: true,
      queuesJson: JSON.stringify(policy.queues.map(({ name }) => name)),
      groupsJson: JSON.stringify([access.group]),
      widgetName: plan.resources.interactionWidget.name,
      baseUrl: plan.publicBaseUrl,
    }),
    successDetail: (result) => `enabled for call,open · ${result.id}`,
  });
  const openMessaging = await runWidgetDeploymentStep({
    ordinal: 3,
    onProgress,
    label: `Ensure shared Genesys Open Messaging integration: ${plan.resources.openMessaging.name}`,
    operation: () => changes.openMessagingChanged
      ? ensureWidgetOpenMessagingIntegration({
        conversationsApi: context.conversationsApi,
        integrations: context.openMessaging,
        integrationId: plan.resources.openMessaging.id,
        baseUrl: plan.publicBaseUrl,
        secret: required("GC_OPEN_MESSAGING_SECRET"),
        name: plan.resources.openMessaging.name,
      })
      : {
        integration: context.openMessaging.find((entry) => entry.id === plan.resources.openMessaging.id),
        created: false,
      },
    successDetail: ({ integration, created }) =>
      `${created ? "created" : changes.openMessagingChanged ? "reconciled" : "unchanged"} · ${integration.id}`,
  });
  const recipientId = String(openMessaging.integration.recipient?.id || "").trim();
  if (!recipientId) throw new Error("Genesys Open Messaging did not return its Message Routing recipient");
  await runWidgetDeploymentStep({
    ordinal: 3,
    onProgress,
    label: `${changes.recipientChanged ? "Assign" : "Verify"} the shared Open Messaging recipient`,
    operation: () => changes.recipientChanged
      ? context.routingApi.putRoutingMessageRecipient(recipientId, { flow: { id: messageFlow.id } })
      : context.routingApi.getRoutingMessageRecipient(recipientId),
    successDetail: `recipient ${recipientId} → flow ${messageFlow.id}${changes.recipientChanged ? "" : " · unchanged"}`,
  });
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const handoffToken = widgetHandoffApiKey();
  const integrationSecret = await runWidgetDeploymentStep({
    ordinal: 4,
    onProgress,
    label: "Ensure the shared Telnyx handoff integration secret",
    operation: () => ensureTelnyxIntegrationSecret(telnyx, handoffToken),
    successDetail: ({ identifier, created }) => `${created ? "created" : "reused"} · ${identifier}`,
  });
  const listedTool = await findSharedGenesysHandoffTool(telnyx, {
    preferredToolIds: [plan.resources.telnyxHandoffTool.id],
    displayName: plan.resources.telnyxHandoffTool.name,
  });
  const existingTool = listedTool
    ? await telnyx.ai.tools.retrieve(telnyxToolId(listedTool))
    : null;
  const mergedQueues = mergeGenesysHandoffQueues(existingTool, policy.queues);
  const definition = widgetHandoffToolDefinition({
    baseUrl: plan.publicBaseUrl,
    integrationSecretIdentifier: integrationSecret.identifier,
    queues: mergedQueues,
    defaultQueue: policy.defaultQueue,
    displayName: plan.resources.telnyxHandoffTool.name,
    functionName: "request_genesys_human_handoff",
  });
  const handoffTool = await runWidgetDeploymentStep({
    ordinal: 4,
    onProgress,
    label: `Ensure shared Telnyx webhook tool: ${plan.resources.telnyxHandoffTool.name}`,
    operation: () => {
      if (!changes.handoffToolChanged || (existingTool && sharedHandoffToolMatches(existingTool, definition))) return existingTool;
      return existingTool
        ? telnyx.ai.tools.update(telnyxToolId(existingTool), definition)
        : telnyx.ai.tools.create(definition);
    },
    successDetail: (result) => `${existingTool ? "reused or reconciled" : "created"} · ${result.id}`,
  });
  const manifest = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    deployment: plan.deployment,
    environment: plan.environment,
    organization: plan.organization,
    publicBaseUrl: plan.publicBaseUrl,
    access,
    messaging: {
      queues: policy.queues,
      defaultQueue: policy.defaultQueue,
      routingFlow: { id: messageFlow.id, name: messageFlow.name || plan.messaging.routingFlow.name },
      recipientId,
    },
    resources: {
      openMessagingIntegrationId: openMessaging.integration.id,
      telnyxHandoffToolId: telnyxToolId(handoffTool),
      telnyxIntegrationSecretId: integrationSecret.id,
      scriptId: handoffScript.id,
      interactionWidgetId: interactionWidget.id,
    },
    resourceNames: {
      openMessaging: plan.resources.openMessaging.name,
      telnyxHandoffTool: plan.resources.telnyxHandoffTool.name,
      handoffScript: plan.resources.handoffScript.name,
      interactionWidget: plan.resources.interactionWidget.name,
    },
  };
  const manifestPath = path.join(stateDirectory(options), "infrastructure.json");
  await runWidgetDeploymentStep({
    ordinal: 5,
    onProgress,
    label: "Persist the managed Web Chat infrastructure manifest",
    operation: async () => {
      await writeJsonAtomic(manifestPath, manifest);
      await registerManagedAgentExperience({
        organizationId: plan.organization.id,
        interactionWidget: {
          remoteId: interactionWidget.id,
          displayName: interactionWidget.name || plan.resources.interactionWidget.name,
        },
        handoffScript: {
          remoteId: handoffScript.id,
          displayName: handoffScript.name || plan.resources.handoffScript.name,
        },
      });
      await registerManagedResourceBatch({
        organizationId: plan.organization.id,
        aggregate: {
          kind: "messaging_profile",
          name: "installation:web-chat",
          desiredConfig: { installationName: installationResourceNames().installationName },
        },
        resources: [
          {
            key: "message_flow", provider: "genesys", resourceType: "architect_inbound_message_flow",
            remoteId: messageFlow.id, displayName: messageFlow.name || plan.messaging.routingFlow.name,
            logicalKey: "widget_message_flow",
          },
          {
            key: "open_messaging", provider: "genesys", resourceType: "open_messaging_integration",
            remoteId: openMessaging.integration.id, displayName: openMessaging.integration.name,
            logicalKey: "widget_open_messaging", metadata: { recipientId },
          },
          {
            key: "messaging_setting", provider: "genesys", resourceType: "messaging_setting",
            remoteId: openMessaging.integration.messagingSetting?.id,
            displayName: installationResourceNames().installationName,
            logicalKey: "widget_typing_indicators",
          },
          {
            key: "handoff_tool", provider: "telnyx", resourceType: "ai_tool",
            remoteId: telnyxToolId(handoffTool), displayName: plan.resources.telnyxHandoffTool.name,
            logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY,
          },
          {
            key: "integration_secret", provider: "telnyx", resourceType: "integration_secret",
            remoteId: integrationSecret.id, displayName: integrationSecret.identifier,
            logicalKey: "genesys_handoff_secret",
          },
        ],
        dependencies: [
          { resource: "open_messaging", dependsOn: "message_flow", relationship: "routes_to_flow" },
          { resource: "handoff_tool", dependsOn: "integration_secret", relationship: "uses_secret" },
        ],
      });
    },
    successDetail: manifestPath,
  });
  return { manifestPath, manifest };
}

async function ensureTelnyxIntegrationSecret(telnyx, token) {
  const identifier = widgetHandoffSecretIdentifier(token);
  const matches = [];
  for await (const secret of telnyx.integrationSecrets.list({ filter: { type: "bearer" } })) {
    if (secret.identifier === identifier) matches.push(secret);
  }
  if (matches.length > 1) throw new Error(`More than one Telnyx integration secret is named ${identifier}`);
  if (matches[0]) return { id: matches[0].id, identifier, created: false };
  const created = await telnyx.integrationSecrets.create({ identifier, type: "bearer", token });
  const value = created?.data || created;
  return { id: value.id, identifier, created: true };
}

export async function listTelnyxAssistants(telnyx) {
  const assistants = [];
  let pageNumber = 1;
  let totalPages = 1;
  do {
    const response = await telnyx.ai.assistants.list({
      query: { page: { number: pageNumber, size: 100 } },
    });
    if (!Array.isArray(response?.data)) {
      throw new Error("Telnyx assistant list returned an unexpected response");
    }
    assistants.push(...response.data);
    totalPages = Math.max(1, Number(response.meta?.total_pages || 1));
    pageNumber += 1;
  } while (pageNumber <= totalPages);
  return assistants.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

const WIDGET_HANGUP_INSTRUCTIONS_START = "<!-- telnyx-widget-hangup:start -->";
const WIDGET_HANGUP_INSTRUCTIONS_END = "<!-- telnyx-widget-hangup:end -->";

function widgetHangupInstructionsBlock() {
  return `${WIDGET_HANGUP_INSTRUCTIONS_START}\n## Ending voice calls\nFor phone_call or web_call only, when the caller explicitly asks to disconnect or the conversation has clearly concluded, give a brief farewell and call the Hangup tool exactly once. Never call Hangup for messaging transports, while a human handoff is pending, or after a handoff tool succeeds.\n${WIDGET_HANGUP_INSTRUCTIONS_END}`;
}

function upsertWidgetHangupInstructions(instructions) {
  const current = String(instructions || "").trim();
  const block = widgetHangupInstructionsBlock();
  const start = current.indexOf(WIDGET_HANGUP_INSTRUCTIONS_START);
  const end = current.indexOf(WIDGET_HANGUP_INSTRUCTIONS_END);
  if (start >= 0 && end >= start) {
    return `${current.slice(0, start)}${block}${current.slice(end + WIDGET_HANGUP_INSTRUCTIONS_END.length)}`.trim();
  }
  const legacyHeading = "## Ending voice calls";
  const legacyStart = current.indexOf(legacyHeading);
  if (legacyStart >= 0) {
    const nextHeading = current.indexOf("\n\n## ", legacyStart + legacyHeading.length);
    const legacyEnd = nextHeading >= 0 ? nextHeading : current.length;
    return `${current.slice(0, legacyStart)}${block}${current.slice(legacyEnd)}`.trim();
  }
  return current ? `${current}\n\n${block}` : block;
}

function widgetAssistantInstructions(queues, toolName) {
  const instructions = upsertGenesysUniversalHandoffInstructions(
    "You are a helpful customer-service assistant. Answer clearly and concisely.",
    { queues, toolName }
  );
  return upsertWidgetHangupInstructions(instructions);
}

async function findTelnyxAssistantByName(telnyx, name) {
  const matches = (await listTelnyxAssistants(telnyx)).filter((assistant) => assistant.name === name);
  if (matches.length > 1) throw new Error(`More than one Telnyx assistant is named ${name}`);
  return matches[0] || null;
}

function handoffToolBelongsToAnotherInstallation(tool, displayName, baseUrl) {
  if (telnyxToolDisplayName(tool) === displayName) return false;
  if (/telnyx\s+(?:ai\s+)?integrations/i.test(telnyxToolDisplayName(tool))) return true;
  const url = String(telnyxToolDefinition(tool)?.webhook?.url || "").trim();
  if (!url) return false;
  try {
    return new URL(url).origin !== new URL(baseUrl).origin;
  } catch {
    return true;
  }
}

export async function ensureTelnyxWidgetTool({
  telnyx,
  baseUrl,
  assistant,
  queues,
  token,
  displayName,
  hangupDisplayName = installationResourceNames().sharedHangupTool,
  preferredHangupToolId = null,
  includeHangup = false,
  onProgress = () => {},
}) {
  const integrationSecret = await runWidgetDeploymentStep({
    onProgress,
    label: "Ensure Telnyx integration secret for the handoff webhook",
    operation: () => ensureTelnyxIntegrationSecret(telnyx, token),
    successDetail: (result) => `${result.created ? "created" : "reused"} · ${result.identifier}`,
  });
  const existingManagedAssistant = assistant.operation === "create-or-update-managed"
    ? await findTelnyxAssistantByName(telnyx, assistant.name)
    : null;
  const currentAssistantId = assistant.operation === "reuse"
    ? assistant.id
    : existingManagedAssistant?.id;
  const currentAssistant = currentAssistantId
    ? await telnyx.ai.assistants.retrieve(currentAssistantId)
    : null;
  let attachedHandoffTools = currentAssistant
    ? await attachedGenesysHandoffTools(telnyx, currentAssistant)
    : [];
  attachedHandoffTools = await Promise.all(attachedHandoffTools.map((candidate) =>
    telnyxToolDisplayName(candidate)
      ? candidate
      : telnyx.ai.tools.retrieve(telnyxToolId(candidate))
  ));
  const exactAttachedTool = attachedHandoffTools.find(
    (candidate) => telnyxToolDisplayName(candidate) === displayName
  ) || null;
  const foreignAttachedTool = attachedHandoffTools.find((candidate) =>
    handoffToolBelongsToAnotherInstallation(candidate, displayName, baseUrl)
  ) || null;
  let attachedTool = exactAttachedTool || (!foreignAttachedTool ? attachedHandoffTools[0] : null);
  if (
    !attachedTool &&
    foreignAttachedTool &&
    assistant.operation === "reuse"
  ) {
    throw new Error(
      `Telnyx assistant ${assistant.id} already uses a Genesys handoff tool from another installation; use a separate assistant for this environment`
    );
  }
  let namedTool;
  const requestedTool = widgetHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: integrationSecret.identifier,
    queues,
    displayName,
    targetName: displayName,
  });
  if (!attachedTool) namedTool = await findTelnyxToolByName(telnyx, displayName, "webhook");
  const existingHandoffTool = attachedTool || namedTool || null;
  const mergedQueues = mergeGenesysHandoffQueues(existingHandoffTool, queues);
  const definition = widgetHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: integrationSecret.identifier,
    queues: mergedQueues,
    displayName: existingHandoffTool
      ? telnyxToolDisplayName(existingHandoffTool) || requestedTool.display_name
      : requestedTool.display_name,
    functionName: existingHandoffTool
      ? telnyxToolFunctionName(existingHandoffTool)
      : requestedTool.webhook.name,
  });
  let existing;
  const tool = await runWidgetDeploymentStep({
    onProgress,
    label: `Ensure Telnyx webhook tool: ${definition.display_name}`,
    operation: async () => {
      existing = existingHandoffTool;
      return existing
        ? telnyx.ai.tools.update(telnyxToolId(existing), definition)
        : telnyx.ai.tools.create(definition);
    },
    successDetail: (result) => `${existing ? "updated" : "created"} · ${result.id}`,
  });
  let hangupTool = null;
  if (assistant.operation === "create-or-update-managed" || includeHangup) {
    let existingHangupTool = null;
    if (preferredHangupToolId) {
      try {
        existingHangupTool = await telnyx.ai.tools.retrieve(preferredHangupToolId);
      } catch (error) {
        const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
        if (status !== 404) throw error;
      }
    }
    if (!existingHangupTool) {
      existingHangupTool = await findTelnyxToolByName(
        telnyx,
        hangupDisplayName,
        "hangup"
      );
    }
    const definition = hangupToolDefinition(hangupDisplayName);
    hangupTool = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure shared Telnyx Hangup tool: ${hangupDisplayName}`,
      operation: () => existingHangupTool
        ? telnyx.ai.tools.update(telnyxToolId(existingHangupTool), definition)
        : telnyx.ai.tools.create(definition),
      successDetail: (result) => `${existingHangupTool ? "updated" : "created"} · ${result.id}`,
    });
  }
  let target;
  let assistantCreated = false;
  if (assistant.operation === "create-or-update-managed") {
    const body = {
      name: assistant.name,
      description: `Managed messaging assistant for Genesys queues: ${queues.map(({ name }) => name).join(", ")}`,
      instructions: currentAssistant
        ? (hangupTool
            ? upsertWidgetHangupInstructions(upsertGenesysUniversalHandoffInstructions(
                currentAssistant.instructions,
                { queues: mergedQueues, toolName: definition.webhook.name }
              ))
            : upsertGenesysUniversalHandoffInstructions(currentAssistant.instructions, {
                queues: mergedQueues,
                toolName: definition.webhook.name,
              }))
        : widgetAssistantInstructions(mergedQueues, definition.webhook.name),
      greeting: currentAssistant?.greeting || "Hello! How can I help you today?",
      // Telnyx assistant transcription uses an ISO 639-1 language hint. `en` is the
      // voice/STT equivalent of the widget's default BCP 47 locale, `en-US`.
      transcription: currentAssistant?.transcription || { model: "deepgram/flux", language: "en" },
      enabled_features: [...new Set([
        ...(currentAssistant?.enabled_features || []),
        "messaging",
      ])],
      tool_ids: currentAssistant
          ? reconciledAssistantToolIds({
              assistant: currentAssistant,
              attachedHandoffTools,
              handoffToolId: tool.id,
              requiredToolIds: hangupTool ? [hangupTool.id] : [],
            })
          : [tool.id, ...(hangupTool ? [hangupTool.id] : [])],
      tags: [...new Set([
        ...(currentAssistant?.tags || []),
        "genesys",
        "widget",
        "managed",
      ])],
    };
    target = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure Telnyx AI Assistant: ${assistant.name}`,
      operation: async () => {
        return existingManagedAssistant
          ? telnyx.ai.assistants.update(existingManagedAssistant.id, body)
          : telnyx.ai.assistants.create(body);
      },
      successDetail: (result) => `${existingManagedAssistant ? "updated" : "created"} · ${result.id}`,
    });
    assistantCreated = !existingManagedAssistant;
  } else {
    target = await runWidgetDeploymentStep({
      onProgress,
      label: `Attach handoff tool to Telnyx AI Assistant: ${assistant.id}`,
      operation: async () => {
        const handoffInstructions = upsertGenesysUniversalHandoffInstructions(
          currentAssistant.instructions,
          { queues: mergedQueues, toolName: definition.webhook.name }
        );
        const instructions = hangupTool
          ? upsertWidgetHangupInstructions(handoffInstructions)
          : handoffInstructions;
        const toolIds = reconciledAssistantToolIds({
          assistant: currentAssistant,
          attachedHandoffTools,
          handoffToolId: tool.id,
          requiredToolIds: hangupTool ? [hangupTool.id] : [],
        });
        return telnyx.ai.assistants.update(assistant.id, {
          instructions,
          enabled_features: [...new Set([
            ...(currentAssistant.enabled_features || []),
            "messaging",
          ])],
          tool_ids: toolIds,
        });
      },
      successDetail: (result) => `updated · ${result.name || result.id}`,
    });
  }
  return {
    tool,
    hangupTool,
    integrationSecret,
    assistant: target,
    assistantCreated,
    toolCreated: !existingHandoffTool,
    toolManaged: assistant.operation === "create-or-update-managed",
    attachedHandoffToolIds: attachedHandoffTools.map((entry) => telnyxToolId(entry)),
  };
}

export async function ensureTelnyxAssistantHangupTool({
  telnyx,
  assistantId,
  preferredHangupToolId = null,
  displayName = installationResourceNames().sharedHangupTool,
  onProgress = () => {},
}) {
  const assistant = await runWidgetDeploymentStep({
    onProgress,
    label: `Load Telnyx AI Assistant for Hangup: ${assistantId}`,
    operation: () => telnyx.ai.assistants.retrieve(assistantId),
    successDetail: (result) => result.name || result.id,
  });
  let existing = null;
  if (preferredHangupToolId) {
    try {
      existing = await telnyx.ai.tools.retrieve(preferredHangupToolId);
    } catch (error) {
      const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
      if (status !== 404) throw error;
    }
  }
  if (!existing) existing = await findTelnyxToolByName(telnyx, displayName, "hangup");
  const definition = hangupToolDefinition(displayName);
  const tool = await runWidgetDeploymentStep({
    onProgress,
    label: `Ensure shared Telnyx Hangup tool: ${displayName}`,
    operation: () => existing
      ? telnyx.ai.tools.update(telnyxToolId(existing), definition)
      : telnyx.ai.tools.create(definition),
    successDetail: (result) => `${existing ? "updated" : "created"} · ${result.id}`,
  });
  const updatedAssistant = await runWidgetDeploymentStep({
    onProgress,
    label: `Attach Hangup tool to Telnyx AI Assistant: ${assistantId}`,
    operation: () => telnyx.ai.assistants.update(assistantId, {
      instructions: upsertWidgetHangupInstructions(assistant.instructions),
      tool_ids: [...new Set([...assistantSharedToolIds(assistant), tool.id])],
    }),
    successDetail: (result) => `updated · ${result.name || result.id}`,
  });
  return { tool, assistant: updatedAssistant, toolCreated: !existing };
}

const WIDGET_SINGLETON_TOOL_LABELS = Object.freeze({
  hangup: "Hangup",
  transfer: "Transfer",
  invite: "Invite",
  skip_turn: "Skip Turn",
});

function assistantInlineToolDefinition(tool) {
  const definition = telnyxToolDefinition(tool);
  const type = String(definition?.type || "").trim();
  if (!type || !definition?.[type] || typeof definition[type] !== "object") return null;
  return { type, [type]: structuredClone(definition[type]) };
}

function inlineToolConflictKey(type, definition, ordinal) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(definition || {}))
    .digest("hex")
    .slice(0, 12);
  return `inline:${type}:${fingerprint}:${ordinal}`;
}

async function resolvedAssistantTools(telnyx, assistant) {
  const sharedIds = new Set(assistantSharedToolIds(assistant));
  const resolved = [];
  const seenSharedIds = new Set();
  for (const [index, candidate] of (Array.isArray(assistant?.tools) ? assistant.tools : []).entries()) {
    const id = telnyxToolId(candidate);
    const source = candidate?.shared === true || (id && sharedIds.has(id)) ? "shared" : "inline";
    let tool = candidate;
    if (source === "shared" && id && !String(telnyxToolDefinition(candidate)?.type || "").trim()) {
      tool = await telnyx.ai.tools.retrieve(id);
    }
    if (source === "shared" && id) seenSharedIds.add(id);
    resolved.push({ tool, id, source, index });
  }
  for (const id of sharedIds) {
    if (seenSharedIds.has(id)) continue;
    resolved.push({ tool: await telnyx.ai.tools.retrieve(id), id, source: "shared", index: resolved.length });
  }
  return resolved;
}

function expectedWidgetSingletonTools({ widget, config, managedHangup, managedHandoff, managedSkipTurn }) {
  if (!config.channels.voice.enabled) return new Map();
  const keepAssistantOnCall = config.channels.voice.keepAssistantOnCall === true;
  const installationNames = installationResourceNames();
  const expected = new Map([
    ["hangup", {
      ids: new Set([managedHangup?.remoteToolId].filter(Boolean)),
      displayName: installationNames.sharedHangupTool,
    }],
    [keepAssistantOnCall ? "invite" : "transfer", {
      ids: new Set([managedHandoff?.remoteToolId].filter(Boolean)),
      displayName: widgetResourceBaseName(widget),
    }],
  ]);
  if (keepAssistantOnCall) {
    expected.set("skip_turn", {
      ids: new Set([managedSkipTurn?.remoteToolId].filter(Boolean)),
      displayName: installationNames.sharedSkipTurnTool,
    });
  }
  return expected;
}

export class WidgetAssistantToolConflictError extends Error {
  constructor({ assistantId, assistantName, conflicts }) {
    super(`Telnyx AI Assistant ${assistantName || assistantId} has tools that must be replaced before this widget can be published`);
    this.name = "WidgetAssistantToolConflictError";
    this.code = "assistant_tool_conflict";
    this.status = 409;
    this.assistantId = assistantId;
    this.assistantName = assistantName || assistantId;
    this.conflicts = conflicts;
  }
}

export async function inspectPublishedWidgetAssistantToolConflicts({
  organizationId,
  widget,
  config,
  telnyx: suppliedTelnyx,
  managedTools = null,
}) {
  const assistantId = String(
    config.channels.messaging.enabled
      ? config.channels.messaging.assistantId
      : config.channels.voice.assistantId
  ).trim();
  if (!assistantId || !config.channels.voice.enabled) {
    return { assistantId, assistantName: assistantId, conflicts: [] };
  }
  const keepAssistantOnCall = config.channels.voice.keepAssistantOnCall === true;
  const scopeId = widget.id;
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const [assistant, managedHangup, managedHandoff, managedSkipTurn] = await Promise.all([
    telnyx.ai.assistants.retrieve(assistantId),
    managedTools
      ? managedTools.hangup || null
      : getAdminManagedTool({ organizationId, logicalKey: ADMIN_SHARED_HANGUP_TOOL_KEY }),
    managedTools
      ? managedTools.handoff || null
      : getAdminManagedTool({
      organizationId,
      logicalKey: keepAssistantOnCall ? ADMIN_SHARED_INVITE_TOOL_KEY : ADMIN_SIP_TRANSFER_TOOL_KEY,
      scopeType: "deployment",
      scopeId,
    }),
    keepAssistantOnCall
      ? managedTools
        ? managedTools.skipTurn || null
        : getAdminManagedTool({ organizationId, logicalKey: ADMIN_SHARED_SKIP_TURN_TOOL_KEY })
      : null,
  ]);
  const expected = expectedWidgetSingletonTools({
    widget,
    config,
    managedHangup,
    managedHandoff,
    managedSkipTurn,
  });
  const tools = await resolvedAssistantTools(telnyx, assistant);
  const inlineOrdinals = new Map();
  const conflicts = [];
  for (const entry of tools) {
    const definition = telnyxToolDefinition(entry.tool);
    const type = String(definition?.type || "").trim();
    const desired = expected.get(type);
    if (!desired) continue;
    const displayName = telnyxToolDisplayName(entry.tool) || `Inline ${WIDGET_SINGLETON_TOOL_LABELS[type] || type}`;
    // A tracked remote ID is authoritative. Falling back to the managed name is
    // safe only before a tool has been registered; otherwise a foreign tool
    // renamed to the managed name could be mistaken for the tracked resource
    // and the subsequent attach would still violate Telnyx's singleton rule.
    const isExpectedSharedTool = entry.source === "shared" && (
      desired.ids.size
        ? entry.id && desired.ids.has(entry.id)
        : displayName === desired.displayName
    );
    if (isExpectedSharedTool) continue;
    const ordinal = inlineOrdinals.get(type) || 0;
    if (entry.source === "inline") inlineOrdinals.set(type, ordinal + 1);
    conflicts.push({
      key: entry.source === "shared"
        ? `shared:${entry.id}`
        : inlineToolConflictKey(type, assistantInlineToolDefinition(entry.tool), ordinal),
      id: entry.id || null,
      type,
      typeLabel: WIDGET_SINGLETON_TOOL_LABELS[type] || type,
      name: displayName,
      source: entry.source,
      action: entry.source === "shared" ? "detach" : "remove",
    });
  }
  return {
    assistantId,
    assistantName: assistant.name || assistantId,
    conflicts,
    assistant,
    resolvedTools: tools,
  };
}

export async function reconcilePublishedWidgetAssistantToolConflicts({
  organizationId,
  widget,
  config,
  telnyx: suppliedTelnyx,
  telnyxFactory = () => new Telnyx({ apiKey: required("TELNYX_API_KEY") }),
  approvedConflictKeys = [],
  managedTools = null,
  onProgress = () => {},
}) {
  const telnyx = suppliedTelnyx || telnyxFactory();
  const inspection = await inspectPublishedWidgetAssistantToolConflicts({
    organizationId,
    widget,
    config,
    telnyx,
    managedTools,
  });
  if (!inspection.conflicts.length) return inspection;
  const approved = new Set((approvedConflictKeys || []).map((key) => String(key || "").trim()).filter(Boolean));
  const unapproved = inspection.conflicts.filter((conflict) => !approved.has(conflict.key));
  if (unapproved.length) {
    throw new WidgetAssistantToolConflictError({
      assistantId: inspection.assistantId,
      assistantName: inspection.assistantName,
      conflicts: inspection.conflicts,
    });
  }
  const conflictKeys = new Set(inspection.conflicts.map((conflict) => conflict.key));
  const sharedConflictIds = new Set(
    inspection.conflicts.filter((conflict) => conflict.source === "shared").map((conflict) => conflict.id)
  );
  const inlineOrdinals = new Map();
  const inlineTools = [];
  for (const entry of inspection.resolvedTools.filter(({ source }) => source === "inline")) {
    const definition = assistantInlineToolDefinition(entry.tool);
    if (!definition) continue;
    const type = definition.type;
    const ordinal = inlineOrdinals.get(type) || 0;
    inlineOrdinals.set(type, ordinal + 1);
    const key = inlineToolConflictKey(type, definition, ordinal);
    if (!conflictKeys.has(key)) inlineTools.push(definition);
  }
  await runWidgetDeploymentStep({
    onProgress,
    label: `Replace conflicting singleton tools on Telnyx AI Assistant: ${inspection.assistantName}`,
    operation: () => telnyx.ai.assistants.update(inspection.assistantId, {
      tools: inlineTools,
      tool_ids: assistantSharedToolIds(inspection.assistant).filter((id) => !sharedConflictIds.has(id)),
    }),
    successDetail: () => inspection.conflicts.map(({ typeLabel, name }) => `${typeLabel}: ${name}`).join(" · "),
  });
  return inspection;
}

export async function ensurePublishedWidgetAssistantResources({
  organizationId,
  widget,
  config,
  infrastructure,
  telnyx: suppliedTelnyx,
  approvedToolConflictKeys = [],
  onProgress = () => {},
}) {
  const installationNames = installationResourceNames();
  const messagingAssistantId = config.channels.messaging.enabled
    ? String(config.channels.messaging.assistantId || "").trim()
    : "";
  const voiceAssistantId = config.channels.voice.enabled
    ? String(config.channels.voice.assistantId || "").trim()
    : "";
  const assistantId = messagingAssistantId || voiceAssistantId;
  if (!assistantId) throw new Error("Select one Telnyx AI assistant for this widget");
  if (messagingAssistantId && voiceAssistantId && messagingAssistantId !== voiceAssistantId) {
    throw new Error("Messaging and voice must use the same Telnyx AI assistant");
  }
  const messagingQueues = infrastructure?.messaging?.queues || [];
  const voiceQueues = infrastructure?.voice?.queues || messagingQueues;
  if (config.channels.messaging.enabled && !messagingQueues.length) {
    throw new Error("Web Chat Infrastructure does not contain any allowed Genesys queues");
  }
  if (config.channels.voice.enabled && !voiceQueues.length) {
    throw new Error("Web Calls Infrastructure does not contain any allowed Genesys queues");
  }
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const widgetResourceName = widgetResourceBaseName(widget);
  const scopeId = widget.id;
  const keepAssistantOnCall = config.channels.voice.keepAssistantOnCall === true;
  await reconcilePublishedWidgetAssistantToolConflicts({
    organizationId,
    widget,
    config,
    telnyx,
    approvedConflictKeys: approvedToolConflictKeys,
    onProgress,
  });
  const insightProfile = await runWidgetDeploymentStep({
    onProgress,
    label: "Ensure the installation Telnyx Insights Group and webhook",
    operation: () => ensureAdminManagedInsightProfile({ telnyx, organizationId }),
    successDetail: (result) => `${result.group.name} · ${result.group.id}`,
  });
  const currentAssistant = await telnyx.ai.assistants.retrieve(assistantId);
  await runWidgetDeploymentStep({
    onProgress,
    label: `Enforce managed privacy and insights on Telnyx AI Assistant: ${currentAssistant.name || assistantId}`,
    operation: () => telnyx.ai.assistants.update(assistantId, {
      privacy_settings: {
        ...(currentAssistant.privacy_settings || {}),
        data_retention: true,
        pii_redaction: "disabled",
      },
      insight_settings: {
        ...(currentAssistant.insight_settings || {}),
        insight_group_id: insightProfile.group.id,
      },
    }),
    successDetail: () => "data retention enabled · PII redaction disabled · Insights Group attached",
  });
  await trackAdminAssistantInsightAssignment({
    organizationId,
    assistantId,
    insightGroupId: insightProfile.group.id,
  });
  const [managedHangup, managedTransfer, managedQueue, managedSkipTurn, managedOppositeHandoff] = await Promise.all([
    getAdminManagedTool({ organizationId, logicalKey: ADMIN_SHARED_HANGUP_TOOL_KEY }),
    getAdminManagedTool({
      organizationId,
      logicalKey: keepAssistantOnCall ? ADMIN_SHARED_INVITE_TOOL_KEY : ADMIN_SIP_TRANSFER_TOOL_KEY,
      scopeType: "deployment",
      scopeId,
    }),
    getAdminManagedTool({ organizationId, logicalKey: ADMIN_VOICE_QUEUE_TOOL_KEY, scopeType: "deployment", scopeId }),
    getAdminManagedTool({ organizationId, logicalKey: ADMIN_SHARED_SKIP_TURN_TOOL_KEY }),
    // Whichever handoff tool the previous publish left behind.
    getAdminManagedTool({
      organizationId,
      logicalKey: keepAssistantOnCall ? ADMIN_SIP_TRANSFER_TOOL_KEY : ADMIN_SHARED_INVITE_TOOL_KEY,
      scopeType: "deployment",
      scopeId,
    }),
  ]);
  const messaging = config.channels.messaging.enabled
    ? await ensureTelnyxWidgetTool({
        telnyx,
        baseUrl: infrastructure.publicBaseUrl || required("GC_PUBLIC_BASE_URL"),
        assistant: { operation: "reuse", id: assistantId },
        queues: messagingQueues,
        token: widgetHandoffApiKey(),
        displayName: installationNames.widgetHandoffTool,
        hangupDisplayName: installationNames.sharedHangupTool,
        preferredHangupToolId: managedHangup?.remoteToolId,
        includeHangup: config.channels.voice.enabled,
        onProgress,
      })
    : null;
  const hangup = config.channels.voice.enabled && !messaging?.hangupTool
    ? await ensureTelnyxAssistantHangupTool({
        telnyx,
        assistantId,
        preferredHangupToolId: managedHangup?.remoteToolId,
        displayName: installationNames.sharedHangupTool,
        onProgress,
      })
    : null;
  const transfer = config.channels.voice.enabled
    ? await ensureTelnyxWidgetTransferTool({
        telnyx,
        assistantId,
        queues: voiceQueues,
        displayName: widgetResourceName,
        from: TELNYX_END_USER_TARGET_TEMPLATE,
        to: config.channels.voice.genesysSipUri,
        targetName: "Genesys Cloud",
        handoffToolName: messaging ? telnyxToolFunctionName(messaging.tool) : null,
        queueToolDisplayName: widgetResourceName,
        queueToolFunctionName: widgetVoiceQueueFunctionName(widget),
        preferredTransferToolId: managedTransfer?.remoteToolId,
        preferredQueueToolId: managedQueue?.remoteToolId,
        preferredSkipTurnToolId: managedSkipTurn?.remoteToolId,
        keepAssistantOnCall,
        detachToolIds: keepAssistantOnCall
          ? [managedOppositeHandoff?.remoteToolId]
          : [managedOppositeHandoff?.remoteToolId, managedSkipTurn?.remoteToolId],
        onProgress,
      })
    : null;
  const register = ({ tool, logicalKey, scopeType = "shared" }) => tool?.id
    ? registerAdminManagedTelnyxTool({
        telnyx,
        organizationId,
        logicalKey,
        scopeType,
        scopeId: scopeType === "shared" ? "shared" : scopeId,
        remoteToolId: tool.id,
        component: "widget",
        deploymentId: scopeId,
        assistantIds: [assistantId],
        metadata: { widgetId: widget.id, widgetPublicId: widget.publicId },
      })
    : null;
  const webCalls = config.channels.voice.enabled
    ? await ensureTelnyxAssistantUnauthenticatedWebCalls({ telnyx, assistantId, onProgress })
    : null;
  await Promise.all([
    register({ tool: messaging?.tool, logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY }),
    register({ tool: messaging?.hangupTool || hangup?.tool, logicalKey: ADMIN_SHARED_HANGUP_TOOL_KEY }),
    register({
      tool: transfer?.tool,
      logicalKey: keepAssistantOnCall ? ADMIN_SHARED_INVITE_TOOL_KEY : ADMIN_SIP_TRANSFER_TOOL_KEY,
      scopeType: "deployment",
    }),
    register({ tool: transfer?.queueTool, logicalKey: ADMIN_VOICE_QUEUE_TOOL_KEY, scopeType: "deployment" }),
    register({ tool: transfer?.skipTurnTool, logicalKey: ADMIN_SHARED_SKIP_TURN_TOOL_KEY }),
  ]);
  return { assistantId, messaging, hangup, transfer, webCalls };
}

// Browser voice sessions log in to Telnyx WebRTC anonymously with the assistant as
// the target. That login is rejected (46001 LOGIN_FAILED) unless the assistant
// itself opts into unauthenticated web calls, so publishing a voice widget grants it.
export async function ensureTelnyxAssistantUnauthenticatedWebCalls({
  telnyx,
  assistantId,
  onProgress = () => {},
}) {
  const assistant = await runWidgetDeploymentStep({
    onProgress,
    label: `Load Telnyx AI Assistant for browser voice access: ${assistantId}`,
    operation: () => telnyx.ai.assistants.retrieve(assistantId),
    successDetail: (result) => result.name || result.id,
  });
  const telephonySettings = assistant.telephony_settings || {};
  if (telephonySettings.supports_unauthenticated_web_calls === true) {
    onProgress({
      status: "succeeded",
      label: "Allow unauthenticated browser calls on the Telnyx AI Assistant",
      detail: "already enabled",
    });
    return { assistantId, changed: false };
  }
  await runWidgetDeploymentStep({
    onProgress,
    label: "Allow unauthenticated browser calls on the Telnyx AI Assistant",
    operation: () => telnyx.ai.assistants.update(assistantId, {
      telephony_settings: { ...telephonySettings, supports_unauthenticated_web_calls: true },
    }),
    successDetail: () => "enabled",
  });
  return { assistantId, changed: true };
}

export async function ensureTelnyxWidgetTransferTool({
  telnyx,
  assistantId,
  queues,
  displayName,
  from,
  to,
  targetName,
  handoffToolName,
  queueToolDisplayName,
  queueToolFunctionName = "select_genesys_voice_queue",
  preferredTransferToolId = null,
  preferredQueueToolId = null,
  preferredSkipTurnToolId = null,
  keepAssistantOnCall = false,
  detachToolIds = [],
  onProgress = () => {},
}) {
  const currentAssistant = await runWidgetDeploymentStep({
    onProgress,
    label: `Load Telnyx AI Assistant for SIP transfer: ${assistantId}`,
    operation: () => telnyx.ai.assistants.retrieve(assistantId),
    successDetail: (result) => result.name || result.id,
  });
  const [transfers, handoffTools] = await Promise.all([
    attachedTransferTools(telnyx, currentAssistant),
    attachedGenesysHandoffTools(telnyx, currentAssistant),
  ]);
  let preferredTransferTool = null;
  if (preferredTransferToolId) {
    try {
      preferredTransferTool = await telnyx.ai.tools.retrieve(preferredTransferToolId);
    } catch (error) {
      const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
      if (status !== 404) throw error;
    }
  }
  const attached = findMatchingTransferTool(transfers, {
    displayName,
    destination: to,
  });
  const named = preferredTransferTool || attached
    ? null
    : await findTelnyxToolByName(telnyx, displayName, keepAssistantOnCall ? "invite" : "transfer");
  const existing = preferredTransferTool || attached || named || null;
  const definition = keepAssistantOnCall
    ? genesysSipInviteToolDefinition({ displayName, from, to, targetName, dynamicDestination: true })
    : genesysSipTransferToolDefinition({ displayName, from, to, targetName, dynamicDestination: true });
  const toolNoun = keepAssistantOnCall ? "Invite" : "SIP Transfer";
  const queueToolName = queueToolDisplayName || displayName;
  let preferredQueueTool = null;
  if (preferredQueueToolId) {
    try {
      preferredQueueTool = await telnyx.ai.tools.retrieve(preferredQueueToolId);
    } catch (error) {
      const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
      if (status !== 404) throw error;
    }
  }
  const existingQueueTool = preferredQueueTool ||
    await findTelnyxToolByName(telnyx, queueToolName, "update_dynamic_variables");
  const queueToolDefinition = genesysVoiceQueueToolDefinition({
    displayName: queueToolName,
    functionName: queueToolFunctionName,
    queues,
    sipUri: to,
  });
  const queueTool = await runWidgetDeploymentStep({
    onProgress,
    label: `Ensure Telnyx voice queue variable tool: ${queueToolName}`,
    operation: () => existingQueueTool
      ? telnyx.ai.tools.update(telnyxToolId(existingQueueTool), queueToolDefinition)
      : telnyx.ai.tools.create(queueToolDefinition),
    successDetail: (result) => `${existingQueueTool ? "updated" : "created"} · ${result.id}`,
  });
  // Inviting leaves the assistant holding the turn, so it can only stay silent if
  // skip turn is attached alongside.
  const skipTurnName = installationResourceNames().sharedSkipTurnTool;
  let existingSkipTurnTool = null;
  if (keepAssistantOnCall) {
    if (preferredSkipTurnToolId) {
      try {
        existingSkipTurnTool = await telnyx.ai.tools.retrieve(preferredSkipTurnToolId);
      } catch (error) {
        const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
        if (status !== 404) throw error;
      }
    }
    existingSkipTurnTool = existingSkipTurnTool || await findTelnyxToolByName(telnyx, skipTurnName, "skip_turn");
  }
  const skipTurnDefinition = genesysSkipTurnToolDefinition({ displayName: skipTurnName });
  const skipTurnTool = keepAssistantOnCall
    ? await runWidgetDeploymentStep({
        onProgress,
        label: `Ensure Telnyx Skip Turn tool: ${skipTurnName}`,
        operation: () => existingSkipTurnTool
          ? telnyx.ai.tools.update(telnyxToolId(existingSkipTurnTool), skipTurnDefinition)
          : telnyx.ai.tools.create(skipTurnDefinition),
        successDetail: (result) => `${existingSkipTurnTool ? "updated" : "created"} · ${result.id}`,
      })
    : null;
  const tool = await runWidgetDeploymentStep({
    onProgress,
    label: `Ensure Telnyx Genesys ${toolNoun} tool: ${displayName}`,
    operation: () => existing
      ? telnyx.ai.tools.update(telnyxToolId(existing), definition)
      : telnyx.ai.tools.create(definition),
    successDetail: (result) => `${existing ? "updated" : "created"} · ${result.id}`,
  });
  const obsoleteToolIds = new Set([
    ...detachToolIds.map((id) => String(id || "").trim()).filter(Boolean),
    ...(await attachedGenesysCallHandoffTools(
      telnyx,
      currentAssistant,
      keepAssistantOnCall ? ["transfer"] : ["invite"]
    )),
  ]);
  obsoleteToolIds.delete(tool.id);
  if (skipTurnTool) obsoleteToolIds.delete(skipTurnTool.id);
  const resolvedHandoffToolName = handoffToolName || (
    handoffTools[0] ? telnyxToolFunctionName(handoffTools[0]) : null
  );
  const assistant = await runWidgetDeploymentStep({
    onProgress,
    label: `Attach Genesys ${toolNoun} tool to Telnyx AI Assistant: ${assistantId}`,
    operation: () => telnyx.ai.assistants.update(assistantId, {
      instructions: upsertGenesysUniversalHandoffInstructions(
        currentAssistant.instructions,
        {
          queues,
          handoffToolName: resolvedHandoffToolName,
          transferToolName: definition.display_name,
          voiceQueueToolName: queueToolFunctionName,
          keepAssistantOnCall,
          skipTurnToolName: skipTurnTool ? skipTurnDefinition.display_name : null,
        }
      ),
      enabled_features: [...new Set([
        ...(currentAssistant.enabled_features || []),
        "telephony",
      ])],
      // The opposite handoff tool has to go: with both attached the model chooses
      // between transferring and inviting at random.
      tool_ids: [...new Set([
        ...assistantSharedToolIds(currentAssistant).filter((id) => !obsoleteToolIds.has(id)),
        queueTool.id,
        tool.id,
        ...(skipTurnTool ? [skipTurnTool.id] : []),
      ])],
    }),
    successDetail: (result) => `updated · ${result.name || result.id}`,
  });
  return {
    assistant,
    tool,
    toolCreated: !existing,
    toolManaged: !existing || telnyxToolDisplayName(existing) === displayName,
    queueTool,
    queueToolCreated: !existingQueueTool,
    queueToolManaged: !existingQueueTool || telnyxToolDisplayName(existingQueueTool) === queueToolName,
    skipTurnTool,
    keepAssistantOnCall,
  };
}

async function ensureWidgetOauthClient({
  context,
  baseUrl,
  name = installationResourceNames().adminOauthClient,
}) {
  if (process.env.GC_CLIENT_ID) {
    const result = await ensureWidgetOauthRedirectUri(
      context.oauthApi,
      process.env.GC_CLIENT_ID,
      baseUrl
    );
    return { id: process.env.GC_CLIENT_ID, created: false, callbackUrl: result.callbackUrl };
  }
  const created = await context.oauthApi.postOauthClients({
    name,
    authorizedGrantType: "CODE",
    registeredRedirectUri: [`${baseUrl}/api/auth/callback`],
    scope: ["users", "organization:readonly"],
    accessTokenValiditySeconds: GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS,
  });
  if (!created?.id) throw new Error("Genesys did not return the created OAuth client ID");
  const values = { GC_CLIENT_ID: created.id };
  if (created.secret) values.GC_CLIENT_SECRET = created.secret;
  await saveWidgetEnvironmentValues({ values });
  return { id: created.id, created: true, callbackUrl: `${baseUrl}/api/auth/callback` };
}

function assertPlanContext(plan, context) {
  if (plan.environment !== context.environment || plan.organization?.id !== context.organization?.id) {
    throw new Error("Widget plan belongs to a different Genesys environment or organization");
  }
  if (plan.publicBaseUrl !== normalizePublicApplicationOrigin(process.env.GC_PUBLIC_BASE_URL)) {
    throw new Error("GC_PUBLIC_BASE_URL changed after the widget plan was created");
  }
}

function widgetDeploymentErrorDetail(error) {
  const body = error?.body || error?.response?.body || error?.response?.data;
  return String(
    body?.errors?.[0]?.detail ||
    body?.errors?.[0]?.message ||
    body?.message ||
    error?.message ||
    error
  );
}

export async function runWidgetDeploymentStep({
  onProgress = () => {},
  ordinal,
  label,
  operation,
  successDetail = "",
}) {
  const event = (status, detail) => ({
    ...(Number.isInteger(ordinal) ? { ordinal } : {}),
    status,
    label,
    ...(detail === undefined ? {} : { detail }),
  });
  onProgress(event("running"));
  try {
    const result = await operation();
    const detail = typeof successDetail === "function" ? successDetail(result) : successDetail;
    onProgress(event("success", detail || ""));
    return result;
  } catch (error) {
    onProgress(event("failure", widgetDeploymentErrorDetail(error)));
    throw error;
  }
}

function phoneNumbersCoveredByDidPools(didPools) {
  const namespaceStart = BigInt(WIDGET_VOICE_DID_NAMESPACE_START.slice(1));
  const namespaceEnd = BigInt(WIDGET_VOICE_DID_NAMESPACE_END.slice(1));
  const used = [];
  for (const pool of didPools || []) {
    try {
      const start = BigInt(String(pool.startPhoneNumber || "").replace(/^\+/, ""));
      const end = BigInt(String(pool.endPhoneNumber || "").replace(/^\+/, ""));
      const overlapStart = start > namespaceStart ? start : namespaceStart;
      const overlapEnd = end < namespaceEnd ? end : namespaceEnd;
      for (let value = overlapStart; value <= overlapEnd; value += 1n) used.push(`+${value}`);
    } catch {
      // Ignore malformed third-party pool records; Genesys will still reject a conflicting POST.
    }
  }
  return used;
}

function publishedWidgetVoiceResourceNames(widget) {
  const prefix = widgetResourceBaseName(widget);
  return {
    flowName: prefix,
    didPoolName: prefix,
    ivrName: prefix,
  };
}

export function selectWidgetVoiceTrunk(inventory, trunkId = "") {
  if (!trunkId) {
    throw new Error("Select a Genesys BYOC trunk for Widget voice transfers");
  }
  return resolveGenesysByocTrunk(inventory, trunkId);
}

export async function reservePublishedWidgetVoiceRouting({
  organizationId,
  widget,
  context,
  trunkId,
  onProgress = () => {},
}) {
  if (!widget?.id) throw new Error("Widget ID is required for managed voice routing");
  if (!context?.telephonyApi || !context?.architectApi) {
    throw new Error("Genesys Telephony and Architect APIs are required for managed voice routing");
  }
  const [didPools, sipInventory] = await Promise.all([
    runWidgetDeploymentStep({
      onProgress,
      label: "Load Genesys DID pools for the synthetic Widget namespace",
      operation: () => loadGenesysDidPools(context.telephonyApi),
      successDetail: (items) => `${items.length} DID pool(s) checked`,
    }),
    runWidgetDeploymentStep({
      onProgress,
      label: "Load compatible Genesys BYOC Cloud trunks",
      operation: () => loadGenesysSipInventory({
        telephonyApi: context.telephonyApi,
        architectApi: context.architectApi,
        environment: context.environment,
      }),
      successDetail: (value) => `${value.trunks.length} BYOC trunk(s) found`,
    }),
  ]);
  // Resolve the explicitly selected trunk before reserving a DID so an invalid,
  // removed or disabled trunk cannot leave an unnecessary database allocation.
  const trunk = selectWidgetVoiceTrunk(sipInventory, trunkId);
  const reservation = await runWidgetDeploymentStep({
    onProgress,
    label: `Reserve the first free Widget routing DID (${WIDGET_VOICE_DID_NAMESPACE_START}-${WIDGET_VOICE_DID_NAMESPACE_END})`,
    operation: () => reserveWidgetVoiceDid({
      organizationId,
      deploymentId: widget.id,
      genesysUsedNumbers: phoneNumbersCoveredByDidPools(didPools),
    }),
    successDetail: ({ allocation, created }) =>
      `${created ? "reserved" : "reused"} · ${allocation.phone_number}`,
  });
  const genesysSipUri = buildGenesysSipUri({
    did: reservation.allocation.phone_number,
    fqdn: trunk.fqdn,
    transport: trunk.transport,
  });
  const allocation = await updateWidgetVoiceDidAllocation({
    organizationId,
    deploymentId: widget.id,
    trunkId: trunk.id,
    sipUri: genesysSipUri,
    error: null,
  });
  return {
    allocation,
    trunk,
    didPools,
    genesysSipUri,
    names: publishedWidgetVoiceResourceNames(widget),
  };
}

export async function ensurePublishedWidgetVoiceRouting({
  organizationId,
  widget,
  context,
  queues,
  publicBaseUrl,
  trunkId,
  reservedRouting = null,
  onProgress = () => {},
}) {
  const installationNames = installationResourceNames();
  let reserved = null;
  try {
    reserved = reservedRouting || await reservePublishedWidgetVoiceRouting({
      organizationId,
      widget,
      context,
      trunkId,
      onProgress,
    });
    let allocation = await updateWidgetVoiceDidAllocation({
      organizationId,
      deploymentId: widget.id,
      status: "provisioning",
      trunkId: reserved.trunk.id,
      sipUri: reserved.genesysSipUri,
      error: null,
    });
    const handoffScript = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure Genesys handoff script: ${installationNames.audioHandoffScript}`,
      operation: () => ensureGenesysAiHandoffScript({
        environment: context.environment,
        accessToken: context.accessToken,
        scriptsApi: context.scriptsApi,
        scriptName: installationNames.audioHandoffScript,
        baseUrl: publicBaseUrl,
      }),
      successDetail: (result) => `published · ${result.id}`,
    });
    const callFlows = await runWidgetDeploymentStep({
      onProgress,
      label: "Load Genesys inbound call flows",
      operation: () => listInboundCallFlows(context.architectApi, { includeUnpublished: true }),
      successDetail: (items) => `${items.length} flow(s) available`,
    });
    const existingFlow = callFlows.find((flow) =>
      flow.id === allocation.genesys_flow_id || flow.name === reserved.names.flowName
    );
    const flow = await runWidgetDeploymentStep({
      onProgress,
      label: `Publish Genesys voice routing flow: ${reserved.names.flowName}`,
      operation: () => publishWidgetVoiceFlow({
        environment: context.environment,
        accessToken: context.accessToken,
        flowName: reserved.names.flowName,
        queues,
        existingFlow,
        handoffScriptId: handoffScript.id,
      }),
      successDetail: (result) =>
        `${existingFlow ? "updated and published" : "created and published"} · ${result.id}`,
    });
    allocation = await updateWidgetVoiceDidAllocation({
      organizationId,
      deploymentId: widget.id,
      flowId: flow.id,
    });
    const poolResult = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure single-number Genesys DID pool: ${allocation.phone_number}`,
      operation: () => ensureWidgetVoiceDidPool({
        telephonyApi: context.telephonyApi,
        didPools: reserved.didPools,
        didPoolId: allocation.genesys_did_pool_id,
        name: reserved.names.didPoolName,
        phoneNumber: allocation.phone_number,
        deploymentId: widget.id,
      }),
      successDetail: ({ didPool, created }) =>
        `${created ? "created" : "reused"} · ${didPool.id}`,
    });
    allocation = await updateWidgetVoiceDidAllocation({
      organizationId,
      deploymentId: widget.id,
      didPoolId: poolResult.didPool.id,
    });
    const ivrResult = await runWidgetDeploymentStep({
      onProgress,
      label: `Assign ${allocation.phone_number} to the managed Genesys voice flow`,
      operation: () => ensureWidgetVoiceIvrRoute({
        architectApi: context.architectApi,
        ivrId: allocation.genesys_ivr_id,
        name: reserved.names.ivrName,
        phoneNumber: allocation.phone_number,
        flow,
        deploymentId: widget.id,
      }),
      successDetail: ({ ivr, created }) =>
        `${created ? "created" : "updated"} · route ${ivr.id}`,
    });
    allocation = await updateWidgetVoiceDidAllocation({
      organizationId,
      deploymentId: widget.id,
      status: "active",
      ivrId: ivrResult.ivr.id,
      sipUri: reserved.genesysSipUri,
      error: null,
    });
    return {
      allocation,
      trunk: reserved.trunk,
      flow,
      didPool: poolResult.didPool,
      ivr: ivrResult.ivr,
      genesysSipUri: reserved.genesysSipUri,
    };
  } catch (error) {
    if (reserved?.allocation) {
      await updateWidgetVoiceDidAllocation({
        organizationId,
        deploymentId: widget.id,
        status: "failed",
        error: error?.message || error,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function provisionManagedWidgetVoiceRouting({
  plan,
  context,
  queues,
  handoffScriptId,
  onProgress,
}) {
  let allocation = null;
  try {
    const didPools = await runWidgetDeploymentStep({
      onProgress,
      label: "Load Genesys DID pools for the synthetic Widget namespace",
      operation: () => loadGenesysDidPools(context.telephonyApi),
      successDetail: (items) => `${items.length} DID pool(s) checked`,
    });
    const reservation = await runWidgetDeploymentStep({
      onProgress,
      label: `Reserve the first free Widget routing DID (${WIDGET_VOICE_DID_NAMESPACE_START}-${WIDGET_VOICE_DID_NAMESPACE_END})`,
      operation: () => reserveWidgetVoiceDid({
        organizationId: context.organization.id,
        deploymentId: plan.deployment.id,
        genesysUsedNumbers: phoneNumbersCoveredByDidPools(didPools),
      }),
      successDetail: ({ allocation: value, created }) =>
        `${created ? "reserved" : "reused"} · ${value.phone_number}`,
    });
    allocation = reservation.allocation;
    allocation = await updateWidgetVoiceDidAllocation({
      organizationId: context.organization.id,
      deploymentId: plan.deployment.id,
      status: "provisioning",
      trunkId: plan.voice.sipDestination.trunk.id,
      error: null,
    });

    const callFlows = await runWidgetDeploymentStep({
      onProgress,
      label: "Load Genesys inbound call flows",
      operation: () => listInboundCallFlows(context.architectApi, { includeUnpublished: true }),
      successDetail: (items) => `${items.length} flow(s) available`,
    });
    const existingFlow = callFlows.find((flow) =>
      flow.id === allocation.genesys_flow_id || flow.name === plan.voice.routingFlow.name
    );
    const flow = await runWidgetDeploymentStep({
      onProgress,
      label: `Publish Genesys voice routing flow: ${plan.voice.routingFlow.name}`,
      operation: () => publishWidgetVoiceFlow({
        environment: context.environment,
        accessToken: context.accessToken,
        flowName: plan.voice.routingFlow.name,
        queues,
        existingFlow,
        handoffScriptId,
      }),
      successDetail: (result) =>
        `${existingFlow ? "updated and published" : "created and published"} · ${result.id}`,
    });
    allocation = await updateWidgetVoiceDidAllocation({
      organizationId: context.organization.id,
      deploymentId: plan.deployment.id,
      flowId: flow.id,
    });

    const poolResult = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure single-number Genesys DID pool: ${allocation.phone_number}-${allocation.phone_number}`,
      operation: () => ensureWidgetVoiceDidPool({
        telephonyApi: context.telephonyApi,
        didPools,
        didPoolId: allocation.genesys_did_pool_id,
        name: plan.resources.voiceDidPool.name,
        phoneNumber: allocation.phone_number,
        deploymentId: plan.deployment.id,
      }),
      successDetail: ({ didPool, created }) =>
        `${created ? "created" : "reused"} · ${didPool.id}`,
    });
    allocation = await updateWidgetVoiceDidAllocation({
      organizationId: context.organization.id,
      deploymentId: plan.deployment.id,
      didPoolId: poolResult.didPool.id,
    });

    const ivrResult = await runWidgetDeploymentStep({
      onProgress,
      label: `Assign ${allocation.phone_number} to the managed Genesys voice flow`,
      operation: () => ensureWidgetVoiceIvrRoute({
        architectApi: context.architectApi,
        ivrId: allocation.genesys_ivr_id,
        name: plan.resources.voiceIvr.name,
        phoneNumber: allocation.phone_number,
        flow,
        deploymentId: plan.deployment.id,
      }),
      successDetail: ({ ivr, created }) =>
        `${created ? "created" : "updated"} · route ${ivr.id}`,
    });
    const genesysSipUri = buildGenesysSipUri({
      did: allocation.phone_number,
      fqdn: plan.voice.sipDestination.trunk.fqdn,
      transport: plan.voice.sipDestination.trunk.transport,
    });
    allocation = await runWidgetDeploymentStep({
      onProgress,
      label: "Activate the Widget voice DID allocation in PostgreSQL",
      operation: () => updateWidgetVoiceDidAllocation({
        organizationId: context.organization.id,
        deploymentId: plan.deployment.id,
        status: "active",
        ivrId: ivrResult.ivr.id,
        sipUri: genesysSipUri,
        error: null,
      }),
      successDetail: `${allocation.phone_number} → ${genesysSipUri}`,
    });
    return {
      allocation,
      flow,
      didPool: poolResult.didPool,
      ivr: ivrResult.ivr,
      genesysSipUri,
    };
  } catch (error) {
    if (allocation) {
      await updateWidgetVoiceDidAllocation({
        organizationId: context.organization.id,
        deploymentId: plan.deployment.id,
        status: "failed",
        error: error?.message || error,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function applyWidgetInstallationPlan(planPath, {
  context: suppliedContext,
  telnyx: suppliedTelnyx,
  options = {},
  onProgress = () => {},
} = {}) {
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8"));
  if (plan.schemaVersion !== 2) throw new Error("Unsupported widget plan version; create a new plan");
  const context = suppliedContext || await runWidgetDeploymentStep({
    onProgress,
    label: "Load current Genesys deployment inventory",
    operation: connectGenesysWidget,
    successDetail: "loaded",
  });
  const allowedOrigins = await runWidgetDeploymentStep({
    onProgress,
    label: "Validate Widget deployment plan and public origins",
    operation: async () => {
      assertPlanContext(plan, context);
      return addWidgetAdministrationOrigin(
        parseAllowedOrigins((plan.messaging.allowedOrigins || []).join(",")),
        plan.publicBaseUrl
      );
    },
    successDetail: (origins) => `${plan.messaging.queues.length} queues · ${origins.length} origins`,
  });
  if (plan.voice?.enabled && plan.voice.sipDestination?.mode === "managed-did") {
    await runWidgetDeploymentStep({
      onProgress,
      label: "Validate the Genesys BYOC trunk for managed voice routing",
      operation: async () => {
        const inventory = await loadGenesysSipInventory({
          telephonyApi: context.telephonyApi,
          architectApi: context.architectApi,
          environment: context.environment,
        });
        const trunk = resolveGenesysByocTrunk(
          inventory,
          plan.voice.sipDestination.trunk.id
        );
        if (trunk.fqdn !== plan.voice.sipDestination.trunk.fqdn) {
          throw new Error("Genesys BYOC trunk FQDN changed; create a new Widget deployment plan");
        }
        return trunk;
      },
      successDetail: (trunk) => `${trunk.name} · ${trunk.fqdn}`,
    });
  }
  if (plan.voice?.enabled) {
    await runWidgetDeploymentStep({
      onProgress,
      label: "Save the Widget WebRTC caller number to local environment",
      operation: () => saveWidgetEnvironmentValues({
        values: {
          TELNYX_WIDGET_CALLER_NUMBER: normalizeTelnyxWebCallerNumber(
            plan.voice.callerNumber
          ),
        },
        replaceNames: ["TELNYX_WIDGET_CALLER_NUMBER"],
      }),
      successDetail: "TELNYX_WIDGET_CALLER_NUMBER saved to .env",
    });
  }
  const existingGroups = [];
  for (const expected of plan.access.groups) {
    const current = await runWidgetDeploymentStep({
      onProgress,
      label: `Use Genesys access group: ${expected.name}`,
      operation: async () => {
        const match = context.groups.find((entry) => entry.id === expected.id);
        if (!match || match.name !== expected.name) {
          throw new Error(`Genesys group ${expected.name} (${expected.id}) is missing or changed`);
        }
        return match;
      },
      successDetail: `reused · ${expected.id}`,
    });
    existingGroups.push(current);
  }
  const createdGroups = [];
  for (const requested of plan.access.createGroups || []) {
    const result = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure Genesys access group: ${requested.name}`,
      operation: () => ensureWidgetAccessGroup({
        groupsApi: context.groupsApi,
        existingGroups: [...context.groups, ...createdGroups],
        name: requested.name,
      }),
      successDetail: ({ group, created }) => `${created ? "created" : "reused"} · ${group.id}`,
    });
    if (result.created) createdGroups.push(result.group);
    else if (!existingGroups.some(({ id }) => id === result.group.id)) existingGroups.push(result.group);
  }
  const groups = [...existingGroups, ...createdGroups];
  if (!groups.length) throw new Error("Widget deployment has no Genesys access group");
  const queues = await runWidgetDeploymentStep({
    onProgress,
    label: "Validate Genesys handoff queue allowlist",
    operation: async () => plan.messaging.queues.map((expected) => {
      const current = context.queues.find((entry) => entry.id === expected.id);
      if (!current || current.name !== expected.name) {
        throw new Error(`Genesys queue ${expected.name} (${expected.id}) is missing or changed`);
      }
      return { id: current.id, name: current.name };
    }),
    successDetail: (items) => items.map(({ name }) => name).join(", "),
  });

  const managedDeployments = await listManagedWidgetDeployments({ options });
  let agentExperience = null;
  if (plan.voice?.enabled) {
    const allAgentGroups = [
      ...groups.map(({ id, name }) => ({ id, name })),
      ...managedDeployments.flatMap((deployment) => deployment.access?.groups || []),
    ].filter(({ id, name }) => id && name);
    const allAgentQueues = [
      ...queues.map(({ name }) => name),
      ...managedDeployments.flatMap((deployment) =>
        (deployment.messaging?.queues || []).map(({ name }) => name)
      ),
    ].filter(Boolean);
    const uniqueGroups = [...new Map(allAgentGroups.map((group) => [group.id, group])).values()];
    const uniqueQueues = [...new Set(allAgentQueues)];
    const handoffScript = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure Genesys handoff script: ${plan.resourceNames.audioHandoffScript}`,
      operation: () => ensureGenesysAiHandoffScript({
        environment: context.environment,
        accessToken: context.accessToken,
        scriptsApi: context.scriptsApi,
        scriptName: plan.resourceNames.audioHandoffScript,
      }),
      successDetail: (result) => `published · ${result.id}`,
    });
    const interactionWidget = await runWidgetDeploymentStep({
      onProgress,
      label: `Ensure Genesys agent interaction widget: ${plan.resourceNames.audioInteractionWidget}`,
      operation: () => ensureGenesysAiInteractionWidget({
        integrationsApi: context.integrationsApi,
        groupsApi: context.groupsApi,
        routingApi: context.routingApi,
        activate: true,
        queuesJson: JSON.stringify(uniqueQueues),
        groupsJson: JSON.stringify(uniqueGroups),
        widgetName: plan.resourceNames.audioInteractionWidget,
        baseUrl: plan.publicBaseUrl,
      }),
      successDetail: (result) => `enabled · ${result.id}`,
    });
    agentExperience = { handoffScript, interactionWidget };
  }

  const voiceRouting = plan.voice?.enabled && plan.voice.sipDestination?.mode === "managed-did"
    ? await provisionManagedWidgetVoiceRouting({
        plan,
        context,
        queues,
        handoffScriptId: agentExperience?.handoffScript?.id,
        onProgress,
      })
    : plan.voice?.enabled
      ? { genesysSipUri: plan.voice.genesysSipUri }
      : null;

  let messageFlow;
  if (plan.messaging.routingFlow.operation === "reuse") {
    messageFlow = await runWidgetDeploymentStep({
      onProgress,
      label: `Use Genesys Architect flow: ${plan.messaging.routingFlow.name}`,
      operation: async () => {
        const current = context.messageFlows.find(
          (entry) => entry.id === plan.messaging.routingFlow.id
        );
        if (!current || current.name !== plan.messaging.routingFlow.name) {
          throw new Error("The planned Genesys inbound message flow is missing or changed");
        }
        return current;
      },
      successDetail: (result) => `reused · ${result.id}`,
    });
  } else {
    const existingManagedFlow = (context.allMessageFlows || context.messageFlows).find(
      (entry) => entry.name === plan.messaging.routingFlow.name
    );
    messageFlow = await runWidgetDeploymentStep({
      onProgress,
      label: `Publish Genesys Architect flow: ${plan.messaging.routingFlow.name}`,
      operation: () => publishWidgetMessageFlow({
        environment: context.environment,
        accessToken: context.accessToken,
        flowName: plan.messaging.routingFlow.name,
        queues,
        existingFlow: existingManagedFlow,
      }),
      successDetail: (result) => `${existingManagedFlow ? "updated and published" : "created and published"} · ${result.id}`,
    });
  }

  const roleResult = await runWidgetDeploymentStep({
    onProgress,
    label: `Ensure Genesys administrator role: ${plan.resources.role.name}`,
    operation: () => ensureWidgetAdminRole({
      authorizationApi: context.authorizationApi,
      existingRoles: context.roles,
      roleId: plan.resources.role.id,
      name: plan.resources.role.name,
    }),
    successDetail: ({ role, created }) => `${created ? "created" : "reused"} · ${role.id}`,
  });
  await runWidgetDeploymentStep({
    onProgress,
    label: "Grant the Widget administrator role to Genesys groups",
    operation: () => ensureWidgetRoleGroupGrant({
      authorizationApi: context.authorizationApi,
      roleId: roleResult.role.id,
      groupIds: groups.map(({ id }) => id),
      divisionId: context.homeDivision.id,
    }),
    successDetail: groups.map(({ name }) => name).join(", "),
  });
  const oauth = await runWidgetDeploymentStep({
    onProgress,
    label: "Ensure Genesys OAuth client for Widget administration",
    operation: () => ensureWidgetOauthClient({
      context,
      baseUrl: plan.publicBaseUrl,
      name: plan.resources.clientApplication.name,
    }),
    successDetail: (result) => `${result.created ? "created" : "updated"} · ${result.id}`,
  });
  const allGroupIds = [...new Set([
    ...groups.map(({ id }) => id),
    ...managedDeployments.flatMap((deployment) =>
      (deployment.access?.groups || []).map(({ id }) => id)
    ),
  ])];
  const clientApplication = await runWidgetDeploymentStep({
    onProgress,
    label: `Ensure Genesys Client Application: ${plan.resources.clientApplication.name}`,
    operation: () => ensureWidgetClientApplication({
      integrationsApi: context.integrationsApi,
      integrations: context.clientApplications,
      integrationId: plan.resources.clientApplication.id,
      baseUrl: plan.publicBaseUrl,
      groupIds: allGroupIds,
      name: plan.resources.clientApplication.name,
    }),
    successDetail: ({ integration, created }) => `${created ? "created" : "updated"} · ${integration.id}`,
  });
  const openMessaging = await runWidgetDeploymentStep({
    onProgress,
    label: `Ensure Genesys Open Messaging integration: ${plan.resources.openMessaging.name}`,
    operation: () => ensureWidgetOpenMessagingIntegration({
      conversationsApi: context.conversationsApi,
      integrations: context.openMessaging,
      integrationId: plan.resources.openMessaging.id,
      baseUrl: plan.publicBaseUrl,
      secret: required("GC_OPEN_MESSAGING_SECRET"),
      name: plan.resources.openMessaging.name,
    }),
    successDetail: ({ integration, created }) => `${created ? "created" : "updated"} · ${integration.id}`,
  });
  const recipientId = String(openMessaging.integration.recipient?.id || "").trim();
  if (!recipientId) {
    throw new Error("Genesys Open Messaging did not return its Message Routing recipient");
  }
  await runWidgetDeploymentStep({
    onProgress,
    label: "Assign the Open Messaging recipient to the Architect flow",
    operation: () => context.routingApi.putRoutingMessageRecipient(recipientId, {
      flow: { id: messageFlow.id },
    }),
    successDetail: `recipient ${recipientId} → flow ${messageFlow.id}`,
  });
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const [managedHangupTool, managedTransferTool, managedVoiceQueueTool] = await Promise.all([
    getAdminManagedTool({
      organizationId: context.organization.id,
      logicalKey: ADMIN_SHARED_HANGUP_TOOL_KEY,
    }),
    plan.voice?.enabled
      ? getAdminManagedTool({
          organizationId: context.organization.id,
          logicalKey: ADMIN_SIP_TRANSFER_TOOL_KEY,
          scopeType: "deployment",
          scopeId: plan.deployment.id,
        })
      : null,
    plan.voice?.enabled
      ? getAdminManagedTool({
          organizationId: context.organization.id,
          logicalKey: ADMIN_VOICE_QUEUE_TOOL_KEY,
          scopeType: "deployment",
          scopeId: plan.deployment.id,
        })
      : null,
  ]);
  const telnyxResources = await ensureTelnyxWidgetTool({
    telnyx,
    baseUrl: plan.publicBaseUrl,
    assistant: plan.messaging.assistant,
    queues,
    token: widgetHandoffApiKey(),
    displayName: plan.resources.telnyxHandoffTool.name,
    preferredHangupToolId: managedHangupTool?.remoteToolId,
    onProgress,
  });
  const voiceResources = plan.voice?.enabled
    ? await ensureTelnyxWidgetTransferTool({
        telnyx,
        assistantId: plan.voice.assistant?.operation === "reuse"
          ? plan.voice.assistant.id
          : telnyxResources.assistant.id,
        queues,
        displayName: plan.resources.telnyxTransferTool.name,
        from: plan.voice.transferFrom,
        to: voiceRouting.genesysSipUri,
        targetName: plan.voice.transferTargetName,
        handoffToolName: plan.voice.assistant?.operation === "reuse"
          ? null
          : telnyxToolFunctionName(telnyxResources.tool),
        queueToolDisplayName: plan.resources.telnyxVoiceQueueTool?.name ||
          plan.resources.telnyxTransferTool.name,
        queueToolFunctionName: plan.resources.telnyxVoiceQueueTool?.functionName ||
          widgetVoiceQueueFunctionName({ publicId: plan.deployment.id }),
        preferredTransferToolId: managedTransferTool?.remoteToolId,
        preferredQueueToolId: managedVoiceQueueTool?.remoteToolId,
        onProgress,
      })
    : null;
  const widget = await runWidgetDeploymentStep({
    onProgress,
    label: `Publish PostgreSQL Widget configuration: ${plan.deployment.name}`,
    operation: () => ensureManagedWidgetRecord({
      deploymentId: plan.deployment.id,
      name: plan.deployment.name,
      organizationId: context.organization.id,
      assistantId: telnyxResources.assistant.id,
      integrationId: openMessaging.integration.id,
      queues,
      allowedOrigins,
      voice: plan.voice?.enabled
        ? {
            enabled: true,
            assistantId: voiceResources.assistant.id,
            assistantVersionId: plan.voice.assistantVersionId,
            genesysSipUri: voiceRouting.genesysSipUri,
            region: plan.voice.region,
          }
        : { enabled: false },
    }),
    successDetail: (result) => `${result.created ? "created" : "reconciled"} · ${result.publicId}`,
  });
  await runWidgetDeploymentStep({
    onProgress,
    label: "Save shared Widget resource identifiers to local environment",
    operation: () => saveWidgetEnvironmentValues({
      values: {
        GC_WIDGET_ADMIN_ROLE_ID: roleResult.role.id,
        GC_ORGANIZATION_ID: context.organization.id,
      },
      replaceNames: [
        "GC_WIDGET_ADMIN_ROLE_ID",
        "GC_ORGANIZATION_ID",
      ],
    }),
    successDetail: ".env updated",
  });

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deployment: plan.deployment,
    environment: context.environment,
    organization: plan.organization,
    publicBaseUrl: plan.publicBaseUrl,
    access: {
      groups: groups.map(({ id, name }) => ({ id, name })),
      createdGroupIds: createdGroups.map(({ id }) => id),
    },
    messaging: {
      ...plan.messaging,
      allowedOrigins,
      queues,
      assistant: {
        ...plan.messaging.assistant,
        id: telnyxResources.assistant.id,
        name: telnyxResources.assistant.name,
        managed: plan.messaging.assistant.operation === "create-or-update-managed",
      },
      routingFlow: {
        ...plan.messaging.routingFlow,
        id: messageFlow.id,
        name: messageFlow.name,
        managed: plan.messaging.routingFlow.operation === "create-or-update-managed",
      },
      routingConfigured: true,
      recipientId,
    },
    voice: plan.voice?.enabled
      ? {
          ...plan.voice,
          genesysSipUri: voiceRouting.genesysSipUri,
          sipDestination: plan.voice.sipDestination?.mode === "managed-did"
            ? {
                ...plan.voice.sipDestination,
                phoneNumber: voiceRouting.allocation.phone_number,
                didPoolId: voiceRouting.didPool.id,
                ivrId: voiceRouting.ivr.id,
                flowId: voiceRouting.flow.id,
              }
            : plan.voice.sipDestination,
          assistant: {
            ...plan.voice.assistant,
            id: voiceResources.assistant.id,
            name: voiceResources.assistant.name,
          },
        }
      : { enabled: false },
    resources: {
      roleId: roleResult.role.id,
      oauthClientId: oauth.id,
      clientAppIntegrationId: clientApplication.integration.id,
      openMessagingIntegrationId: openMessaging.integration.id,
      telnyxHandoffToolId: telnyxResources.tool.id,
      telnyxHandoffToolManaged: telnyxResources.toolManaged,
      telnyxIntegrationSecretId: telnyxResources.integrationSecret.id,
      telnyxAssistantId: telnyxResources.assistant.id,
      ...(voiceResources
        ? {
            telnyxVoiceAssistantId: voiceResources.assistant.id,
            telnyxTransferToolId: voiceResources.tool.id,
            telnyxTransferToolManaged: voiceResources.toolManaged,
            telnyxVoiceQueueToolId: voiceResources.queueTool.id,
            telnyxVoiceQueueToolManaged: voiceResources.queueToolManaged,
            genesysHandoffScriptId: agentExperience?.handoffScript?.id || null,
            genesysAgentWidgetIntegrationId: agentExperience?.interactionWidget?.id || null,
            ...(voiceRouting?.allocation
              ? {
                  voiceDidAllocationId: voiceRouting.allocation.id,
                  voiceDid: voiceRouting.allocation.phone_number,
                  voiceDidPoolId: voiceRouting.didPool.id,
                  voiceFlowId: voiceRouting.flow.id,
                  voiceIvrId: voiceRouting.ivr.id,
                }
              : {}),
          }
        : {}),
      messageFlowId: messageFlow.id,
      widgetId: widget.id,
      widgetPublicId: widget.publicId,
    },
    resourceNames: {
      ...plan.resourceNames,
      telnyxHandoffTool: telnyxToolDisplayName(telnyxResources.tool),
      ...(voiceResources
        ? {
            telnyxTransferTool: telnyxToolDisplayName(voiceResources.tool),
            telnyxVoiceQueueTool: telnyxToolDisplayName(voiceResources.queueTool),
          }
        : {}),
    },
  };
  const manifestPath = path.join(
    stateDirectory(options),
    "deployments",
    `${manifest.deployment.id}.json`
  );
  await runWidgetDeploymentStep({
    onProgress,
    label: "Write the local Widget deployment manifest",
    operation: () => writeJsonAtomic(manifestPath, manifest),
    successDetail: manifestPath,
  });
  const registerTool = async ({ tool, logicalKey, scopeType, assistantId }) => {
    if (!tool?.id) return null;
    return registerAdminManagedTelnyxTool({
      telnyx,
      organizationId: context.organization.id,
      logicalKey,
      scopeType,
      scopeId: scopeType === "shared" ? "shared" : plan.deployment.id,
      remoteToolId: tool.id,
      component: "widget",
      deploymentId: plan.deployment.id,
      assistantIds: assistantId ? [assistantId] : [],
      metadata: { widgetDeploymentId: plan.deployment.id },
    });
  };
  await runWidgetDeploymentStep({
    onProgress,
    label: "Register managed Telnyx tools and assistant assignments",
    operation: async () => Promise.all([
      registerTool({
        tool: telnyxResources.tool,
        logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY,
        scopeType: "deployment",
        assistantId: telnyxResources.assistant.id,
      }),
      registerTool({
        tool: telnyxResources.hangupTool,
        logicalKey: ADMIN_SHARED_HANGUP_TOOL_KEY,
        scopeType: "shared",
        assistantId: telnyxResources.assistant.id,
      }),
      registerTool({
        tool: voiceResources?.tool,
        logicalKey: ADMIN_SIP_TRANSFER_TOOL_KEY,
        scopeType: "deployment",
        assistantId: voiceResources?.assistant?.id,
      }),
      registerTool({
        tool: voiceResources?.queueTool,
        logicalKey: ADMIN_VOICE_QUEUE_TOOL_KEY,
        scopeType: "deployment",
        assistantId: voiceResources?.assistant?.id,
      }),
    ]),
    successDetail: "tool definitions and assignments saved in PostgreSQL",
  });
  return { manifestPath, manifest };
}

async function synchronizeWidgetDeployment({ deployment, baseUrl, context, telnyx, allGroupIds }) {
  if (
    deployment.environment !== context.environment ||
    deployment.organization?.id !== context.organization?.id
  ) {
    throw new Error(`Widget deployment ${deployment.deployment.id} belongs to another Genesys organization`);
  }
  await ensureWidgetOauthRedirectUri(context.oauthApi, deployment.resources.oauthClientId, baseUrl);
  await ensureWidgetClientApplication({
    integrationsApi: context.integrationsApi,
    integrations: context.clientApplications,
    integrationId: deployment.resources.clientAppIntegrationId,
    baseUrl,
    groupIds: allGroupIds,
  });
  const openMessaging = await ensureWidgetOpenMessagingIntegration({
    conversationsApi: context.conversationsApi,
    integrations: context.openMessaging,
    integrationId: deployment.resources.openMessagingIntegrationId,
    baseUrl,
    secret: required("GC_OPEN_MESSAGING_SECRET"),
    name: deployment.resourceNames.openMessaging,
  });
  const handoffToken = widgetHandoffApiKey();
  const integrationSecret = await ensureTelnyxIntegrationSecret(telnyx, handoffToken);
  const secretIdentifier = integrationSecret.identifier;
  const tool = await telnyx.ai.tools.retrieve(deployment.resources.telnyxHandoffToolId);
  if (tool.display_name !== deployment.resourceNames.telnyxHandoffTool) {
    throw new Error(`Telnyx widget tool ${tool.id} name drift detected`);
  }
  const definition = widgetHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: secretIdentifier,
    queues: mergeGenesysHandoffQueues(tool, deployment.messaging.queues),
    displayName: telnyxToolDisplayName(tool),
    functionName: telnyxToolFunctionName(tool),
  });
  await telnyx.ai.tools.update(tool.id, definition);
  const updated = {
    ...deployment,
    publicBaseUrl: baseUrl,
    updatedAt: new Date().toISOString(),
    resources: {
      ...deployment.resources,
      openMessagingIntegrationId: openMessaging.integration.id,
    },
  };
  delete updated.filePath;
  await writeJsonAtomic(deployment.filePath, updated);
  return {
    deploymentId: deployment.deployment.id,
    publicBaseUrl: baseUrl,
    clientAppIntegrationId: deployment.resources.clientAppIntegrationId,
    openMessagingIntegrationId: openMessaging.integration.id,
    telnyxHandoffToolId: tool.id,
  };
}

async function synchronizeWidgetInfrastructure({ infrastructure, baseUrl, context, telnyx }) {
  if (
    infrastructure.environment !== context.environment ||
    infrastructure.organization?.id !== context.organization?.id
  ) {
    throw new Error("Web Chat infrastructure belongs to another Genesys organization");
  }
  const names = installationResourceNames();
  const openMessagingName = names.widgetOpenMessaging;
  const handoffToolName = names.widgetHandoffTool;
  const openMessaging = await ensureWidgetOpenMessagingIntegration({
    conversationsApi: context.conversationsApi,
    integrations: context.openMessaging,
    integrationId: infrastructure.resources.openMessagingIntegrationId,
    baseUrl,
    secret: required("GC_OPEN_MESSAGING_SECRET"),
    name: openMessagingName,
  });
  const integrationSecret = await ensureTelnyxIntegrationSecret(telnyx, widgetHandoffApiKey());
  const tool = await telnyx.ai.tools.retrieve(infrastructure.resources.telnyxHandoffToolId);
  if (telnyxToolDisplayName(tool) !== handoffToolName) {
    throw new Error(`Shared Telnyx handoff tool ${tool.id} name drift detected`);
  }
  const definition = widgetHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: integrationSecret.identifier,
    queues: mergeGenesysHandoffQueues(tool, infrastructure.messaging.queues),
    defaultQueue: infrastructure.messaging.defaultQueue,
    displayName: handoffToolName,
    functionName: "request_genesys_human_handoff",
  });
  await telnyx.ai.tools.update(tool.id, definition);
  const updated = {
    ...infrastructure,
    publicBaseUrl: baseUrl,
    updatedAt: new Date().toISOString(),
    resources: {
      ...infrastructure.resources,
      openMessagingIntegrationId: openMessaging.integration.id,
      telnyxIntegrationSecretId: integrationSecret.id,
    },
  };
  delete updated.filePath;
  await writeJsonAtomic(infrastructure.filePath, updated);
  return {
    deploymentId: PRIMARY_WIDGET_INFRASTRUCTURE_ID,
    publicBaseUrl: baseUrl,
    openMessagingIntegrationId: openMessaging.integration.id,
    telnyxHandoffToolId: tool.id,
  };
}

export async function syncManagedWidgetDeploymentUrls({
  onProgress = () => {},
  options = {},
  deployments: suppliedDeployments,
  baseUrl = process.env.GC_PUBLIC_BASE_URL,
  context: suppliedContext,
  telnyx: suppliedTelnyx,
} = {}) {
  const deployments = suppliedDeployments || await listManagedWidgetDeployments({ options });
  const infrastructure = await readWidgetInfrastructureManifest({ options });
  if (!deployments.length && !infrastructure) return [];
  const publicBaseUrl = normalizePublicApplicationOrigin(baseUrl);
  const context = suppliedContext || await connectGenesysWidget();
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const allGroupIds = [...new Set(
    deployments.flatMap((deployment) => deployment.access.groups.map(({ id }) => id))
  )];
  const results = [];
  if (infrastructure) {
    onProgress({ status: "running", label: "Updating shared Web Chat infrastructure" });
    results.push(await synchronizeWidgetInfrastructure({
      infrastructure,
      baseUrl: publicBaseUrl,
      context,
      telnyx,
    }));
    onProgress({ status: "success", label: "Updated shared Web Chat infrastructure" });
  }
  for (const deployment of deployments) {
    onProgress({ status: "running", label: `Updating widget deployment ${deployment.deployment.name}` });
    results.push(await synchronizeWidgetDeployment({
      deployment,
      baseUrl: publicBaseUrl,
      context,
      telnyx,
      allGroupIds,
    }));
    onProgress({ status: "success", label: `Updated widget deployment ${deployment.deployment.name}` });
  }
  return results;
}

export async function destroyManagedWidgetDeployment({
  deployment,
  context: suppliedContext,
  telnyx: suppliedTelnyx,
  options = {},
} = {}) {
  const context = suppliedContext || await connectGenesysWidget();
  if (
    deployment.environment !== context.environment ||
    deployment.organization?.id !== context.organization?.id
  ) {
    throw new Error("Widget deployment belongs to a different Genesys organization");
  }
  const openMessaging = context.openMessaging.find(
    (entry) => entry.id === deployment.resources.openMessagingIntegrationId
  );
  if (!openMessaging || openMessaging.name !== deployment.resourceNames.openMessaging) {
    throw new Error("Open Messaging ownership or name drift detected; refusing destroy");
  }
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const tool = await telnyx.ai.tools.retrieve(deployment.resources.telnyxHandoffToolId);
  if (tool.display_name !== deployment.resourceNames.telnyxHandoffTool) {
    throw new Error("Telnyx handoff tool name drift detected; refusing destroy");
  }
  let transferTool = null;
  if (deployment.resources.telnyxTransferToolId) {
    transferTool = await telnyx.ai.tools.retrieve(deployment.resources.telnyxTransferToolId);
    if (transferTool.display_name !== deployment.resourceNames.telnyxTransferTool) {
      throw new Error("Telnyx SIP Transfer tool name drift detected; refusing destroy");
    }
  }
  let voiceQueueTool = null;
  if (deployment.resources.telnyxVoiceQueueToolId) {
    voiceQueueTool = await telnyx.ai.tools.retrieve(deployment.resources.telnyxVoiceQueueToolId);
    if (voiceQueueTool.display_name !== deployment.resourceNames.telnyxVoiceQueueTool) {
      throw new Error("Telnyx voice queue variable tool name drift detected; refusing destroy");
    }
  }
  if (deployment.messaging.routingFlow.managed) {
    const flow = context.messageFlows.find(
      (entry) => entry.id === deployment.resources.messageFlowId
    );
    if (!flow || flow.name !== deployment.resourceNames.messageFlow) {
      throw new Error("Architect message flow ownership or name drift detected; refusing destroy");
    }
  }
  if (deployment.messaging.assistant.managed) {
    const assistant = await telnyx.ai.assistants.retrieve(deployment.resources.telnyxAssistantId);
    if (assistant.name !== deployment.resourceNames.assistant) {
      throw new Error("Telnyx assistant name drift detected; refusing destroy");
    }
  }
  if (deployment.resources.voiceDidPoolId) {
    const didPool = await context.telephonyApi.getTelephonyProvidersEdgesDidpool(
      deployment.resources.voiceDidPoolId
    );
    const description = String(didPool.description || didPool.comments || "");
    if (
      !description.includes("Managed by genesys:widget") ||
      !description.includes(`deployment ${deployment.deployment.id}`) ||
      (didPool.name && didPool.name !== deployment.resourceNames.voiceDidPool) ||
      didPool.startPhoneNumber !== deployment.resources.voiceDid ||
      didPool.endPhoneNumber !== deployment.resources.voiceDid
    ) {
      throw new Error("Managed Genesys voice DID pool ownership or range drift detected; refusing destroy");
    }
  }
  if (deployment.resources.voiceIvrId) {
    const ivr = await context.architectApi.getArchitectIvr(deployment.resources.voiceIvrId, {
      expand: ["dnis"],
    });
    if (
      ivr.name !== deployment.resourceNames.voiceIvr ||
      !(ivr.dnis || []).includes(deployment.resources.voiceDid)
    ) {
      throw new Error("Managed Genesys inbound voice route drift detected; refusing destroy");
    }
  }
  if (deployment.resources.voiceFlowId) {
    const flow = await context.architectApi.getFlow(deployment.resources.voiceFlowId);
    if (flow.name !== deployment.resourceNames.voiceFlow) {
      throw new Error("Managed Genesys voice flow name drift detected; refusing destroy");
    }
  }

  const allDeployments = await listManagedWidgetDeployments({ options });
  const remaining = allDeployments.filter(
    (entry) => entry.deployment.id !== deployment.deployment.id
  );
  const referencedGroupIds = new Set(
    remaining.flatMap((entry) => entry.access.groups.map(({ id }) => id))
  );
  const groupsToDelete = (deployment.access.createdGroupIds || [])
    .filter((groupId) => !referencedGroupIds.has(groupId))
    .map((groupId) => {
      const group = context.groups.find((entry) => entry.id === groupId);
      const expected = deployment.access.groups.find((entry) => entry.id === groupId);
      if (!group || !expected || group.name !== expected.name) {
        throw new Error(`Managed Genesys group ${groupId} drift detected; refusing destroy`);
      }
      return group;
    });

  await context.conversationsApi.deleteConversationsMessagingIntegrationsOpenIntegrationId(
    deployment.resources.openMessagingIntegrationId
  );
  if (deployment.resources.voiceIvrId) {
    await context.architectApi.deleteArchitectIvr(deployment.resources.voiceIvrId);
  }
  if (deployment.resources.voiceFlowId) {
    await context.architectApi.deleteFlow(deployment.resources.voiceFlowId);
  }
  if (deployment.resources.voiceDidPoolId) {
    await context.telephonyApi.deleteTelephonyProvidersEdgesDidpool(
      deployment.resources.voiceDidPoolId
    );
  }
  if (deployment.messaging.routingFlow.managed) {
    await context.architectApi.deleteFlow(deployment.resources.messageFlowId);
  }
  const voiceAssistantWillBeDeleted = deployment.messaging.assistant.managed &&
    deployment.resources.telnyxVoiceAssistantId === deployment.resources.telnyxAssistantId;
  if (
    transferTool &&
    deployment.resources.telnyxTransferToolManaged !== false &&
    !voiceAssistantWillBeDeleted
  ) {
    const voiceAssistant = await telnyx.ai.assistants.retrieve(
      deployment.resources.telnyxVoiceAssistantId
    );
    const [handoffTools, transferTools] = await Promise.all([
      attachedGenesysHandoffTools(telnyx, voiceAssistant),
      attachedTransferTools(telnyx, voiceAssistant),
    ]);
    const remainingTransfer = transferTools.find(
      (entry) => telnyxToolId(entry) !== deployment.resources.telnyxTransferToolId
    );
    await telnyx.ai.assistants.update(voiceAssistant.id, {
      instructions: upsertGenesysUniversalHandoffInstructions(
        voiceAssistant.instructions,
        {
          queues: deployment.messaging.queues,
          handoffToolName: handoffTools[0]
            ? telnyxToolFunctionName(handoffTools[0])
            : null,
          transferToolName: remainingTransfer
            ? telnyxToolDisplayName(remainingTransfer)
            : null,
          voiceQueueToolName: null,
        }
      ),
      tool_ids: assistantSharedToolIds(voiceAssistant).filter(
        (id) => ![
          deployment.resources.telnyxTransferToolId,
          deployment.resources.telnyxVoiceQueueToolId,
        ].includes(id)
      ),
    });
  }
  if (deployment.messaging.assistant.managed) {
    await telnyx.ai.assistants.delete(deployment.resources.telnyxAssistantId);
  }
  if (deployment.resources.telnyxHandoffToolManaged !== false) {
    await telnyx.ai.tools.delete(deployment.resources.telnyxHandoffToolId);
  }
  if (transferTool && deployment.resources.telnyxTransferToolManaged !== false) {
    await telnyx.ai.tools.delete(deployment.resources.telnyxTransferToolId);
  }
  if (voiceQueueTool && deployment.resources.telnyxVoiceQueueToolManaged !== false) {
    await telnyx.ai.tools.delete(deployment.resources.telnyxVoiceQueueToolId);
  }
  await deleteManagedWidgetRecord({
    deploymentId: deployment.deployment.id,
    widgetId: deployment.resources.widgetId,
  });
  if (deployment.resources.voiceDidAllocationId) {
    await deleteWidgetVoiceDidAllocation({
      organizationId: context.organization.id,
      deploymentId: deployment.deployment.id,
    });
  }

  for (const group of groupsToDelete) {
    await context.groupsApi.deleteGroup(group.id);
  }
  const remainingGroupIds = [...referencedGroupIds];
  if (remainingGroupIds.length) {
    await ensureWidgetClientApplication({
      integrationsApi: context.integrationsApi,
      integrations: context.clientApplications,
      integrationId: deployment.resources.clientAppIntegrationId,
      baseUrl: deployment.publicBaseUrl,
      groupIds: remainingGroupIds,
    });
  }

  const archivedDirectory = path.join(stateDirectory(options), "archived");
  await mkdir(archivedDirectory, { recursive: true, mode: 0o700 });
  const archivedPath = path.join(
    archivedDirectory,
    `${deployment.deployment.id}-${Date.now()}.json`
  );
  await rename(deployment.filePath, archivedPath);
  return { archivedPath, deploymentId: deployment.deployment.id };
}

async function commandPrecheck() {
  const missing = missingWidgetConfiguration();
  const database = await checkPostgresStatus();
  const tunnel = await getQuickTunnelStatus();
  const result = { ready: false, missing, database, tunnel: {
    running: tunnel.running,
    healthy: tunnel.healthy,
    publicBaseUrl: tunnel.state?.publicBaseUrl || null,
  } };
  if (!missing.length) {
    const [genesys, telnyx] = await Promise.all([
      verifyGenesysPlatformAccess({
        environment: process.env.GC_ENVIRONMENT,
        clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
        clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
      }),
      verifyTelnyxPlatformAccess({ apiKey: process.env.TELNYX_API_KEY, capability: "widget" }),
    ]);
    result.genesys = { environment: genesys.environment, organization: genesys.organization };
    result.telnyx = telnyx;
  }
  result.ready = !result.missing.length && database.ready;
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

async function commandStatus() {
  const [deployments, database, tunnel] = await Promise.all([
    listManagedWidgetDeployments(),
    checkPostgresStatus(),
    getQuickTunnelStatus(),
  ]);
  console.log(JSON.stringify({
    ready: missingWidgetConfiguration().length === 0 && database.ready,
    missing: missingWidgetConfiguration(),
    publicBaseUrl: process.env.GC_PUBLIC_BASE_URL || null,
    database,
    tunnel: { running: tunnel.running, healthy: tunnel.healthy, state: tunnel.state },
    deployments: deployments.map((deployment) => {
      const output = { ...deployment };
      delete output.filePath;
      return output;
    }),
  }, null, 2));
}

async function collectMissingConfiguration(ui) {
  const missing = missingWidgetConfiguration().filter((name) =>
    name !== "GC_PUBLIC_BASE_URL" && name !== "DATABASE_URL or POSTGRES_* variables"
  );
  const secretMissing = missing.filter((name) => WIDGET_SECRET_VARIABLES.includes(name));
  if (secretMissing.length && await ui.confirm(`Generate ${secretMissing.length} widget secret(s)?`, true)) {
    await saveWidgetEnvironmentValues({ values: generateWidgetSecrets(secretMissing) });
  }
  for (const name of missing.filter((entry) => !WIDGET_SECRET_VARIABLES.includes(entry))) {
    const value = MASKED_VARIABLES.has(name)
      ? await ui.password(`${name}:`, { validate: (input) => String(input).trim() ? true : "Value is required" })
      : await ui.input(`${name}:`, process.env[name], { validate: (input) => String(input).trim() ? true : "Value is required" });
    await saveWidgetEnvironmentValues({ values: { [name]: String(value).trim() } });
  }
  if (!databaseConfigurationPresent()) {
    const mode = await ui.selectMenu("Configure PostgreSQL for widget state", [
      { label: "Enter DATABASE_URL", value: "url" },
      { label: "Enter POSTGRES_HOST / DB / USER / PASSWORD", value: "fields" },
    ]);
    if (mode === "url") {
      const value = await ui.password("DATABASE_URL:", {
        validate: (input) => String(input).trim() ? true : "DATABASE_URL is required",
      });
      await saveWidgetEnvironmentValues({ values: { DATABASE_URL: String(value).trim() } });
    } else {
      const values = {};
      for (const [name, fallback] of [
        ["POSTGRES_HOST", "127.0.0.1"],
        ["POSTGRES_PORT", "5432"],
        ["POSTGRES_DB", "telnyx_genesys"],
        ["POSTGRES_USER", "postgres"],
      ]) {
        values[name] = String(await ui.input(`${name}:`, fallback, {
          validate: (input) => String(input).trim() ? true : `${name} is required`,
        })).trim();
      }
      values.POSTGRES_PASSWORD = String(await ui.password("POSTGRES_PASSWORD:")).trim();
      await saveWidgetEnvironmentValues({ values });
    }
  }
}

export async function configurePublicUrl(ui, {
  environment = process.env,
  updatePublicOrigin = updateManagedPublicOrigin,
  startTunnel = startCloudflareQuickTunnel,
  stopTunnel = stopCloudflareQuickTunnel,
} = {}) {
  if (String(environment.GC_PUBLIC_BASE_URL || "").trim()) return true;
  const action = await ui.selectMenu("Configure public application URL", [
    { label: "Start managed Cloudflare Quick Tunnel", value: "tunnel" },
    { label: "Use an existing public HTTPS origin", value: "manual" },
    { label: "Exit", value: "exit" },
  ]);
  if (action === "exit") return false;
  if (action === "manual") {
    const value = await ui.input("GC_PUBLIC_BASE_URL:", "", {
      validate(input) { try { normalizePublicApplicationOrigin(input); return true; } catch (error) { return error.message; } },
    });
    await updatePublicOrigin({ baseUrl: value, environment });
    return true;
  }
  const tunnel = await startTunnel({
    onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
  });
  try {
    await updatePublicOrigin({ baseUrl: tunnel.publicBaseUrl, environment });
  } catch (error) {
    if (!tunnel.reused) await stopTunnel().catch(() => {});
    throw error;
  }
  return true;
}

function printLocalConfigurationPrecheck(ui, environment = process.env) {
  console.log(ui.color.bold("\nLocal configuration precheck"));
  const checks = [
    ["Genesys environment", ["GC_ENVIRONMENT"]],
    ["Genesys client credentials", ["GC_CLIENT_CRED_CLIENT_ID", "GC_CLIENT_CRED_CLIENT_SECRET"]],
    ["Telnyx API access", ["TELNYX_API_KEY"]],
    ["Public application URL", ["GC_PUBLIC_BASE_URL"]],
    ["Widget secrets", WIDGET_SECRET_VARIABLES],
  ];
  for (const [label, names] of checks) {
    const absent = names.filter((name) => !String(environment[name] || "").trim());
    ui.printCheck(
      label,
      absent.length ? "missing" : "ok",
      absent.length ? absent.join(", ") : "configured"
    );
  }
  const databaseConfigured = databaseConfigurationPresent(environment);
  ui.printCheck(
    "PostgreSQL configuration",
    databaseConfigured ? "ok" : "missing",
    databaseConfigured ? "configured" : "DATABASE_URL or POSTGRES_* required"
  );
}

async function runInteractivePrecheck(ui) {
  console.log(ui.color.bold("\nConnectivity precheck"));
  const database = await ui.withSpinner("Checking PostgreSQL connectivity", checkPostgresStatus);
  ui.printCheck(
    "PostgreSQL connectivity",
    database.ready ? "ok" : "missing",
    database.ready ? database.status : database.error
  );
  if (!database.ready) {
    throw new Error(`PostgreSQL precheck failed: ${database.error || database.status}`);
  }

  const genesys = await ui.withSpinner("Checking Genesys Cloud credentials", () =>
    verifyGenesysPlatformAccess({
      environment: process.env.GC_ENVIRONMENT,
      clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
      clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
    })
  );
  ui.printCheck(
    "Genesys Cloud access",
    "ok",
    `${genesys.organization.name} (${genesys.environment})`
  );

  await ui.withSpinner("Checking Telnyx API and AI Assistants access", () =>
    verifyTelnyxPlatformAccess({ apiKey: process.env.TELNYX_API_KEY, capability: "widget" })
  );
  ui.printCheck("Telnyx API access", "ok", "AI Assistants available");
}

async function selectWidgetGroups(ui, context, selectedIds = []) {
  const createValue = "__create_widget_group__";
  const values = await ui.checkboxMenu(
    "Groups allowed to open widget administration",
    [
      ...context.groups.map((group) => ({
        label: group.name,
        value: group.id,
        checked: selectedIds.includes(group.id),
      })),
      { label: "+ Create a new Genesys group during deployment", value: createValue },
    ],
    { validate: (selected) => selected.length ? true : "Select or create at least one group" }
  );
  const createGroupNames = [];
  if (values.includes(createValue)) {
    createGroupNames.push(String(await ui.input("New Genesys group name", installationResourceNames().adminGroup, {
      validate: (value) => String(value).trim() ? true : "Group name is required",
    })).trim());
  }
  return {
    groupIds: values.filter((value) => value !== createValue),
    createGroupNames,
  };
}

function parseAllowedOrigins(value) {
  const origins = csv(value);
  if (!origins.length) throw new Error("At least one embedding origin is required");
  return origins.map((origin) => {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin.replace(/\/$/, "")) {
      throw new Error(`Invalid exact embedding origin: ${origin}`);
    }
    return url.origin;
  });
}

export function addWidgetAdministrationOrigin(origins, publicBaseUrl) {
  const adminOrigin = normalizePublicApplicationOrigin(publicBaseUrl);
  const allowedOrigins = [...new Set([...origins, adminOrigin])];
  if (allowedOrigins.length > 50) throw new Error("A widget can allow at most 50 origins");
  return allowedOrigins;
}

async function selectGenesysVoiceSipDestination(ui, context, {
  currentSipUri = "",
  currentMode = "managed-did",
} = {}) {
  const mode = await ui.selectMenu("Genesys Cloud SIP destination for voice transfer", [
    {
      label: "Create managed voice routing on a Genesys BYOC trunk",
      value: "managed-did",
      description: `Creates one single-number DID pool per deployment from ${WIDGET_VOICE_DID_NAMESPACE_START}-${WIDGET_VOICE_DID_NAMESPACE_END}.`,
    },
    {
      label: "Enter a custom SIP URI (advanced)",
      value: "manual",
      description: "Use for SBC, TGRP, custom-header or other non-standard SIP routing.",
    },
  ]);
  if (mode === "manual") {
    const genesysSipUri = String(await ui.input(
      "Genesys Cloud SIP URI for voice transfer",
      currentMode === "manual" ? currentSipUri : "",
      {
        validate(value) {
          try { normalizeGenesysSipUri(value); return true; } catch (error) { return error.message; }
        },
      }
    )).trim();
    return {
      genesysSipUri: normalizeGenesysSipUri(genesysSipUri),
      trunkId: "",
      did: "",
      transferTargetName: "Genesys Cloud",
    };
  }

  const inventory = await ui.withSpinner(
    "Loading Genesys BYOC trunks",
    () => loadGenesysSipInventory({
      telephonyApi: context.telephonyApi,
      architectApi: context.architectApi,
      environment: context.environment,
    })
  );
  context.sipInventory = inventory;
  const compatibleTrunks = inventory.trunks.filter((trunk) =>
    trunk.enabled &&
    !trunk.dnisReplacementEnabled &&
    (!trunk.routingAddress || trunk.routingAddress === "Request-URI")
  );
  if (!compatibleTrunks.length) {
    throw new Error(
      "No active Genesys BYOC trunk with FQDN/Request-URI routing was found; use the advanced custom SIP URI option"
    );
  }
  const trunkId = await ui.selectMenu(
    "Select the Genesys BYOC trunk for inbound voice handoff",
    compatibleTrunks.map((trunk) => ({
      label: `${trunk.name} — ${trunk.fqdn}`,
      value: trunk.id,
      description: [
        trunk.trunkMetabase?.name,
        trunk.transport ? trunk.transport.toUpperCase() : null,
        trunk.platform === "dynamic-cloud-voice" ? "Dynamic Cloud Voice" : "BYOC Cloud",
      ].filter(Boolean).join(" · "),
    })),
    { pageSize: 20 }
  );
  const trunk = resolveGenesysByocTrunk(inventory, trunkId);
  console.log(ui.color.muted(
    `A first-free synthetic DID will be reserved during apply and its SIP target will use ${trunk.fqdn}.`
  ));
  console.log(ui.color.muted(
    "Genesys will contain one single-number DID pool and one inbound route for this deployment only."
  ));
  return {
    genesysSipUri: "",
    trunkId,
    did: "",
    transferTargetName: `Genesys Cloud - ${trunk.name}`,
  };
}

async function createDeploymentInteractive(ui, context) {
  if (!context.queues.length) throw new Error("No Genesys queues are available for widget handoff");
  const publicBaseUrl = normalizePublicApplicationOrigin(process.env.GC_PUBLIC_BASE_URL);
  const applicationName = String(await ui.input(
    "Widget deployment application name",
    "Telnyx AI Customer Service Widget",
    { validate: (value) => String(value).trim() ? true : "Deployment name is required" }
  )).trim();
  const groups = await selectWidgetGroups(ui, context);
  const queueIds = await ui.checkboxMenu(
    "Select every Genesys queue the assistant may use for messaging or voice handoff",
    context.queues.map((queue) => ({ label: queue.name, value: queue.id })),
    { pageSize: 20, validate: (values) => values.length ? true : "Select at least one handoff queue" }
  );
  const flowMode = await ui.selectMenu("Inbound message flow for the Open Messaging recipient", [
    {
      label: "Create a managed routing flow",
      value: "create",
      description: "Creates a flow that selects one of the allowed queues from the validated handoff queue ID.",
    },
    ...(context.messageFlows.length ? [{ label: "Use an existing published flow", value: "existing" }] : []),
  ]);
  const messageFlowId = flowMode === "existing"
    ? await ui.selectMenu(
        "Select an existing published inbound message flow",
        context.messageFlows.map((flow) => ({ label: flow.name, value: flow.id }))
      )
    : "";

  const telnyx = new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const assistants = await ui.withSpinner("Loading Telnyx messaging assistants", () =>
    listTelnyxAssistants(telnyx)
  );
  const assistantMode = await ui.selectMenu("Telnyx messaging assistant", [
    {
      label: "Create a managed messaging assistant",
      value: "create",
      description: "Creates an assistant with deployment-specific handoff instructions and tool.",
    },
    ...(assistants.length ? [{ label: "Attach handoff to an existing assistant", value: "existing" }] : []),
  ]);
  const assistantId = assistantMode === "existing"
    ? await ui.selectMenu(
        "Select a Telnyx messaging assistant",
        assistants.map((assistant) => ({ label: assistant.name || assistant.id, value: assistant.id }))
      )
    : "";
  const voiceEnabled = await ui.confirm(
    "Enable WebRTC voice through the Telnyx AI Agent Library?",
    false
  );
  let voiceAssistantId = "";
  let genesysSipUri = "";
  let webCallerNumber = "";
  let voiceRegion = "auto";
  let voiceAssistantVersionId = "main";
  let genesysTrunkId = "";
  let voiceTransferTargetName = "Genesys Cloud";
  if (voiceEnabled) {
    const voiceAssistantMode = await ui.selectMenu("Telnyx assistant for WebRTC voice", [
      {
        label: "Use the same assistant as messaging",
        value: "messaging",
        description: "Attaches both the channel-aware webhook and Genesys SIP Transfer tool to one assistant.",
      },
      ...(assistants.length
        ? [{ label: "Use another existing assistant", value: "existing" }]
        : []),
    ]);
    if (voiceAssistantMode === "existing") {
      voiceAssistantId = await ui.selectMenu(
        "Select a Telnyx voice assistant",
        assistants.map((assistant) => ({ label: assistant.name || assistant.id, value: assistant.id }))
      );
    }
    const sipDestination = await selectGenesysVoiceSipDestination(ui, context);
    genesysSipUri = sipDestination.genesysSipUri;
    genesysTrunkId = sipDestination.trunkId;
    voiceTransferTargetName = sipDestination.transferTargetName;
    webCallerNumber = String(await ui.input(
      "Telnyx E.164 number sent as callerNumber for Widget WebRTC calls",
      process.env.TELNYX_WIDGET_CALLER_NUMBER || "",
      {
        validate(value) {
          try { normalizeTelnyxWebCallerNumber(value); return true; } catch (error) { return error.message; }
        },
      }
    )).trim();
    voiceAssistantVersionId = String(await ui.input(
      "Telnyx voice assistant version ID",
      "main",
      { validate: (value) => String(value).trim() ? true : "Assistant version ID is required" }
    )).trim();
    voiceRegion = await ui.selectMenu("Telnyx AI Agent Library media region", [
      { label: "Auto (recommended)", value: "auto" },
      { label: "Europe", value: "eu" },
      { label: "United States — East", value: "us-east" },
      { label: "United States — Central", value: "us-central" },
      { label: "United States — West", value: "us-west" },
      { label: "Canada — Central", value: "ca-central" },
      { label: "Asia Pacific", value: "apac" },
      { label: "South Asia", value: "south-asia" },
    ]);
  }
  console.log(
    ui.color.muted(
      `The administration and preview origin ${publicBaseUrl} will be allowed automatically.`
    )
  );
  const customerOrigins = parseAllowedOrigins(await ui.input(
    "Customer website origins allowed to embed this widget (comma separated)",
    "",
    { validate(value) { try { parseAllowedOrigins(value); return true; } catch (error) { return error.message; } } }
  ));
  const origins = addWidgetAdministrationOrigin(customerOrigins, publicBaseUrl);
  const { outputPath } = await createWidgetInstallationPlan({
    context,
    options: {
      name: applicationName,
      groups: groups.groupIds.join(","),
      "create-group-name": groups.createGroupNames.join(","),
      "queue-ids": queueIds.join(","),
      "message-flow-id": messageFlowId,
      "messaging-assistant-id": assistantId,
      "create-assistant": assistantMode === "create",
      "enable-voice": voiceEnabled,
      "voice-assistant-id": voiceAssistantId,
      "genesys-sip-uri": genesysSipUri,
      "genesys-trunk-id": genesysTrunkId,
      "voice-transfer-target-name": voiceTransferTargetName,
      "web-caller-number": webCallerNumber,
      "voice-assistant-version-id": voiceAssistantVersionId,
      "voice-region": voiceRegion,
      "allowed-origins": origins.join(","),
    },
  });
  if (!(await ui.confirm("Apply this Widget deployment plan to Genesys Cloud, Telnyx and PostgreSQL?", false))) {
    console.log(ui.color.warning(`Installation cancelled. Plan retained at ${outputPath}`));
    return null;
  }
  console.log(ui.color.bold("\nApplying Widget deployment"));
  const result = await applyWidgetInstallationPlan(outputPath, {
    context,
    telnyx,
    onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
  });
  console.log(ui.color.success(`Widget deployment created: ${result.manifest.deployment.name}`));
  console.log(`Widget public ID: ${result.manifest.resources.widgetPublicId}`);
  console.log(`Administration: ${widgetAdminUrl(result.manifest.publicBaseUrl)}`);
  if (result.manifest.voice?.enabled) {
    console.log(ui.color.warning(
      "TELNYX_WIDGET_CALLER_NUMBER was saved. Restart an already running application process so it reloads the updated .env value."
    ));
  }
  await ui.pause();
  return result;
}

function printWidgetDeployment(deployment) {
  console.log(`\nDeployment: ${deployment.deployment.name}`);
  console.log(`Widget public ID: ${deployment.resources.widgetPublicId}`);
  console.log(`Queues: ${deployment.messaging.queues.map(({ name }) => name).join(", ")}`);
  console.log(`Admin groups: ${deployment.access.groups.map(({ name }) => name).join(", ")}`);
  console.log(`Telnyx assistant: ${deployment.messaging.assistant.name || deployment.resources.telnyxAssistantId}`);
  console.log(`WebRTC voice: ${deployment.voice?.enabled ? "enabled" : "disabled"}`);
  if (deployment.voice?.enabled) {
    console.log(`Voice assistant: ${deployment.voice.assistant?.name || deployment.resources.telnyxVoiceAssistantId}`);
    console.log(`Genesys SIP transfer: ${deployment.voice.genesysSipUri}`);
    if (deployment.voice.sipDestination?.mode === "managed-did") {
      console.log(`Genesys BYOC trunk: ${deployment.voice.sipDestination.trunk.name}`);
      console.log(`Managed Genesys DID: ${deployment.voice.sipDestination.phoneNumber}`);
      console.log(`Managed DID pool: ${deployment.resources.voiceDidPoolId}`);
      console.log(`Managed voice flow: ${deployment.resources.voiceFlowId}`);
    }
  }
  console.log(`Open Messaging: ${deployment.resources.openMessagingIntegrationId}`);
  console.log(`Architect flow: ${deployment.messaging.routingFlow.name}`);
  console.log(`Public URL: ${deployment.publicBaseUrl}`);
}

async function modifyWidgetDeployment(ui, deployment, context) {
  const action = await ui.selectMenu(`Modify ${deployment.deployment.name}`, [
    { label: "Allowed handoff queues", value: "queues" },
    { label: "Widget administration groups", value: "groups" },
    { label: "Embedding website origins", value: "origins" },
    ...(deployment.voice?.enabled
      ? [{ label: "Genesys voice SIP destination", value: "voice-destination" }]
      : []),
    { label: "Reapply and reconcile current configuration", value: "reapply" },
    ui.backOption(),
  ]);
  if (action === "back") return deployment;
  let queueIds = deployment.messaging.queues.map(({ id }) => id);
  let groupIds = deployment.access.groups.map(({ id }) => id);
  let createGroupNames = [];
  let allowedOrigins = deployment.messaging.allowedOrigins;
  let genesysSipUri = deployment.voice?.genesysSipUri || "";
  let genesysTrunkId = deployment.voice?.sipDestination?.mode === "managed-did"
    ? deployment.voice.sipDestination.trunk.id
    : "";
  let voiceTransferTargetName = deployment.voice?.transferTargetName || "Genesys Cloud";
  if (action === "queues") {
    queueIds = await ui.checkboxMenu(
      "Select every allowed Genesys handoff queue",
      context.queues.map((queue) => ({
        label: queue.name,
        value: queue.id,
        checked: queueIds.includes(queue.id),
      })),
      { validate: (values) => values.length ? true : "Select at least one queue" }
    );
  }
  if (action === "groups") {
    const selection = await selectWidgetGroups(ui, context, groupIds);
    groupIds = selection.groupIds;
    createGroupNames = selection.createGroupNames;
  }
  if (action === "origins") {
    const publicBaseUrl = normalizePublicApplicationOrigin(process.env.GC_PUBLIC_BASE_URL);
    const customerOrigins = allowedOrigins.filter((origin) => origin !== publicBaseUrl);
    console.log(
      ui.color.muted(
        `The administration and preview origin ${publicBaseUrl} will be allowed automatically.`
      )
    );
    allowedOrigins = addWidgetAdministrationOrigin(parseAllowedOrigins(await ui.input(
      "Customer website origins allowed to embed this widget (comma separated)",
      customerOrigins.join(","),
      { validate(value) { try { parseAllowedOrigins(value); return true; } catch (error) { return error.message; } } }
    )), publicBaseUrl);
  }
  if (action === "voice-destination") {
    const selection = await selectGenesysVoiceSipDestination(ui, context, {
      currentSipUri: genesysSipUri,
      currentMode: deployment.voice?.sipDestination?.mode || "manual",
    });
    genesysSipUri = selection.genesysSipUri;
    genesysTrunkId = selection.trunkId;
    voiceTransferTargetName = selection.transferTargetName;
  }
  const { outputPath } = await createWidgetInstallationPlan({
    context,
    options: {
      id: deployment.deployment.id,
      name: deployment.deployment.applicationName,
      groups: groupIds.join(","),
      "create-group-name": createGroupNames.join(","),
      "queue-ids": queueIds.join(","),
      "message-flow-id": deployment.messaging.routingFlow.managed ? "" : deployment.messaging.routingFlow.id,
      "messaging-assistant-id": deployment.messaging.assistant.managed ? "" : deployment.resources.telnyxAssistantId,
      "create-assistant": deployment.messaging.assistant.managed,
      "enable-voice": deployment.voice?.enabled === true,
      "voice-assistant-id": deployment.voice?.assistant?.operation === "reuse"
        ? deployment.voice.assistant.id
        : "",
      "genesys-sip-uri": genesysSipUri,
      "genesys-trunk-id": genesysTrunkId,
      "web-caller-number": process.env.TELNYX_WIDGET_CALLER_NUMBER ||
        deployment.voice?.callerNumber || "",
      "voice-transfer-target-name": voiceTransferTargetName,
      "voice-assistant-version-id": deployment.voice?.assistantVersionId || "main",
      "voice-region": deployment.voice?.region || "auto",
      "allowed-origins": allowedOrigins.join(","),
    },
  });
  if (!(await ui.confirm("Apply these changes to this Widget deployment?", false))) return deployment;
  console.log(ui.color.bold("\nUpdating Widget deployment"));
  const result = await applyWidgetInstallationPlan(outputPath, {
    context,
    onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
  });
  console.log(ui.color.success("Widget deployment updated."));
  if (result.manifest.voice?.enabled) {
    console.log(ui.color.warning(
      "Restart an already running application process if TELNYX_WIDGET_CALLER_NUMBER changed."
    ));
  }
  await ui.pause();
  return { ...result.manifest, filePath: result.manifestPath };
}

async function widgetDeploymentMenu(ui, deployment, context) {
  let current = deployment;
  while (true) {
    const action = await ui.selectMenu(`Deployment ${current.deployment.name}`, [
      { label: "Review configuration", value: "review" },
      { label: "Modify configuration", value: "modify" },
      { label: "Synchronize current public URL", value: "sync" },
      { label: "Show administration URL and widget ID", value: "access" },
      { label: "Destroy deployment", value: "destroy" },
      ui.backOption("All Widget deployments"),
    ]);
    if (action === "back") return;
    if (action === "review") {
      printWidgetDeployment(current);
      await ui.pause();
    }
    if (action === "modify") current = await modifyWidgetDeployment(ui, current, context);
    if (action === "sync") {
      await syncManagedWidgetDeploymentUrls({
        deployments: [current],
        onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
      });
      current = (await listManagedWidgetDeployments()).find(
        (entry) => entry.deployment.id === current.deployment.id
      );
      await ui.pause();
    }
    if (action === "access") {
      console.log(`Administration: ${widgetAdminUrl(current.publicBaseUrl)}`);
      console.log(`Widget public ID: ${current.resources.widgetPublicId}`);
      await ui.pause();
    }
    if (action === "destroy") {
      printWidgetDeployment(current);
      console.log(ui.color.danger("\nThe deployment-owned Open Messaging integration, managed Architect flow, handoff tool, managed assistant and PostgreSQL widget will be deleted."));
      console.log(ui.color.muted("The shared OAuth client, administrator role and Client Application are retained."));
      if (!(await ui.confirm(`Permanently destroy ${current.deployment.name}?`, false))) continue;
      const confirmation = String(await ui.input("Type the 6-character deployment ID to confirm", ""))
        .trim()
        .toUpperCase();
      if (confirmation !== current.deployment.id) {
        console.log(ui.color.warning("Deployment ID did not match. Nothing was deleted."));
        await ui.pause();
        continue;
      }
      const result = await ui.withSpinner("Destroying Widget deployment", () =>
        destroyManagedWidgetDeployment({ deployment: current, context })
      );
      console.log(ui.color.success(`Deployment destroyed. Archived manifest: ${result.archivedPath}`));
      await ui.pause();
      return;
    }
  }
}

async function widgetTunnelMenu(ui) {
  while (true) {
    const status = await ui.withSpinner("Checking managed tunnel state", getQuickTunnelStatus);
    console.log(`\nConfigured public URL: ${process.env.GC_PUBLIC_BASE_URL || "not configured"}`);
    ui.printCheck(
      "Managed Quick Tunnel",
      status.running ? "ok" : "warning",
      status.state?.publicBaseUrl || "not running"
    );
    ui.printCheck(
      "Tunnel health",
      status.healthy ? "ok" : "warning",
      status.healthy ? "local and public checks passed" : "not healthy"
    );
    const action = await ui.selectMenu("Manage Cloudflare Quick Tunnel", [
      {
        label: status.running ? "Replace managed Quick Tunnel" : "Start managed Quick Tunnel",
        value: "start",
      },
      { label: "Use an existing public HTTPS origin", value: "manual" },
      { label: "Synchronize URL to all managed deployments", value: "sync" },
      ...(status.running ? [{ label: "Stop managed Quick Tunnel", value: "stop" }] : []),
      { label: "Refresh status", value: "refresh" },
      ui.backOption("Main menu"),
    ]);
    if (action === "back") return;
    if (action === "refresh") continue;
    if (action === "manual") {
      const value = await ui.input("GC_PUBLIC_BASE_URL", process.env.GC_PUBLIC_BASE_URL, {
        validate(input) { try { normalizePublicApplicationOrigin(input); return true; } catch (error) { return error.message; } },
      });
      const result = await updateManagedPublicOrigin({
        baseUrl: value,
        onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
      });
      console.log(ui.color.success(`Updated ${result.total} managed deployment(s).`));
      await ui.pause();
    }
    if (action === "sync") {
      const result = await synchronizeAllManagedDeploymentUrls({
        onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
      });
      console.log(ui.color.success(`Updated ${result.total} managed deployment(s).`));
      await ui.pause();
    }
    if (action === "start") {
      const configured = String(process.env.GC_PUBLIC_BASE_URL || "").trim();
      if (configured && !isCloudflareQuickTunnelUrl(configured)) {
        const confirmed = await ui.confirm(
          `Replace static public origin ${configured} with a temporary Quick Tunnel?`,
          false
        );
        if (!confirmed) continue;
      }
      if (status.running) await stopCloudflareQuickTunnel();
      const tunnel = await startCloudflareQuickTunnel({
        onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
      });
      try {
        const result = await updateManagedPublicOrigin({
          baseUrl: tunnel.publicBaseUrl,
          previousBaseUrl: configured,
          onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
        });
        console.log(ui.color.success(`Quick Tunnel ready; updated ${result.total} deployment(s).`));
      } catch (error) {
        if (!tunnel.reused) await stopCloudflareQuickTunnel().catch(() => {});
        throw error;
      }
      await ui.pause();
    }
    if (action === "stop") {
      const { listManagedAudioDeployments } = await import("./manage-genesys-audio.mjs");
      const [widgetDeployments, audioDeployments] = await Promise.all([
        listManagedWidgetDeployments(),
        listManagedAudioDeployments(),
      ]);
      const consumers = widgetDeployments.length + audioDeployments.length;
      if (consumers && !(await ui.confirm(
        `${consumers} Audio/Widget deployment(s) retain this URL. Stop the tunnel without clearing it?`,
        false
      ))) continue;
      await stopCloudflareQuickTunnel();
      console.log(ui.color.warning("Tunnel stopped. GC_PUBLIC_BASE_URL is retained until a replacement is synchronized."));
      await ui.pause();
    }
  }
}

async function interactiveMain() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY. Use precheck/status/plan/apply for automation.");
  }
  const ui = await import("../lib/genesys/genesys-admin-ui.mjs");
  ui.header("Telnyx × Genesys Widget Administration CLI", "Messaging, WebRTC voice and Genesys handoff");
  printLocalConfigurationPrecheck(ui);
  await collectMissingConfiguration(ui);
  if (!(await configurePublicUrl(ui))) return;
  await runInteractivePrecheck(ui);
  await ui.withSpinner("Ensuring PostgreSQL schema", ensurePostgresSchema);
  let context = await ui.withSpinner("Loading Genesys widget inventory", connectGenesysWidget);
  while (true) {
    const deployments = await listManagedWidgetDeployments();
    console.log(ui.color.bold("\nWidget deployment inventory"));
    ui.printCheck("Managed deployments", deployments.length ? "ok" : "warning", `${deployments.length} configured locally`);
    ui.printCheck("Genesys queues", context.queues.length ? "ok" : "missing", `${context.queues.length} available`);
    ui.printCheck("Genesys groups", context.groups.length ? "ok" : "warning", `${context.groups.length} available`);
    const action = await ui.selectMenu("Main menu", [
      ...(deployments.length ? [{ label: "Manage a Widget deployment", value: "manage" }] : []),
      { label: "Create a new Widget deployment", value: "create" },
      { label: "Manage Cloudflare Quick Tunnel", value: "tunnel" },
      { label: "Refresh Genesys and deployment inventory", value: "refresh" },
      { label: "Quit", value: "quit" },
    ]);
    if (action === "quit") return;
    if (action === "refresh") {
      context = await ui.withSpinner("Refreshing Genesys widget inventory", connectGenesysWidget);
      continue;
    }
    if (action === "tunnel") await widgetTunnelMenu(ui);
    if (action === "create") {
      await createDeploymentInteractive(ui, context);
      context = await ui.withSpinner("Refreshing Genesys widget inventory", connectGenesysWidget);
    }
    if (action === "manage") {
      const selectedId = await ui.selectMenu(
        "Select a managed Widget deployment",
        [
          ...deployments.map((deployment) => ({
            label: `${deployment.deployment.name} — ${deployment.environment}`,
            value: deployment.deployment.id,
          })),
          ui.backOption("Main menu"),
        ]
      );
      if (selectedId === "back") continue;
      await widgetDeploymentMenu(
        ui,
        deployments.find((deployment) => deployment.deployment.id === selectedId),
        context
      );
      context = await ui.withSpinner("Refreshing Genesys widget inventory", connectGenesysWidget);
    }
  }
}
