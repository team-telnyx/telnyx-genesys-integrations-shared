import "dotenv/config";
import { installationResourceNames } from "../lib/genesys/installation-scope.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import platformClient from "purecloud-platform-client-v2";
import Telnyx from "telnyx";
import {
  getQuickTunnelStatus,
  isCloudflareQuickTunnelUrl,
  managedQuickTunnelCanBeReused,
  startCloudflareQuickTunnel,
  stopCloudflareQuickTunnel,
} from "../lib/genesys/cloudflare-quick-tunnel.mjs";
import {
  hardenGenesysSdkClient,
  normalizeGenesysEnvironment,
} from "../lib/genesys/tts-connector-genesys.mjs";
import {
  mergeInstallerEnvironmentFile,
  saveInstallerEnvironmentValues,
} from "../lib/genesys/installer-environment.mjs";
import {
  encryptedSecretStoreConfigured,
  hydrateRuntimeSecrets,
  partitionManagedRuntimeValues,
  saveEncryptedRuntimeSecrets,
} from "../lib/genesys/encrypted-secret-store.mjs";
import {
  verifyGenesysPlatformAccess,
  verifyTelnyxPlatformAccess,
} from "../lib/genesys/platform-preflight.mjs";
import {
  clearManagedPublicOrigin,
  managedPublicOriginWriteOptions,
  synchronizeAllManagedDeploymentUrls,
  updateManagedPublicOrigin,
} from "../lib/genesys/public-origin-manager.mjs";
import {
  genesysAudioDnisManualAction,
  genesysAudioDnisValues,
} from "../lib/genesys/audio-connector-flow-config.mjs";
import {
  GENESYS_AUDIO_CONNECTOR_LIMIT,
  GENESYS_AUDIO_STATE_DIRECTORY,
  publicGenesysBaseUrl,
} from "../lib/genesys/audio-connector-config.mjs";
import {
  findSharedGenesysHandoffTool,
  findTelnyxToolByName,
  telnyxToolDisplayName,
  telnyxToolId,
} from "../lib/genesys/handoff-tool-definition.mjs";
import {
  TELNYX_END_USER_TARGET_TEMPLATE,
  genesysSipInviteToolDefinition,
  genesysSkipTurnToolDefinition,
} from "../lib/genesys/sip-transfer-tool.mjs";
import { ADMIN_ASSISTANT_RECOMMENDED_MODEL } from "../lib/genesys/admin-assistant-generator.mjs";
import { getTtsConnectorProfile } from "../lib/genesys/tts-connector-profiles.mjs";
import { loadTtsProviderCatalog } from "../lib/genesys/tts-provider-catalog.mjs";
import { listGenesysDidNumbers } from "../lib/genesys/did-inventory.mjs";
import { normalizeTelnyxPublicKey } from "../lib/telnyx/webhooks.mjs";
import { findAssistantByExactName } from "./provision-telnyx-genesys-assistant.mjs";
import {
  listAudioCallRoutes,
  resolveAudioCallRoute,
} from "../lib/genesys/audio-call-route.mjs";
import {
  registerManagedAgentExperience,
  registerManagedResourceBatch,
} from "../lib/genesys/managed-resource-registry.mjs";

const execFileAsync = promisify(execFile);
const AUDIO_CONNECTOR_TYPE = "audio-connector";
const INTERACTION_WIDGET_TYPE = "embedded-client-app-interaction-widget";
export const PRIMARY_AUDIO_DEPLOYMENT_ID = "CECA32";
const AUDIO_APPLY_LABELS = Object.freeze({
  managedAssistant: "Create or update the default Telnyx AI assistant",
  assistants: "Update the shared Telnyx handoff tool and selected AI assistants",
  experience: "Publish Genesys handoff script and interaction widget",
  widgetOnly: "Update Genesys Agent Experience interaction widget",
  architect: "Update required Audio Connector and Architect resources",
  persist: "Persist the managed Audio Connector manifest",
  sharedCallTools: "Create the shared Telnyx Invite and Skip Turn tools",
});
export const AUDIO_SECRET_VARIABLES = Object.freeze([
  "GC_AUDIO_CONNECTOR_API_KEY",
  "GC_AUDIO_CONNECTOR_CLIENT_SECRET",
  "GC_AUDIO_HANDOFF_API_KEY",
]);
export const AUDIO_INSTALLER_VARIABLES = Object.freeze([
  "GC_ENVIRONMENT",
  "GC_CLIENT_ID",
  "GC_CLIENT_SECRET",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
  "GC_PUBLIC_BASE_URL",
  "GENESYS_HANDOFF_API_KEY",
  ...AUDIO_SECRET_VARIABLES,
]);

export function audioInstallationOperations(plan = {}) {
  const hasChangeSet = Boolean(plan.changes && typeof plan.changes === "object");
  const changes = plan.changes || {};
  const isCreate = changes.isCreate === true || plan.audioConnector?.operation === "create-managed";
  if (!hasChangeSet) {
    return {
      managedAssistant: Boolean(plan.managedAssistant),
      assistants: true,
      interactionWidget: true,
      handoffScript: true,
      audioConnector: true,
      architectFlow: true,
      callRoute: true,
    };
  }
  const assistantMembershipChanged = Boolean(
    (changes.addedAssistants || []).length || (changes.removedAssistants || []).length
  );
  const managedAssistant = Boolean(plan.managedAssistant) && isCreate;
  return {
    managedAssistant,
    assistants: isCreate || managedAssistant || changes.handoffToolChanged === true || assistantMembershipChanged,
    interactionWidget: isCreate || changes.interactionWidgetChanged === true,
    handoffScript: isCreate || changes.handoffScriptChanged === true,
    audioConnector: isCreate || changes.audioConnectorChanged === true,
    architectFlow: isCreate || changes.architectFlowChanged === true,
    callRoute: isCreate || changes.callRouteChanged === true,
  };
}

export function audioInstallationStepLabels(plan = {}) {
  const operations = audioInstallationOperations(plan);
  return [
    "Validate the managed Audio Connector deployment and live resource snapshot",
    ...(operations.managedAssistant ? [AUDIO_APPLY_LABELS.managedAssistant] : []),
    ...(operations.assistants ? [AUDIO_APPLY_LABELS.assistants] : []),
    ...(operations.handoffScript
      ? [AUDIO_APPLY_LABELS.experience]
      : operations.interactionWidget ? [AUDIO_APPLY_LABELS.widgetOnly] : []),
    ...(operations.audioConnector || operations.architectFlow || operations.callRoute
      ? [AUDIO_APPLY_LABELS.architect] : []),
    AUDIO_APPLY_LABELS.persist,
  ];
}
const MASKED_CONFIGURATION_VARIABLES = new Set([
  "GC_CLIENT_SECRET",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "TELNYX_API_KEY",
  "GENESYS_HANDOFF_API_KEY",
  ...AUDIO_SECRET_VARIABLES,
]);

function statusOf(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stateDirectory(options = {}) {
  return path.resolve(String(options["state-dir"] || GENESYS_AUDIO_STATE_DIRECTORY));
}

export function missingAudioSecretNames(environment = process.env) {
  return AUDIO_SECRET_VARIABLES.filter(
    (name) => !String(environment[name] || "").trim()
  );
}

export function generateAudioSecrets(names = AUDIO_SECRET_VARIABLES) {
  const requested = new Set(names);
  const generated = {};
  if (requested.has("GC_AUDIO_CONNECTOR_API_KEY")) {
    generated.GC_AUDIO_CONNECTOR_API_KEY = randomBytes(32).toString("hex");
  }
  if (requested.has("GC_AUDIO_CONNECTOR_CLIENT_SECRET")) {
    generated.GC_AUDIO_CONNECTOR_CLIENT_SECRET = randomBytes(32).toString("base64");
  }
  if (requested.has("GC_AUDIO_HANDOFF_API_KEY")) {
    generated.GC_AUDIO_HANDOFF_API_KEY = randomBytes(32).toString("hex");
    generated.GENESYS_HANDOFF_API_KEY = generated.GC_AUDIO_HANDOFF_API_KEY;
  }
  return generated;
}

export function mergeEnvironmentFile(
  source,
  values,
  { replaceManagedPublicBaseUrl = false, replaceNames = [] } = {}
) {
  return mergeInstallerEnvironmentFile(source, values, {
    allowedNames: AUDIO_INSTALLER_VARIABLES,
    replaceNames,
    mayReplace(name, current) {
      return name === "GC_PUBLIC_BASE_URL" &&
        replaceManagedPublicBaseUrl &&
        isCloudflareQuickTunnelUrl(current);
    },
  });
}

export function managedQuickTunnelEnvironmentWriteOptions(currentUrl) {
  return managedPublicOriginWriteOptions(currentUrl);
}

export async function saveEnvironmentValues({
  values,
  environment = process.env,
  envFile = path.resolve(".env"),
  replaceManagedPublicBaseUrl = false,
  replaceNames = [],
} = {}) {
  if (!encryptedSecretStoreConfigured(environment)) {
    return saveInstallerEnvironmentValues({
      values,
      allowedNames: AUDIO_INSTALLER_VARIABLES,
      replaceNames,
      mayReplace(name, current) {
        return name === "GC_PUBLIC_BASE_URL" &&
          replaceManagedPublicBaseUrl &&
          isCloudflareQuickTunnelUrl(current);
      },
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
    allowedNames: AUDIO_INSTALLER_VARIABLES,
    replaceNames,
    mayReplace(name, current) {
      return name === "GC_PUBLIC_BASE_URL" &&
        replaceManagedPublicBaseUrl &&
        isCloudflareQuickTunnelUrl(current);
    },
    environment,
    envFile,
  });
  return { ...saved, saved: [...Object.keys(managed), ...saved.saved] };
}

export async function clearManagedPublicBaseUrl({
  expectedUrl,
  environment = process.env,
  envFile = path.resolve(".env"),
} = {}) {
  return clearManagedPublicOrigin({ expectedUrl, environment, envFile });
}

export async function bootstrapMissingAudioSecrets({
  environment = process.env,
  envFile = path.resolve(".env"),
} = {}) {
  const missing = missingAudioSecretNames(environment);
  if (!missing.length) return { generated: [], envFile };

  const values = generateAudioSecrets(missing);
  await saveEnvironmentValues({ values, environment, envFile });
  return { generated: missing, envFile };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

export async function listManagedAudioDeployments({ options = {} } = {}) {
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
    const deployment = await readJson(filePath);
    if (deployment.schemaVersion !== 1 || !deployment.deployment?.id) {
      throw new Error(`Unsupported managed Audio deployment manifest ${filePath}`);
    }
    deployments.push({ ...deployment, filePath });
  }
  return deployments.sort((left, right) =>
    left.deployment.id.localeCompare(right.deployment.id)
  );
}

export async function connectGenesysAudio() {
  const environment = normalizeGenesysEnvironment(required("GC_ENVIRONMENT"));
  const apiClient = platformClient.ApiClient.instance;
  hardenGenesysSdkClient(apiClient);
  apiClient.setEnvironment(environment);
  apiClient.timeout = 30_000;
  const auth = await apiClient.loginClientCredentialsGrant(
    required("GC_CLIENT_CRED_CLIENT_ID"),
    required("GC_CLIENT_CRED_CLIENT_SECRET")
  );
  const accessToken = auth?.accessToken || apiClient.authData?.accessToken;
  if (!accessToken) throw new Error("Genesys access token was not returned");
  const integrationsApi = new platformClient.IntegrationsApi();
  const organizationApi = new platformClient.OrganizationApi();
  const routingApi = new platformClient.RoutingApi();
  const groupsApi = new platformClient.GroupsApi();
  const architectApi = new platformClient.ArchitectApi();
  const scriptsApi = new platformClient.ScriptsApi();
  const telephonyApi = new platformClient.TelephonyProvidersEdgeApi();
  const [organization, integrationType, integrations, queues, groups] = await Promise.all([
    organizationApi.getOrganizationsMe(),
    integrationsApi.getIntegrationsType(AUDIO_CONNECTOR_TYPE).catch((error) => {
      if (![403, 404].includes(statusOf(error))) throw error;
      throw new Error(
        "Genesys Audio Connector is not enabled for this organization. " +
          "An administrator must enable it and accept any required terms in Genesys AppFoundry first.",
        { cause: error }
      );
    }),
    listAudioConnectorIntegrations(integrationsApi),
    listGenesysQueues(routingApi),
    listGenesysGroups(groupsApi),
  ]);
  return {
    environment,
    accessToken,
    organization,
    integrationType,
    integrationsApi,
    routingApi,
    groupsApi,
    architectApi,
    scriptsApi,
    telephonyApi,
    integrations,
    queues,
    groups,
  };
}

export function resolveAudioConnectorDeploymentTarget(
  integrations,
  name,
  limit = GENESYS_AUDIO_CONNECTOR_LIMIT
) {
  const entities = Array.isArray(integrations) ? integrations : [];
  const matches = entities.filter((integration) => integration?.name === name);
  if (matches.length > 1) {
    throw new Error(`More than one Genesys Audio Connector is named ${name}`);
  }
  if (matches[0]) return { integration: matches[0], created: false };
  if (entities.length >= limit) {
    throw new Error(
      `Genesys Audio Connector capacity is full (${entities.length}/${limit}). ` +
        "Delete an unused Audio Connector before creating a managed deployment."
    );
  }
  return { integration: null, created: true };
}

export async function ensureAudioConnectorDeployment(integrationsApi, name) {
  const integrations = await listAudioConnectorIntegrations(integrationsApi);
  const target = resolveAudioConnectorDeploymentTarget(integrations, name);
  if (target.integration) return target;
  let created;
  try {
    created = await integrationsApi.postIntegrations({
      body: { name, integrationType: { id: AUDIO_CONNECTOR_TYPE } },
    });
  } catch (error) {
    if (![403, 404].includes(statusOf(error))) throw error;
    throw new Error(
      "Genesys refused to create the Audio Connector instance. " +
        "Enable Genesys Audio Connector and accept any required terms in AppFoundry, then retry.",
      { cause: error }
    );
  }
  if (!created?.id || created.integrationType?.id !== AUDIO_CONNECTOR_TYPE) {
    throw new Error("Genesys did not return the newly created Audio Connector");
  }
  return { integration: created, created: true };
}

export async function listAudioConnectorIntegrations(integrationsApi) {
  return listIntegrationsByType(integrationsApi, AUDIO_CONNECTOR_TYPE);
}

export async function listIntegrationsByType(integrationsApi, integrationType) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await integrationsApi.getIntegrations({
      pageNumber,
      pageSize: 100,
      integrationType,
    });
    entities.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entities;
  }
  throw new Error(`${integrationType} integration pagination exceeded 100 pages`);
}

export async function listGenesysQueues(routingApi) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await routingApi.getRoutingQueues({ pageNumber, pageSize: 100, sortOrder: "asc" });
    entities.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) break;
  }
  return entities
    .filter((queue) => queue?.id && queue?.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listGenesysGroups(groupsApi) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await groupsApi.getGroups({ pageNumber, pageSize: 100, sortOrder: "asc" });
    entities.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) break;
  }
  return entities
    .filter((group) => group?.id && group?.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function environmentChecks(environment = process.env) {
  return AUDIO_INSTALLER_VARIABLES.map((name) => ({
    name,
    present: name === "GENESYS_HANDOFF_API_KEY"
      ? Boolean(String(
          environment.GENESYS_HANDOFF_API_KEY || environment.GC_AUDIO_HANDOFF_API_KEY || ""
        ).trim())
      : Boolean(String(environment[name] || "").trim()),
  }));
}

function environmentPresence(name, environment = process.env) {
  return Boolean(String(environment[name] || "").trim());
}

export function normalizeInstallerConfigurationValue(name, value) {
  const normalized = String(value || "").trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
  if (name === "GC_ENVIRONMENT") return normalizeGenesysEnvironment(normalized);
  if (name === "GC_PUBLIC_BASE_URL") return publicGenesysBaseUrl(normalized);
  if (name === "TELNYX_PUBLIC_KEY") return normalizeTelnyxPublicKey(normalized);
  if (name === "GC_AUDIO_CONNECTOR_CLIENT_SECRET") {
    const decoded = Buffer.from(normalized, "base64");
    const canonical = decoded.toString("base64");
    if (decoded.length !== 32 || canonical !== normalized) {
      throw new Error(`${name} must be a base64-encoded 32-byte secret`);
    }
  }
  if (
    ["GC_AUDIO_CONNECTOR_API_KEY", "GC_AUDIO_HANDOFF_API_KEY", "GENESYS_HANDOFF_API_KEY"].includes(name) &&
    normalized.length < 32
  ) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return normalized;
}

const CONFIGURATION_PROMPTS = Object.freeze({
  GC_ENVIRONMENT: "Genesys Cloud region domain (GC_ENVIRONMENT)",
  GC_CLIENT_ID: "Genesys Code Authorization client ID (GC_CLIENT_ID)",
  GC_CLIENT_SECRET: "Genesys Code Authorization client secret (GC_CLIENT_SECRET)",
  GC_CLIENT_CRED_CLIENT_ID:
    "Genesys Client Credentials client ID (GC_CLIENT_CRED_CLIENT_ID)",
  GC_CLIENT_CRED_CLIENT_SECRET:
    "Genesys Client Credentials client secret (GC_CLIENT_CRED_CLIENT_SECRET)",
  TELNYX_API_KEY: "Telnyx API key (TELNYX_API_KEY)",
  TELNYX_PUBLIC_KEY:
    "Telnyx webhook public key from Keys & Credentials (TELNYX_PUBLIC_KEY)",
  GC_PUBLIC_BASE_URL: "Public HTTPS application origin (GC_PUBLIC_BASE_URL)",
  GC_AUDIO_CONNECTOR_API_KEY: "AudioHook API key (GC_AUDIO_CONNECTOR_API_KEY)",
  GC_AUDIO_CONNECTOR_CLIENT_SECRET:
    "AudioHook base64 HMAC secret (GC_AUDIO_CONNECTOR_CLIENT_SECRET)",
  GC_AUDIO_HANDOFF_API_KEY: "Handoff webhook API key (GC_AUDIO_HANDOFF_API_KEY)",
  GENESYS_HANDOFF_API_KEY: "Shared handoff webhook API key (GENESYS_HANDOFF_API_KEY)",
});

const AUDIO_GENESYS_CONFIGURATION = Object.freeze([
  "GC_ENVIRONMENT",
  "GC_CLIENT_ID",
  "GC_CLIENT_SECRET",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
]);
const VERIFIED_GENESYS_CONFIGURATION = Object.freeze([
  "GC_ENVIRONMENT",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
]);

async function collectConfiguration(ui, names) {
  const values = {};
  for (const name of names) {
    const validate = (input) => {
      try {
        normalizeInstallerConfigurationValue(name, input);
        return true;
      } catch (error) {
        return error.message;
      }
    };
    const input = MASKED_CONFIGURATION_VARIABLES.has(name)
      ? await ui.password(CONFIGURATION_PROMPTS[name], { validate })
      : await ui.input(
          CONFIGURATION_PROMPTS[name],
          String(process.env[name] || "").trim(),
          { validate }
        );
    values[name] = normalizeInstallerConfigurationValue(name, input);
  }
  return values;
}

async function requestConfiguration(ui, names, message = "Required configuration is missing") {
  const action = await ui.selectMenu(
    message,
    [
      {
        label: "Enter values now and save them securely",
        value: "enter",
      },
      {
        label: "Exit and run genesys:deploy",
        value: "exit",
      },
    ]
  );
  if (action === "exit") return null;
  return collectConfiguration(ui, names);
}

async function saveInteractiveConfiguration(ui, values, replaceNames = []) {
  if (!values || !Object.keys(values).length) return;
  const saved = await ui.withSpinner(
    "Securely saving configuration",
    () => saveEnvironmentValues({ values, replaceNames })
  );
  console.log(ui.color.success(`Saved ${saved.saved.join(", ")} to ${saved.envFile}`));
}

async function configureAndVerifyGenesys(ui) {
  console.log(ui.color.accent("\nGenesys Cloud preflight"));
  AUDIO_GENESYS_CONFIGURATION.forEach((name) => {
    ui.printCheck(name, environmentPresence(name) ? "ok" : "missing");
  });

  while (true) {
    const missing = AUDIO_GENESYS_CONFIGURATION.filter((name) => !environmentPresence(name));
    if (missing.length) {
      const values = await requestConfiguration(ui, missing, "Genesys configuration is missing");
      if (values === null) return null;
      await saveInteractiveConfiguration(ui, values);
    }

    try {
      const access = await ui.withSpinner(
        "Verifying Genesys Client Credentials and organization access",
        () => verifyGenesysPlatformAccess({
          environment: process.env.GC_ENVIRONMENT,
          clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
          clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
        })
      );
      ui.printCheck(
        "Genesys platform access",
        "ok",
        `${access.organization.name} / ${access.environment}`
      );
      ui.printCheck(
        "Code Authorization client",
        "ok",
        "saved; interactive OAuth is validated when the widget signs in"
      );
      return access;
    } catch (error) {
      ui.printCheck("Genesys platform access", "missing", error.message);
      const action = await ui.selectMenu("Genesys credentials could not be verified", [
        { label: "Re-enter Genesys API credentials and retry", value: "retry" },
        { label: "Exit and run genesys:deploy", value: "exit" },
      ]);
      if (action === "exit") return null;
      const values = await collectConfiguration(ui, VERIFIED_GENESYS_CONFIGURATION);
      await saveInteractiveConfiguration(ui, values, VERIFIED_GENESYS_CONFIGURATION);
    }
  }
}

async function configureAndVerifyTelnyx(ui) {
  console.log(ui.color.accent("\nTelnyx API preflight"));
  ui.printCheck("TELNYX_API_KEY", environmentPresence("TELNYX_API_KEY") ? "ok" : "missing");
  ui.printCheck(
    "TELNYX_PUBLIC_KEY",
    environmentPresence("TELNYX_PUBLIC_KEY") ? "ok" : "missing"
  );
  while (true) {
    const missing = ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY"].filter(
      (name) => !environmentPresence(name)
    );
    if (missing.length) {
      const values = await requestConfiguration(
        ui,
        missing,
        "Telnyx API or webhook verification configuration is missing"
      );
      if (values === null) return null;
      await saveInteractiveConfiguration(ui, values);
    }
    try {
      normalizeTelnyxPublicKey(process.env.TELNYX_PUBLIC_KEY);
      await ui.withSpinner("Verifying Telnyx account and AI Assistants API access", () =>
        verifyTelnyxPlatformAccess({ apiKey: process.env.TELNYX_API_KEY, capability: "audio" })
      );
      ui.printCheck("Telnyx API access", "ok", "account and AI Assistants API");
      ui.printCheck("Telnyx webhook public key", "ok", "valid 32-byte Ed25519 key");
      return true;
    } catch (error) {
      ui.printCheck("Telnyx API access", "missing", error.message);
      const action = await ui.selectMenu("The Telnyx configuration could not be verified", [
        { label: "Re-enter the Telnyx API and public keys, then retry", value: "retry" },
        { label: "Exit and run genesys:deploy", value: "exit" },
      ]);
      if (action === "exit") return null;
      const names = ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY"];
      const values = await collectConfiguration(ui, names);
      await saveInteractiveConfiguration(ui, values, names);
    }
  }
}

async function configurePublicBaseUrl(ui) {
  const action = await ui.selectMenu(
    "Configure the public Audio Connector URL",
    [
      {
        label: "Start a managed Cloudflare Quick Tunnel (demo)",
        value: "quick-tunnel",
        description:
          "Temporarily starts the local app, validates a trycloudflare.com tunnel, then stops the app and saves the URL.",
      },
      {
        label: "Enter an existing public HTTPS origin",
        value: "manual",
      },
      {
        label: "Exit and run genesys:deploy",
        value: "exit",
      },
    ]
  );
  if (action === "exit") return false;
  if (action === "manual") {
    const value = await ui.input(CONFIGURATION_PROMPTS.GC_PUBLIC_BASE_URL, "", {
      validate(input) {
        try {
          normalizeInstallerConfigurationValue("GC_PUBLIC_BASE_URL", input);
          return true;
        } catch (error) {
          return error.message;
        }
      },
    });
    const synchronized = await updateManagedPublicOrigin({
      baseUrl: normalizeInstallerConfigurationValue("GC_PUBLIC_BASE_URL", value),
      onProgress(event) {
        ui.printProgress(event.status, event.label);
      },
    });
    if (synchronized.total) {
      console.log(
        ui.color.success(
          `Updated ${synchronized.total} managed deployment(s) to the new public URL.`
        )
      );
    }
    return true;
  }

  console.log(
    ui.color.warning(
      "Quick Tunnel is temporary, publicly exposes this local application, and is for demos only."
    )
  );
  console.log(ui.color.accent("\nStarting the local gateway and Cloudflare Quick Tunnel"));
  const tunnel = await startCloudflareQuickTunnel({
    onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
  });
  try {
    const synchronized = await updateManagedPublicOrigin({
      baseUrl: tunnel.publicBaseUrl,
      onProgress(event) {
        ui.printProgress(event.status, event.label);
      },
    });
    if (synchronized.total) {
      console.log(
        ui.color.success(
          `Updated ${synchronized.total} managed deployment(s) to the new public URL.`
        )
      );
    }
  } catch (error) {
    if (!tunnel.reused) await stopCloudflareQuickTunnel().catch(() => {});
    throw error;
  }
  console.log(ui.color.success(`Cloudflare Quick Tunnel: ${tunnel.publicBaseUrl}`));
  console.log(
    ui.color.muted(
      "Local and public /api/health checks passed. The temporary local server was stopped."
    )
  );
  console.log(
    ui.color.muted(
      "After configuration, run npm run dev (or npm run build && npm run start) in a visible terminal."
    )
  );
  return true;
}

function exactQueues(context, selected) {
  return selected.map((planned) => {
    const queue = context.queues.find((entry) => entry.id === planned.id);
    if (!queue) throw new Error(`Genesys queue ${planned.name} (${planned.id}) no longer exists`);
    if (queue.name !== planned.name) {
      throw new Error(`Genesys queue ${planned.id} changed name from ${planned.name} to ${queue.name}`);
    }
    return queue;
  });
}

function exactGroups(context, selected) {
  return selected.map((planned) => {
    const group = context.groups.find((entry) => entry.id === planned.id);
    if (!group) throw new Error(`Genesys group ${planned.name} (${planned.id}) no longer exists`);
    if (group.name !== planned.name) {
      throw new Error(`Genesys group ${planned.id} changed name from ${planned.name} to ${group.name}`);
    }
    return group;
  });
}

export async function managedHandoffScriptNeedsReconcile(context, deployment, expectedName) {
  if (!deployment) return true;
  const scriptId = String(deployment.resources?.scriptId || "").trim();
  if (!scriptId || !context.scriptsApi || typeof context.scriptsApi.getScript !== "function") {
    return true;
  }
  const script = await readRemoteResource(() => context.scriptsApi.getScript(scriptId));
  if (!script || script.name !== expectedName) return true;
  if (typeof context.scriptsApi.getScriptsPublished !== "function") return true;
  const published = await context.scriptsApi.getScriptsPublished({
    pageSize: 100,
    pageNumber: 1,
    name: expectedName,
  });
  return !(published.entities || []).some(
    (entry) => entry.id === scriptId && entry.name === expectedName
  );
}

export async function createAudioInstallationPlan(
  context,
  {
    applicationName,
    deploymentId,
    queueIds,
    defaultQueueId,
    widgetGroupIds,
    dnis,
    assistantRoutes,
    defaultAssistant,
    managedHandoffTool = null,
    managedHangupTool = null,
    options = {},
  }
) {
  const installationNames = installationResourceNames();
  const targetId = String(deploymentId || PRIMARY_AUDIO_DEPLOYMENT_ID).trim().toUpperCase();
  if (targetId !== PRIMARY_AUDIO_DEPLOYMENT_ID) {
    throw new Error(`Audio Connector uses the single managed deployment ${PRIMARY_AUDIO_DEPLOYMENT_ID}`);
  }
  const manifests = await listManagedAudioDeployments({ options });
  const current = manifests.find((entry) => entry.deployment.id === targetId);
  const deploymentApplicationName = installationNames.installationName;
  if (applicationName && String(applicationName).trim() !== deploymentApplicationName) {
    throw new Error(`Audio deployment name is managed and must be ${deploymentApplicationName}`);
  }
  if (!deploymentApplicationName) throw new Error("Audio deployment name is required");
  const deploymentName = deploymentApplicationName;
  const integration = current ? context.integrations.find(
    (entry) => entry.id === current.resources.audioConnectorIntegrationId
  ) : null;
  if (current && (!integration || integration.name !== deploymentName)) {
    throw new Error(`Managed Audio Connector ${deploymentName} no longer matches its deployment manifest`);
  }
  const queues = queueIds.map((id) => {
    const queue = context.queues.find((entry) => entry.id === id);
    if (!queue) throw new Error(`Unknown Genesys queue ${id}`);
    return { id: queue.id, name: queue.name };
  });
  if (!queues.length) throw new Error("Select at least one Genesys queue");
  const defaultQueue = queues.find(({ id }) => id === defaultQueueId);
  if (!defaultQueue) throw new Error("Default Genesys queue must belong to the selected allowlist");
  const fallbackAdminGroup = context.groups.find(
    ({ name }) => name === installationNames.adminGroup
  );
  const desiredWidgetGroupIds = [...new Set(
    (Array.isArray(widgetGroupIds) && widgetGroupIds.length
      ? widgetGroupIds
      : current?.groups?.map((group) => group.id) || [fallbackAdminGroup?.id]
    ).map((id) => String(id || "").trim()).filter(Boolean)
  )];
  if (!desiredWidgetGroupIds.length) {
    throw new Error("Select at least one Genesys group for Agent Experience access");
  }
  const groups = desiredWidgetGroupIds.map((id) => {
    const group = context.groups.find((entry) => entry.id === id);
    if (!group) throw new Error(`Unknown Genesys Agent Experience access group ${id}`);
    return { id: group.id, name: group.name };
  });
  const rawRoutes = Array.isArray(assistantRoutes) && assistantRoutes.length
    ? assistantRoutes
    : genesysAudioDnisValues(dnis).map((value) => ({
        dnis: value,
        assistantId: current?.resources?.assistantId || "__managed_default__",
      }));
  const routes = [];
  const usedDnis = new Set();
  for (const route of rawRoutes) {
    const routeDnis = genesysAudioDnisValues([route?.dnis])[0];
    const assistantId = String(route?.assistantId || "").trim();
    if (!assistantId) throw new Error(`Select a Telnyx assistant for DNIS ${routeDnis}`);
    if (usedDnis.has(routeDnis)) throw new Error(`DNIS ${routeDnis} is assigned more than once`);
    usedDnis.add(routeDnis);
    routes.push({
      dnis: routeDnis,
      assistantId,
      ...(route?.takeover === true ? {
        takeover: true,
        ...(route?.takeoverOwner?.id ? {
          takeoverOwner: {
            id: String(route.takeoverOwner.id),
            name: String(route.takeoverOwner.name || route.takeoverOwner.id),
            type: String(route.takeoverOwner.type || "UNKNOWN"),
          },
        } : {}),
      } : {}),
    });
  }
  if (!routes.length) throw new Error("Configure at least one DNIS-to-assistant assignment");
  const createManagedAssistant = Boolean(
    defaultAssistant?.enabled && routes.some((route) => route.assistantId === "__managed_default__")
  );
  const configuredGenesysDnis = new Set();
  const genesysDidInventory = new Map();
  if (context.telephonyApi?.getTelephonyProvidersEdgesDidpoolsDids) {
    for (const did of await listGenesysDidNumbers(context.telephonyApi)) {
      configuredGenesysDnis.add(did.dnis);
      genesysDidInventory.set(did.dnis, did);
    }
  } else {
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const page = await context.architectApi.getArchitectIvrs({
        pageNumber,
        pageSize: 100,
        expand: ["dnis"],
      });
      for (const ivr of page.entities || []) {
        for (const value of ivr.dnis || []) configuredGenesysDnis.add(String(value).trim());
      }
      if (!page.nextUri || !(page.entities || []).length) break;
      if (pageNumber === 100) throw new Error("Genesys inbound call route pagination exceeded 100 pages");
    }
  }
  for (const route of routes) {
    if (!configuredGenesysDnis.has(route.dnis)) {
      throw new Error(`DNIS ${route.dnis} is not present in the Genesys DID inventory`);
    }
  }
  const callRoutes = await listAudioCallRoutes(context.architectApi);
  const callRouteResolution = resolveAudioCallRoute({
    ivrs: callRoutes,
    ivrId: current?.resources?.callRouteId || null,
    name: deploymentName,
    dnis: routes.map(({ dnis: value }) => value),
    deploymentId: targetId,
    takeoverDnis: routes.filter((route) => route.takeover).map((route) => route.dnis),
  });
  const routeTakeoverOwnerIds = new Set(
    callRouteResolution.takeovers.map((takeover) => takeover.routeId)
  );
  const directOwnerTakeovers = routes.flatMap((route) => {
    const did = genesysDidInventory.get(route.dnis);
    const owner = did?.owner || null;
    const expectedOwner = route.takeoverOwner || null;
    if (expectedOwner && (
      !owner || owner.id !== expectedOwner.id || String(owner.type || "UNKNOWN") !== expectedOwner.type
    )) {
      throw new Error(`Genesys DID ${route.dnis} ownership changed after selection; refresh the inventory`);
    }
    if (!owner || owner.id === callRouteResolution.existing?.id || routeTakeoverOwnerIds.has(owner.id)) {
      return [];
    }
    if (!route.takeover) {
      throw new Error(`Genesys DID ${route.dnis} is already assigned to ${owner.name || owner.id}`);
    }
    return [{
      dnis: route.dnis,
      didId: did.id,
      ownerId: owner.id,
      ownerName: owner.name || owner.id,
      ownerType: owner.type || "UNKNOWN",
    }];
  });
  const telnyx = new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const managedAssistantName = String(
    defaultAssistant?.name || deploymentApplicationName
  ).trim();
  if (current && createManagedAssistant) {
    const existingAssistant = await findAssistantByExactName(telnyx, managedAssistantName);
    if (existingAssistant) {
      throw new Error(`A Telnyx AI assistant named ${managedAssistantName} already exists; select it from the existing assistant list or choose a unique name`);
    }
  }
  const currentHandoffTool = await findSharedGenesysHandoffTool(telnyx, {
    preferredToolIds: [managedHandoffTool?.remoteToolId, current?.resources?.toolId],
    displayName: installationNames.widgetHandoffTool,
  });
  const assistantNames = new Map();
  for (const assistantId of [...new Set(routes.map((route) => route.assistantId))]) {
    if (assistantId === "__managed_default__") {
      if (!createManagedAssistant) throw new Error("New assistant creation is not enabled");
      if (!managedAssistantName) throw new Error("New assistant name is required");
      assistantNames.set(assistantId, managedAssistantName);
      continue;
    }
    let assistant;
    try {
      assistant = await telnyx.ai.assistants.retrieve(assistantId);
    } catch (error) {
      throw new Error(`Telnyx assistant ${assistantId} is unavailable: ${remoteErrorMessage(error)}`);
    }
    assistantNames.set(assistantId, assistant.name || assistantId);
  }
  const previousRoutes = Array.isArray(current?.architect?.routes) && current.architect.routes.length
    ? current.architect.routes
    : (current?.architect?.dnis || []).map((value) => ({
        dnis: value,
        assistantId: current?.resources?.assistantId,
      }));
  const routeKey = (route) => `${route.dnis}|${route.assistantId}`;
  const previousRouteKeys = [...new Set(previousRoutes.map(routeKey))].sort();
  const desiredRouteKeys = [...new Set(routes.map(routeKey))].sort();
  const routesChanged = previousRouteKeys.length !== desiredRouteKeys.length ||
    previousRouteKeys.some((entry, index) => entry !== desiredRouteKeys[index]);
  const previousDnis = [...new Set(previousRoutes.map((route) => route.dnis))].sort();
  const desiredDnis = [...new Set(routes.map((route) => route.dnis))].sort();
  const dnisChanged = previousDnis.length !== desiredDnis.length ||
    previousDnis.some((entry, index) => entry !== desiredDnis[index]);
  const previousAssistantNames = new Map(
    previousRoutes.map((route) => [route.assistantId, route.assistantName || route.assistantId])
  );
  let managedAssistant = null;
  if (createManagedAssistant) {
    const profile = getTtsConnectorProfile("ultra-pcm");
    const catalogs = await loadTtsProviderCatalog([profile], { apiKey: process.env.TELNYX_API_KEY });
    const voices = catalogs.get(profile.id)?.voices || [];
    const voice = voices.find((entry) => (entry.languages || []).some((language) =>
      ["en", "en-us"].includes(String(language).toLowerCase())
    )) || voices[0];
    managedAssistant = {
      operation: "create-or-update-managed",
      name: managedAssistantName,
      forceCreate: Boolean(current),
      useCase: String(defaultAssistant.useCase || "").trim(),
      instructions: String(defaultAssistant.instructions || "").trim(),
      greeting: String(defaultAssistant.greeting || "").trim(),
      model: ADMIN_ASSISTANT_RECOMMENDED_MODEL,
      transcription: { model: "deepgram/flux", language: "en" },
      voiceSettings: { voice: voice?.id || "Telnyx.Ultra.aura", expressive_mode: true },
      enabledFeatures: ["telephony"],
    };
  }
  const previousAssistantIds = [...new Set(previousRoutes.map((route) => route.assistantId).filter(Boolean))];
  const desiredAssistantIds = [...new Set(routes.map((route) => route.assistantId).filter(Boolean))];
  const previousAssistantIdSet = new Set(previousAssistantIds);
  const desiredAssistantIdSet = new Set(desiredAssistantIds);
  const addedAssistantIds = desiredAssistantIds.filter((id) => !previousAssistantIdSet.has(id));
  const removedAssistantIds = previousAssistantIds.filter((id) => !desiredAssistantIdSet.has(id));
  const previousQueueIds = [...new Set((current?.queues || []).map((queue) => queue.id))].sort();
  const desiredQueueIds = [...new Set(queues.map((queue) => queue.id))].sort();
  const queuePolicyChanged = previousQueueIds.length !== desiredQueueIds.length ||
    previousQueueIds.some((entry, index) => entry !== desiredQueueIds[index]) ||
    current?.defaultQueue?.id !== defaultQueue.id;
  const previousGroupIds = [...new Set((current?.groups || []).map((group) => group.id))].sort();
  const desiredGroupIds = [...new Set(groups.map((group) => group.id))].sort();
  const widgetAccessChanged = previousGroupIds.length !== desiredGroupIds.length ||
    previousGroupIds.some((entry, index) => entry !== desiredGroupIds[index]);
  const handoffScriptName = installationNames.audioHandoffScript;
  const handoffScriptChanged = await managedHandoffScriptNeedsReconcile(
    context,
    current,
    handoffScriptName
  );
  const plan = {
    schemaVersion: 10,
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    environment: context.environment,
    organization: { id: context.organization.id, name: context.organization.name },
    deployment: {
      id: current?.deployment?.id || targetId,
      applicationName: deploymentApplicationName,
      name: deploymentName,
    },
    audioConnector: {
      id: current?.resources?.audioConnectorIntegrationId || null,
      name: deploymentName,
      operation: current ? "update-managed" : "create-managed",
    },
    callRoute: {
      id: callRouteResolution.existing?.id || null,
      name: deploymentName,
      operation: callRouteResolution.operation,
      dnis: callRouteResolution.dnis,
      takeovers: callRouteResolution.takeovers,
      ownerTakeovers: directOwnerTakeovers,
    },
    architect: {
      dnis: routes.map((route) => route.dnis),
      routes: routes.map((route) => ({
        ...route,
        assistantName: assistantNames.get(route.assistantId),
      })),
      previousAssistantIds,
    },
    queues,
    defaultQueue,
    groups,
    managedAssistant,
    telnyxHandoffTool: {
      action: currentHandoffTool ? "UPDATE" : "CREATE",
      id: currentHandoffTool ? telnyxToolId(currentHandoffTool) : null,
      displayName: installationNames.widgetHandoffTool,
      functionName: "request_genesys_human_handoff",
      registryId: managedHandoffTool?.id || null,
    },
    telnyxHangupTool: {
      id: managedHangupTool?.remoteToolId || current?.resources?.hangupToolId || null,
      displayName: installationNames.sharedHangupTool,
      registryId: managedHangupTool?.id || null,
    },
    resources: {
      flowName: deploymentName,
      widgetName: installationNames.audioInteractionWidget,
      handoffScriptName,
      toolDisplayName: installationNames.widgetHandoffTool,
      hangupToolName: installationNames.sharedHangupTool,
      callRouteName: deploymentName,
      publicBaseUrl: publicGenesysBaseUrl(),
    },
    currentResources: current?.resources || {},
    changes: {
      isCreate: !current,
      routesChanged,
      dnisChanged,
      queuePolicyChanged,
      handoffToolChanged: !current || !currentHandoffTool || queuePolicyChanged,
      audioConnectorChanged: !current,
      architectFlowChanged: !current || routesChanged,
      callRouteChanged: !current || !current?.resources?.callRouteId || dnisChanged ||
        callRouteResolution.takeovers.length > 0 || directOwnerTakeovers.length > 0,
      interactionWidgetChanged: !current || widgetAccessChanged || queuePolicyChanged ||
        current?.publicBaseUrl !== publicGenesysBaseUrl(),
      handoffScriptChanged,
      addedAssistants: addedAssistantIds.map((id) => ({
        id,
        name: assistantNames.get(id) || id,
      })),
      removedAssistants: removedAssistantIds.map((id) => ({
        id,
        name: previousAssistantNames.get(id) || id,
      })),
    },
  };
  const outputPath = path.join(stateDirectory(options), "plans", `${plan.planId}.json`);
  await writeJsonAtomic(outputPath, plan);
  return { plan, outputPath };
}

async function runProvisioner(script, environment, extraArgs = []) {
  const result = await execFileAsync(process.execPath, [script, "--apply", ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = String(result.stdout || "").trim();
  return output ? JSON.parse(output) : {};
}

function provisionerFailureDetail(error) {
  const raw = String(error?.stderr || error?.message || error || "Provisioning failed").trim();
  const remoteMessage = raw.match(/["']?message["']?\s*:\s*["']([^"'\n]+)["']/i)?.[1];
  if (remoteMessage) return remoteMessage;
  return raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
}

function remoteErrorStatus(error) {
  return Number(
    error?.status ||
      error?.statusCode ||
      error?.response?.status ||
      error?.response?.statusCode ||
      0
  );
}

function remoteErrorMessage(error) {
  return String(
    error?.body?.message ||
      error?.response?.body?.message ||
      error?.message ||
      error ||
      "Unknown remote API error"
  );
}

export async function assertAudioInstallationPlanSnapshot(plan, { telnyx: suppliedTelnyx } = {}) {
  if (plan?.schemaVersion !== 10) {
    throw new Error("Audio Connector plan is outdated; refresh the plan before deployment");
  }
  const expected = plan.telnyxHandoffTool;
  if (!expected?.action || !["CREATE", "UPDATE"].includes(expected.action)) {
    throw new Error("Audio Connector plan has no Telnyx handoff tool snapshot; refresh the plan");
  }
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const current = await findSharedGenesysHandoffTool(telnyx, {
    preferredToolIds: [expected.id],
    displayName: expected.displayName,
  });
  if (expected.action === "CREATE" && current) {
    throw new Error("Telnyx handoff tool was created after plan review; refresh the plan");
  }
  if (expected.action === "UPDATE" && !current) {
    throw new Error("Telnyx handoff tool was deleted after plan review; refresh the plan");
  }
  if (expected.action === "UPDATE" && expected.id && telnyxToolId(current) !== expected.id) {
    throw new Error("Telnyx handoff tool identity changed after plan review; refresh the plan");
  }
  return current;
}

function remoteResourceState(value, { expectedId, expectedName, expectedType, actualType } = {}) {
  if (!value) return { state: "missing", value: null, detail: "not found" };
  const mismatches = [];
  if (expectedId && value.id !== expectedId) {
    mismatches.push(`ID is ${value.id || "missing"}; expected ${expectedId}`);
  }
  if (expectedName && value.name !== expectedName && value.display_name !== expectedName) {
    mismatches.push(
      `name is ${value.name || value.display_name || "missing"}; expected ${expectedName}`
    );
  }
  if (expectedType && actualType !== expectedType) {
    mismatches.push(`type is ${actualType || "missing"}; expected ${expectedType}`);
  }
  return mismatches.length
    ? { state: "drift", value, detail: mismatches.join("; ") }
    : { state: "ok", value, detail: "ID, name and type match the deployment manifest" };
}

async function readRemoteResource(operation) {
  try {
    return await operation();
  } catch (error) {
    if (remoteErrorStatus(error) === 404 || /not found/i.test(remoteErrorMessage(error))) {
      return null;
    }
    throw error;
  }
}

function assertDeploymentContext(deployment, context) {
  if (
    deployment.environment !== context.environment ||
    deployment.organization?.id !== context.organization?.id
  ) {
    throw new Error(
      `Deployment ${deployment.deployment.id} belongs to ${deployment.organization?.name || "another organization"} / ` +
        `${deployment.environment}, not the currently authenticated Genesys organization`
    );
  }
}

export async function inspectManagedAudioDeployment({
  deployment,
  context,
  telnyx = new Telnyx({ apiKey: required("TELNYX_API_KEY") }),
} = {}) {
  if (!deployment?.deployment?.id || !deployment?.resources) {
    throw new Error("A managed Audio deployment manifest is required");
  }
  assertDeploymentContext(deployment, context);
  const name = deployment.deployment.name;
  const toolDisplayName =
    deployment.resources.toolDisplayName || `Genesys Audio Handoff - ${name}`;
  const hangupToolDisplayName = deployment.resourceNames?.hangupToolName ||
    installationResourceNames().sharedHangupTool;
  const [assistant, tool, hangupTool, connector, connectorConfig, widget, widgetConfig, flow, script, callRoute] =
    await Promise.all([
      readRemoteResource(() => telnyx.ai.assistants.retrieve(deployment.resources.assistantId)),
      readRemoteResource(() => telnyx.ai.tools.retrieve(deployment.resources.toolId)),
      deployment.resources.hangupToolId
        ? readRemoteResource(() => telnyx.ai.tools.retrieve(deployment.resources.hangupToolId))
        : Promise.resolve(null),
      readRemoteResource(() =>
        context.integrationsApi.getIntegration(deployment.resources.audioConnectorIntegrationId)
      ),
      readRemoteResource(() =>
        context.integrationsApi.getIntegrationConfigCurrent(
          deployment.resources.audioConnectorIntegrationId
        )
      ),
      readRemoteResource(() => context.integrationsApi.getIntegration(deployment.resources.widgetId)),
      readRemoteResource(() =>
        context.integrationsApi.getIntegrationConfigCurrent(deployment.resources.widgetId)
      ),
      readRemoteResource(() => context.architectApi.getFlow(deployment.resources.flowId)),
      readRemoteResource(() => context.scriptsApi.getScript(deployment.resources.scriptId)),
      deployment.resources.callRouteId
        ? readRemoteResource(() => context.architectApi.getArchitectIvr(deployment.resources.callRouteId))
        : Promise.resolve(null),
    ]);

  return {
    deployment,
    resources: {
      assistant: remoteResourceState(assistant, {
        expectedId: deployment.resources.assistantId,
        expectedName: name,
      }),
      tool: remoteResourceState(tool ? { ...tool, name: telnyxToolDisplayName(tool) } : null, {
        expectedId: deployment.resources.toolId,
        expectedName: toolDisplayName,
      }),
      hangupTool: deployment.resources.hangupToolId
        ? remoteResourceState(hangupTool, {
            expectedId: deployment.resources.hangupToolId,
            expectedName: hangupToolDisplayName,
            expectedType: "hangup",
            actualType: hangupTool?.type,
          })
        : {
            state: "untracked",
            value: null,
            detail: "not recorded yet; Modify configuration will provision it",
          },
      audioConnector: {
        ...remoteResourceState(connector, {
          expectedId: deployment.resources.audioConnectorIntegrationId,
          expectedName: name,
          expectedType: AUDIO_CONNECTOR_TYPE,
          actualType: connector?.integrationType?.id,
        }),
        config: connectorConfig,
      },
      widget: {
        ...remoteResourceState(widget, {
          expectedId: deployment.resources.widgetId,
          expectedName: deployment.resourceNames?.widgetName || name,
          expectedType: INTERACTION_WIDGET_TYPE,
          actualType: widget?.integrationType?.id,
        }),
        config: widgetConfig,
      },
      architectFlow: remoteResourceState(flow, {
        expectedId: deployment.resources.flowId,
        expectedName: deployment.resourceNames?.flowName || name,
      }),
      handoffScript: remoteResourceState(script, {
        expectedId: deployment.resources.scriptId,
        expectedName: deployment.resourceNames?.handoffScriptName || name,
      }),
      callRoute: deployment.resources.callRouteId
        ? remoteResourceState(callRoute, {
            expectedId: deployment.resources.callRouteId,
            expectedName: deployment.resourceNames?.callRouteName || name,
          })
        : {
            state: "untracked",
            value: null,
            detail: "not recorded yet; Modify configuration will create the managed inbound call route",
          },
    },
  };
}

function assertInspectionOwnership(inspection, { allowMissing = false } = {}) {
  const blocking = Object.entries(inspection.resources).filter(([, resource]) =>
    resource.state === "drift" || resource.state === "error" ||
    (!allowMissing && resource.state === "missing")
  );
  if (blocking.length) {
    throw new Error(
      "Managed resource ownership validation failed: " +
        blocking.map(([key, resource]) => `${key}: ${resource.detail}`).join("; ")
    );
  }
}

export async function updateManagedAudioDeployment({
  deployment,
  context,
  queues = deployment?.queues,
  groups = deployment?.groups,
  ui = null,
  provisioner = runProvisioner,
  options = {},
} = {}) {
  const inspection = await inspectManagedAudioDeployment({ deployment, context });
  assertInspectionOwnership(inspection);
  const exactSelectedQueues = exactQueues(context, queues);
  const exactSelectedGroups = exactGroups(context, groups);
  const queueNamesJson = JSON.stringify(exactSelectedQueues.map(({ name }) => name));
  const queueEntriesJson = JSON.stringify(
    exactSelectedQueues.map(({ id, name: queueName }) => ({ id, name: queueName }))
  );
  const groupsJson = JSON.stringify(
    exactSelectedGroups.map(({ id, name }) => ({ id, name }))
  );
  const routes = Array.isArray(deployment.architect?.routes) && deployment.architect.routes.length
    ? deployment.architect.routes.map(({ dnis, assistantId, assistantName, takeover }) => ({
        dnis,
        assistantId,
        assistantName,
        ...(takeover === true ? { takeover: true } : {}),
      }))
    : genesysAudioDnisValues(deployment.architect?.dnis).map((dnis) => ({
        dnis,
        assistantId: deployment.resources.assistantId,
      }));
  const assistantIds = [...new Set(routes.map(({ assistantId }) => assistantId).filter(Boolean))];
  if (!assistantIds.length) {
    throw new Error("The managed Audio deployment has no DNIS-to-assistant assignments");
  }
  const name = deployment.deployment.name;
  const steps = [];
  const execute = async (label, script, args) => {
    ui?.printProgress("running", label);
    try {
      const result = await provisioner(script, {}, args);
      steps.push({ label, status: "success", result });
      ui?.printProgress("success", label);
      return result;
    } catch (error) {
      steps.push({ label, status: "failure", error: remoteErrorMessage(error) });
      ui?.printProgress("failure", label, remoteErrorMessage(error));
      throw error;
    }
  };

  const assistant = await execute(
    "Update the shared Telnyx handoff tool and selected AI assistants",
    "scripts/provision-telnyx-genesys-assistant.mjs",
    [
      "--assistant-ids-json", JSON.stringify(assistantIds),
      "--previous-assistant-ids-json", JSON.stringify(
        deployment.resources.assistantIds || [deployment.resources.assistantId].filter(Boolean)
      ),
      "--queues-json", queueEntriesJson,
      "--default-queue-id", deployment.defaultQueue?.id || exactSelectedQueues[0]?.id || "",
      ...(deployment.resources.toolId ? ["--tool-id", deployment.resources.toolId] : []),
      "--handoff-tool-name", deployment.resourceNames?.toolDisplayName || installationResourceNames().widgetHandoffTool,
      "--hangup-tool-name", deployment.resourceNames?.hangupToolName || installationResourceNames().sharedHangupTool,
    ]
  );
  const experience = await execute(
    "Update Genesys handoff script and interaction widget",
    "scripts/provision-genesys-ai-agent-experience.mjs",
    [
      "--activate-widget",
      "--resource-name",
      name,
      "--widget-name",
      deployment.resourceNames?.widgetName || name,
      "--script-name",
      deployment.resourceNames?.handoffScriptName || name,
      "--queues-json",
      queueNamesJson,
      "--groups-json",
      groupsJson,
    ]
  );
  const architect = await execute(
    "Update Audio Connector configuration and Architect flow",
    "scripts/provision-genesys-audio-connector-flow.mjs",
    [
      "--integration-id",
      deployment.resources.audioConnectorIntegrationId,
      "--assistant-routes-json",
      JSON.stringify(routes.map(({ dnis, assistantId }) => ({ dnis, assistantId }))),
      "--flow-name",
      deployment.resourceNames?.flowName || name,
      "--script-name",
      deployment.resourceNames?.handoffScriptName || name,
      "--call-route-name",
      deployment.resourceNames?.callRouteName || name,
      "--deployment-id",
      deployment.deployment.id,
      "--call-route-takeovers-json",
      JSON.stringify(deployment.callRoute?.takeovers || []),
      ...(deployment.resources.callRouteId
        ? ["--call-route-id", deployment.resources.callRouteId]
        : []),
    ]
  );

  const returnedIds = {
    toolId: assistant.tool?.id,
    widgetId: experience.widget?.id,
    scriptId: experience.script?.id,
    flowId: architect.flow?.id || architect.published?.id,
    callRouteId: architect.callRoute?.id,
    audioConnectorIntegrationId:
      architect.audioConnectorIntegration?.id || deployment.resources.audioConnectorIntegrationId,
  };
  for (const [key, value] of Object.entries(returnedIds)) {
    if (value && deployment.resources[key] && value !== deployment.resources[key]) {
      throw new Error(
        `${key} changed from manifest ID ${deployment.resources[key]} to ${value}; ` +
          "the deployment manifest was not updated"
      );
    }
  }
  const updated = {
    ...deployment,
    publicBaseUrl: publicGenesysBaseUrl(),
    queues: exactSelectedQueues.map(({ id, name: queueName }) => ({ id, name: queueName })),
    groups: exactSelectedGroups.map(({ id, name: groupName }) => ({ id, name: groupName })),
    architect: {
      ...deployment.architect,
      dnis: architect.configuredDnis || routes.map(({ dnis }) => dnis),
      routes,
    },
    resources: {
      ...deployment.resources,
      assistantId: assistantIds[0],
      assistantIds,
      toolId: assistant.tool?.id || deployment.resources.toolId,
      toolDisplayName: assistant.tool?.displayName ||
        deployment.resourceNames?.toolDisplayName ||
        installationResourceNames().widgetHandoffTool,
      toolFunctionName:
        assistant.tool?.functionName || "request_genesys_human_handoff",
      callRouteId: architect.callRoute?.id || deployment.resources.callRouteId,
    },
    resourceNames: {
      ...deployment.resourceNames,
      toolDisplayName: assistant.tool?.displayName || deployment.resourceNames?.toolDisplayName,
      callRouteName: architect.callRoute?.name || deployment.resourceNames?.callRouteName || name,
      publicBaseUrl: publicGenesysBaseUrl(),
    },
    updatedAt: new Date().toISOString(),
  };
  delete updated.filePath;
  await writeJsonAtomic(deployment.filePath, updated);
  const journal = {
    schemaVersion: 1,
    runId: randomUUID(),
    operation: "update",
    deployment: deployment.deployment,
    completedAt: updated.updatedAt,
    steps,
  };
  const journalPath = path.join(stateDirectory(options), "runs", `${journal.runId}.json`);
  await writeJsonAtomic(journalPath, journal);
  return { deployment: { ...updated, filePath: deployment.filePath }, journalPath };
}

async function deleteRemoteResource(operation) {
  try {
    const result = await operation();
    return { deleted: true, ...(result && typeof result === "object" ? result : {}) };
  } catch (error) {
    const message = remoteErrorMessage(error);
    if (remoteErrorStatus(error) === 404 || /not found|has been deleted/i.test(message)) {
      return { deleted: true, alreadyMissing: true };
    }
    throw error;
  }
}

async function disableIntegrationForDestroy(integrationsApi, integrationId) {
  const initial = await readRemoteResource(() => integrationsApi.getIntegration(integrationId));
  if (!initial) return { alreadyMissing: true };
  if (String(initial.intendedState || "").toUpperCase() !== "DISABLED") {
    await integrationsApi.patchIntegration(integrationId, {
      body: { intendedState: "DISABLED" },
    });
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await readRemoteResource(() => integrationsApi.getIntegration(integrationId));
    if (!current) return { alreadyMissing: true };
    const intendedState = String(current.intendedState || "").toUpperCase();
    const reportedState = String(current.reportedState?.code || "").toUpperCase();
    if (
      intendedState === "DISABLED" &&
      ["INACTIVE", "ERROR", ""].includes(reportedState)
    ) {
      return { disabled: true };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Genesys integration ${integrationId} did not become inactive before deletion`);
}

export async function destroyManagedAudioDeployment({
  deployment,
  context,
  telnyx = new Telnyx({ apiKey: required("TELNYX_API_KEY") }),
  ui = null,
  options = {},
  retainTelnyxAssistant = false,
  retainTelnyxTool = false,
  retainHangupTool = false,
} = {}) {
  const inspection = await inspectManagedAudioDeployment({ deployment, context, telnyx });
  assertInspectionOwnership(inspection, { allowMissing: true });
  const journal = {
    schemaVersion: 1,
    runId: randomUUID(),
    operation: "destroy",
    deployment: deployment.deployment,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
  };
  const journalPath = path.join(
    stateDirectory(options),
    "destroy-runs",
    `${journal.runId}.json`
  );
  const execute = async (label, operation, successDetail = "deleted") => {
    ui?.printProgress("running", label);
    const step = { label, status: "running", startedAt: new Date().toISOString() };
    journal.steps.push(step);
    await writeJsonAtomic(journalPath, journal);
    try {
      step.result = await deleteRemoteResource(operation);
      step.status = "success";
      step.completedAt = new Date().toISOString();
      await writeJsonAtomic(journalPath, journal);
      ui?.printProgress(
        "success",
        label,
        step.result.alreadyMissing ? "already absent" : successDetail
      );
    } catch (error) {
      step.status = "failure";
      step.error = remoteErrorMessage(error);
      journal.status = "failed";
      journal.completedAt = new Date().toISOString();
      await writeJsonAtomic(journalPath, journal);
      ui?.printProgress("failure", label, step.error);
      throw error;
    }
  };

  if (deployment.resources.callRouteId) {
    await execute("Delete Genesys inbound call route", () =>
      context.architectApi.deleteArchitectIvr(deployment.resources.callRouteId)
    );
  }
  await execute("Delete Genesys Architect flow", () =>
    context.architectApi.deleteFlow(deployment.resources.flowId)
  );
  await execute(
    "Disable Genesys interaction widget",
    () => disableIntegrationForDestroy(context.integrationsApi, deployment.resources.widgetId),
    "disabled"
  );
  await execute("Delete Genesys interaction widget", () =>
    context.integrationsApi.deleteIntegration(deployment.resources.widgetId)
  );
  await execute(
    "Disable Genesys Audio Connector",
    () => disableIntegrationForDestroy(
      context.integrationsApi,
      deployment.resources.audioConnectorIntegrationId
    ),
    "disabled"
  );
  await execute("Delete Genesys Audio Connector", () =>
    context.integrationsApi.deleteIntegration(deployment.resources.audioConnectorIntegrationId)
  );
  const audioHookCredentialId =
    inspection.resources.audioConnector.config?.credentials?.audioHook?.id;
  if (audioHookCredentialId) {
    await execute("Delete dedicated Genesys AudioHook credential", () =>
      context.integrationsApi.deleteIntegrationsCredential(audioHookCredentialId)
    );
  }
  if (!retainTelnyxAssistant) {
    await execute("Delete Telnyx AI assistant", () =>
      telnyx.ai.assistants.delete(deployment.resources.assistantId)
    );
  } else {
    journal.steps.push({
      label: "Transfer shared Telnyx AI assistant ownership",
      status: "retained",
      detail: "Assistant is also used by another managed deployment and was retained for reassignment.",
    });
  }
  if (!retainTelnyxTool) {
    await execute("Delete Telnyx handoff webhook tool", () =>
      telnyx.ai.tools.delete(deployment.resources.toolId)
    );
  }
  if (deployment.resources.hangupToolId && !retainHangupTool) {
    await execute("Delete Telnyx Hangup tool", () =>
      telnyx.ai.tools.delete(deployment.resources.hangupToolId)
    );
  } else if (deployment.resources.hangupToolId) {
    journal.steps.push({
      label: "Transfer shared Telnyx Hangup tool ownership",
      status: "retained",
      detail: "Hangup tool is used by the retained voice assistant and was kept for reassignment.",
    });
  }

  journal.steps.push({
    label: "Retain Genesys handoff script",
    status: "retained",
    detail:
      "Genesys Cloud exposes read, upload and publish APIs for scripts but no script delete API; " +
      "the deployment-named script remains available for manual administration.",
  });
  journal.status = "completed";
  journal.completedAt = new Date().toISOString();
  const archivedPath = path.join(
    stateDirectory(options),
    "destroyed",
    `${deployment.deployment.id}-${Date.now()}.json`
  );
  await mkdir(path.dirname(archivedPath), { recursive: true, mode: 0o700 });
  await rename(deployment.filePath, archivedPath);
  journal.archivedManifestPath = archivedPath;
  await writeJsonAtomic(journalPath, journal);
  return { journalPath, archivedPath, retainedScriptId: deployment.resources.scriptId };
}

export async function syncManagedDeploymentUrls({
  onProgress = () => {},
  options = {},
  provisioner = runProvisioner,
  deployments: suppliedDeployments,
  baseUrl,
} = {}) {
  const deployments = suppliedDeployments || await listManagedAudioDeployments({ options });
  const publicBaseUrl = publicGenesysBaseUrl(baseUrl);
  const results = [];
  const ownershipContext = provisioner === runProvisioner && deployments.length
    ? await connectGenesysAudio()
    : null;
  for (const deployment of deployments) {
    if (ownershipContext) {
      const inspection = await inspectManagedAudioDeployment({
        deployment,
        context: ownershipContext,
      });
      assertInspectionOwnership(inspection);
    }
    const name = deployment.deployment.name;
    const queuesJson = JSON.stringify(deployment.queues.map(({ name: queueName }) => queueName));
    const queueEntriesJson = JSON.stringify(
      deployment.queues.map(({ id, name: queueName }) => ({ id, name: queueName }))
    );
    const groupsJson = JSON.stringify(
      deployment.groups.map(({ id, name: groupName }) => ({ id, name: groupName }))
    );
    onProgress({ status: "running", label: `Updating Telnyx tool for ${name}` });
    const assistantIds = [...new Set(
      (deployment.architect?.routes || []).map((route) => route.assistantId).filter(Boolean)
    )];
    if (!assistantIds.length && deployment.resources.assistantId) {
      assistantIds.push(deployment.resources.assistantId);
    }
    const assistants = await provisioner(
      "scripts/provision-telnyx-genesys-assistant.mjs",
      { GC_PUBLIC_BASE_URL: publicBaseUrl },
      [
        "--assistant-ids-json", JSON.stringify(assistantIds),
        "--previous-assistant-ids-json", JSON.stringify(assistantIds),
        "--queues-json", queueEntriesJson,
        "--default-queue-id", deployment.defaultQueue?.id || deployment.queues[0]?.id || "",
        ...(deployment.resources.toolId ? ["--tool-id", deployment.resources.toolId] : []),
        "--handoff-tool-name", deployment.resourceNames?.toolDisplayName || installationResourceNames().widgetHandoffTool,
        "--hangup-tool-name", deployment.resourceNames?.hangupToolName || installationResourceNames().sharedHangupTool,
      ]
    );
    onProgress({ status: "success", label: `Updated Telnyx tool for ${name}` });

    onProgress({ status: "running", label: `Updating Genesys widget and OAuth for ${name}` });
    const experience = await provisioner(
      "scripts/provision-genesys-ai-agent-experience.mjs",
      { GC_PUBLIC_BASE_URL: publicBaseUrl },
      [
        "--activate-widget",
        "--widget-only",
        "--resource-name",
        name,
        "--widget-name",
        deployment.resourceNames?.widgetName || name,
        "--script-name",
        deployment.resourceNames?.handoffScriptName || name,
        "--queues-json",
        queuesJson,
        "--groups-json",
        groupsJson,
      ]
    );
    onProgress({ status: "success", label: `Updated Genesys widget and OAuth for ${name}` });

    onProgress({ status: "running", label: `Updating Genesys Audio Connector for ${name}` });
    const connector = await provisioner(
      "scripts/provision-genesys-audio-connector-flow.mjs",
      { GC_PUBLIC_BASE_URL: publicBaseUrl },
      [
        "--configure-only",
        "--integration-id",
        deployment.resources.audioConnectorIntegrationId,
        "--flow-name",
        name,
      ]
    );
    onProgress({ status: "success", label: `Updated Genesys Audio Connector for ${name}` });

    const updated = {
      ...deployment,
      publicBaseUrl,
      resourceNames: {
        ...deployment.resourceNames,
        publicBaseUrl,
      },
      resources: {
        ...deployment.resources,
        assistantId: assistantIds[0] || deployment.resources.assistantId,
        assistantIds,
        toolId: assistants.tool?.id || deployment.resources.toolId,
        toolDisplayName:
          assistants.tool?.displayName || deployment.resources.toolDisplayName || null,
        toolFunctionName:
          assistants.tool?.functionName || deployment.resources.toolFunctionName || null,
        widgetId: experience.widget?.id || deployment.resources.widgetId,
      },
      updatedAt: new Date().toISOString(),
    };
    delete updated.filePath;
    await writeJsonAtomic(deployment.filePath, updated);
    results.push({
      deploymentId: deployment.deployment.id,
      name,
      publicBaseUrl,
      assistantId: updated.resources.assistantId,
      toolId: updated.resources.toolId,
      hangupToolId: updated.resources.hangupToolId,
      widgetId: updated.resources.widgetId,
      audioConnectorIntegrationId: connector.audioConnectorIntegration?.id,
    });
  }
  return results;
}

// Idempotent by display name so repeated Audio Connector runs reuse the same
// shared tools instead of accumulating copies.
async function ensureSharedGenesysCallTools(currentResources = {}) {
  const names = installationResourceNames();
  const telnyx = new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const ensure = async (definition, knownId) => {
    let existing = null;
    if (knownId) {
      try {
        existing = await telnyx.ai.tools.retrieve(knownId);
      } catch (error) {
        const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
        if (status !== 404) throw error;
      }
    }
    existing = existing || await findTelnyxToolByName(
      telnyx,
      definition.display_name,
      definition.type
    );
    const saved = existing
      ? await telnyx.ai.tools.update(telnyxToolId(existing), definition)
      : await telnyx.ai.tools.create(definition);
    return saved?.id || null;
  };
  return {
    inviteToolId: await ensure(
      genesysSipInviteToolDefinition({
        displayName: names.sharedInviteTool,
        from: TELNYX_END_USER_TARGET_TEMPLATE,
        targetName: "Genesys Cloud",
        dynamicDestination: true,
      }),
      currentResources.inviteToolId
    ),
    skipTurnToolId: await ensure(
      genesysSkipTurnToolDefinition({ displayName: names.sharedSkipTurnTool }),
      currentResources.skipTurnToolId
    ),
  };
}

export async function applyAudioInstallationPlan(planPath, { ui = null } = {}) {
  const plan = await readJson(planPath);
  const operations = audioInstallationOperations(plan);
  await assertAudioInstallationPlanSnapshot(plan);
  if (plan.resources?.publicBaseUrl !== publicGenesysBaseUrl()) {
    throw new Error("GC_PUBLIC_BASE_URL changed after the installation plan was created");
  }
  const context = await connectGenesysAudio();
  if (context.environment !== plan.environment || context.organization.id !== plan.organization.id) {
    throw new Error("Plan belongs to a different Genesys region or organization");
  }
  const integrationTarget = plan.audioConnector.operation === "create-managed"
    ? await ensureAudioConnectorDeployment(context.integrationsApi, plan.audioConnector.name)
    : { integration: await context.integrationsApi.getIntegration(plan.audioConnector.id), created: false };
  const integration = integrationTarget.integration;
  if (
    integration.name !== plan.audioConnector.name ||
    integration.integrationType?.id !== AUDIO_CONNECTOR_TYPE
  ) {
    throw new Error("The single managed Genesys Audio Connector changed after plan review");
  }
  const queues = exactQueues(context, plan.queues);
  const groups = exactGroups(context, plan.groups);
  const queueNamesJson = JSON.stringify(queues.map(({ name }) => name));
  const queueEntriesJson = JSON.stringify(queues.map(({ id, name }) => ({ id, name })));
  const groupsJson = JSON.stringify(groups.map(({ id, name }) => ({ id, name })));
  const run = {
    schemaVersion: 1,
    runId: randomUUID(),
    planId: plan.planId,
    startedAt: new Date().toISOString(),
    status: "running",
    deployment: plan.deployment,
    steps: [],
  };
  const runPath = path.join(stateDirectory(), "runs", `${run.runId}.json`);
  const execute = async (name, script, extraEnvironment = {}, extraArgs = []) => {
    ui?.printProgress("running", name);
    const step = { name, status: "running", startedAt: new Date().toISOString() };
    run.steps.push(step);
    await writeJsonAtomic(runPath, run);
    try {
      step.result = await runProvisioner(script, extraEnvironment, extraArgs);
      step.status = "success";
      step.completedAt = new Date().toISOString();
      await writeJsonAtomic(runPath, run);
      ui?.printProgress("success", name);
      return step.result;
    } catch (error) {
      step.status = "failure";
      step.error = provisionerFailureDetail(error);
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      await writeJsonAtomic(runPath, run);
      ui?.printProgress("failure", name, step.error);
      throw new Error(step.error, { cause: error });
    }
  };

  let managedAssistantResult = null;
  if (operations.managedAssistant) {
    managedAssistantResult = await execute(
      AUDIO_APPLY_LABELS.managedAssistant,
      "scripts/provision-telnyx-genesys-assistant.mjs",
      {},
      [
        "--assistant-name", plan.managedAssistant.name,
        "--queues-json", queueEntriesJson,
        "--default-queue-id", plan.defaultQueue?.id || "",
        "--assistant-config-json", JSON.stringify(plan.managedAssistant),
        ...(plan.telnyxHandoffTool?.id ? ["--tool-id", plan.telnyxHandoffTool.id] : []),
        ...(plan.telnyxHangupTool?.id ? ["--hangup-tool-id", plan.telnyxHangupTool.id] : []),
        "--handoff-tool-name", plan.telnyxHandoffTool.displayName,
        "--hangup-tool-name", plan.telnyxHangupTool.displayName,
      ]
    );
  }
  // Invite and Skip Turn cannot serve an Audio Connector call, which Architect has
  // already bridged into Genesys. They are provisioned here because this is where
  // the installation creates its shared Telnyx tools, so a Web Calls widget can
  // adopt them and any assistant can be given them later.
  const sharedCallToolsStep = { name: AUDIO_APPLY_LABELS.sharedCallTools, status: "running", startedAt: new Date().toISOString() };
  run.steps.push(sharedCallToolsStep);
  ui?.printProgress("running", sharedCallToolsStep.name);
  let sharedCallTools = { inviteToolId: null, skipTurnToolId: null };
  try {
    sharedCallTools = await ensureSharedGenesysCallTools(plan.currentResources || {});
    sharedCallToolsStep.status = "success";
    sharedCallToolsStep.completedAt = new Date().toISOString();
    ui?.printProgress("success", sharedCallToolsStep.name);
  } catch (error) {
    // A Web Calls widget provisions this pair itself when it needs them, so the
    // Audio Connector run must not fail over a convenience step.
    sharedCallToolsStep.status = "failure";
    sharedCallToolsStep.error = provisionerFailureDetail(error);
    ui?.printProgress("failure", sharedCallToolsStep.name, sharedCallToolsStep.error);
  }
  await writeJsonAtomic(runPath, run);
  const resolvedRoutes = plan.architect.routes.map((route) => ({
    ...route,
    assistantId: route.assistantId === "__managed_default__"
      ? managedAssistantResult?.assistant?.id
      : route.assistantId,
    assistantName: route.assistantId === "__managed_default__"
      ? managedAssistantResult?.assistant?.name || plan.managedAssistant?.name
      : route.assistantName,
  }));
  if (resolvedRoutes.some(({ assistantId }) => !assistantId)) {
    throw new Error("The default Telnyx assistant did not return an ID");
  }
  const assistantIds = [...new Set(resolvedRoutes.map((route) => route.assistantId))];
  let assistants = {
    tool: {
      id: plan.currentResources?.toolId || null,
      displayName: plan.currentResources?.toolDisplayName || null,
      functionName: plan.currentResources?.toolFunctionName || null,
    },
  };
  if (operations.assistants) {
    assistants = await execute(
      AUDIO_APPLY_LABELS.assistants,
      "scripts/provision-telnyx-genesys-assistant.mjs",
      {},
      [
        "--assistant-ids-json", JSON.stringify(assistantIds),
        "--previous-assistant-ids-json", JSON.stringify(plan.architect.previousAssistantIds || []),
        "--queues-json", queueEntriesJson,
        "--default-queue-id", plan.defaultQueue?.id || "",
        ...((plan.telnyxHandoffTool?.id || managedAssistantResult?.tool?.id)
          ? ["--tool-id", plan.telnyxHandoffTool?.id || managedAssistantResult.tool.id]
          : []),
        "--handoff-tool-name", plan.telnyxHandoffTool.displayName,
        "--hangup-tool-name", plan.telnyxHangupTool.displayName,
      ]
    );
  }
  let experience = {
    widget: { id: plan.currentResources?.widgetId || null },
    script: { id: plan.currentResources?.scriptId || null },
  };
  if (operations.interactionWidget || operations.handoffScript) {
    experience = await execute(
      operations.handoffScript ? AUDIO_APPLY_LABELS.experience : AUDIO_APPLY_LABELS.widgetOnly,
      "scripts/provision-genesys-ai-agent-experience.mjs",
      {},
      [
        "--activate-widget",
        ...(operations.handoffScript ? [] : ["--widget-only"]),
        "--resource-name",
        plan.resources.widgetName,
        "--widget-name",
        plan.resources.widgetName,
        "--script-name",
        plan.resources.handoffScriptName,
        "--queues-json",
        queueNamesJson,
        "--groups-json",
        groupsJson,
      ]
    );
  }
  let architect = {
    flow: { id: plan.currentResources?.flowId || null },
    callRoute: { id: plan.currentResources?.callRouteId || null },
    audioConnectorIntegration: { id: plan.currentResources?.audioConnectorIntegrationId || integration.id },
    configuredDnis: [...plan.architect.dnis],
  };
  if (operations.audioConnector || operations.architectFlow || operations.callRoute) {
    architect = await execute(
      AUDIO_APPLY_LABELS.architect,
      "scripts/provision-genesys-audio-connector-flow.mjs",
      {},
      [
        "--integration-id",
        integration.id,
        "--assistant-routes-json",
        JSON.stringify(resolvedRoutes.map(({ dnis: value, assistantId }) => ({
          dnis: value,
          assistantId,
        }))),
        "--flow-name",
        plan.resources.flowName,
        "--script-name",
        plan.resources.handoffScriptName,
        "--call-route-name",
        plan.callRoute.name,
        "--deployment-id",
        plan.deployment.id,
        "--call-route-takeovers-json",
        JSON.stringify(plan.callRoute.takeovers || []),
        "--call-route-owner-takeovers-json",
        JSON.stringify(plan.callRoute.ownerTakeovers || []),
        ...(operations.audioConnector ? [] : ["--skip-connector"]),
        ...(operations.architectFlow ? [] : ["--skip-flow"]),
        ...(operations.callRoute ? [] : ["--skip-call-route"]),
        ...(plan.callRoute.id ? ["--call-route-id", plan.callRoute.id] : []),
      ]
    );
  }
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  run.operations = operations;
  run.assistantIds = assistantIds;
  run.resources = {
    ...plan.currentResources,
    assistantId: assistantIds[0],
    assistantIds,
    toolId: assistants.tool?.id || plan.currentResources?.toolId || null,
    toolDisplayName: assistants.tool?.displayName || plan.currentResources?.toolDisplayName || plan.telnyxHandoffTool.displayName,
    toolFunctionName: assistants.tool?.functionName || plan.currentResources?.toolFunctionName || "request_genesys_human_handoff",
    hangupToolId:
      managedAssistantResult?.hangupTool?.id || plan.currentResources?.hangupToolId || null,
    inviteToolId: sharedCallTools.inviteToolId,
    skipTurnToolId: sharedCallTools.skipTurnToolId,
    hangupAssistantIds: [...new Set([
      ...(plan.currentResources?.hangupAssistantIds || []),
      ...(managedAssistantResult?.assistant?.id ? [managedAssistantResult.assistant.id] : []),
    ])],
    audioConnectorIntegrationId: integration.id,
    widgetId: experience.widget?.id || plan.currentResources?.widgetId || null,
    flowId: architect.flow?.id || architect.published?.id || plan.currentResources?.flowId || null,
    callRouteId: architect.callRoute?.id || plan.currentResources?.callRouteId || null,
    scriptId: experience.script?.id || plan.currentResources?.scriptId || null,
  };
  run.configuredDnis = architect.configuredDnis || [...plan.architect.dnis];
  run.manualAction = `Genesys inbound call route '${plan.callRoute.name}' assigns ${
    run.configuredDnis.join(", ")
  } to Architect flow '${plan.resources.flowName}'.`;
  await writeJsonAtomic(runPath, run);
  const deployment = {
    schemaVersion: 1,
    deployment: plan.deployment,
    environment: plan.environment,
    organization: plan.organization,
    publicBaseUrl: plan.resources.publicBaseUrl,
    queues,
    groups,
    architect: {
      dnis: [...plan.architect.dnis],
      routes: resolvedRoutes.map(({ dnis: value, assistantId, assistantName }) => ({
        dnis: value,
        assistantId,
        assistantName,
      })),
    },
    defaultQueue: plan.defaultQueue || queues[0],
    resourceNames: plan.resources,
    resources: run.resources,
    updatedAt: new Date().toISOString(),
  };
  const deploymentPath = path.join(
    stateDirectory(),
    "deployments",
    `${plan.deployment.id}.json`
  );
  ui?.printProgress("running", "Persist the managed Audio Connector manifest");
  await writeJsonAtomic(deploymentPath, deployment);
  await registerManagedAgentExperience({
    organizationId: plan.organization.id,
    interactionWidget: {
      remoteId: run.resources.widgetId,
      displayName: plan.resources.widgetName,
    },
    handoffScript: {
      remoteId: run.resources.scriptId,
      displayName: plan.resources.handoffScriptName,
    },
  });
  await registerManagedResourceBatch({
    organizationId: plan.organization.id,
    aggregate: {
      kind: "audio_connector",
      name: "installation:audio",
      desiredConfig: { installationName: installationResourceNames().installationName },
    },
    resources: [
      {
        key: "audio_connector", provider: "genesys", resourceType: "audio_connector",
        remoteId: run.resources.audioConnectorIntegrationId, displayName: plan.resources.audioConnectorName,
        logicalKey: "audio_connector",
      },
      {
        key: "inbound_flow", provider: "genesys", resourceType: "architect_inbound_flow",
        remoteId: run.resources.flowId, displayName: plan.resources.flowName,
        logicalKey: "audio_inbound_flow",
      },
      {
        key: "inbound_route", provider: "genesys", resourceType: "inbound_call_route",
        remoteId: run.resources.callRouteId, displayName: plan.callRoute.name,
        logicalKey: "audio_inbound_route",
      },
      {
        key: "handoff_tool", provider: "telnyx", resourceType: "ai_tool",
        remoteId: run.resources.toolId, displayName: run.resources.toolDisplayName,
        logicalKey: "shared_handoff_tool",
      },
      {
        key: "hangup_tool", provider: "telnyx", resourceType: "ai_tool",
        remoteId: run.resources.hangupToolId, displayName: installationResourceNames().sharedHangupTool,
        logicalKey: "shared_hangup_tool",
      },
      {
        key: "invite_tool", provider: "telnyx", resourceType: "ai_tool",
        remoteId: run.resources.inviteToolId, displayName: installationResourceNames().sharedInviteTool,
        logicalKey: "shared_invite_tool",
      },
      {
        key: "skip_turn_tool", provider: "telnyx", resourceType: "ai_tool",
        remoteId: run.resources.skipTurnToolId, displayName: installationResourceNames().sharedSkipTurnTool,
        logicalKey: "shared_skip_turn_tool",
      },
      {
        key: "integration_secret", provider: "telnyx", resourceType: "integration_secret",
        remoteId: managedAssistantResult?.integrationSecret?.id,
        displayName: managedAssistantResult?.integrationSecret?.identifier || "Genesys handoff secret",
        logicalKey: "handoff_integration_secret",
      },
      {
        key: "managed_assistant", provider: "telnyx", resourceType: "ai_assistant",
        remoteId: managedAssistantResult?.assistant?.created ? managedAssistantResult.assistant.id : null,
        displayName: managedAssistantResult?.assistant?.name,
        logicalKey: "audio_default_assistant",
      },
    ],
    dependencies: [
      { resource: "inbound_flow", dependsOn: "audio_connector", relationship: "uses_connector" },
      { resource: "inbound_route", dependsOn: "inbound_flow", relationship: "routes_to_flow" },
      { resource: "handoff_tool", dependsOn: "integration_secret", relationship: "uses_secret" },
      { resource: "managed_assistant", dependsOn: "handoff_tool", relationship: "uses_tool" },
      { resource: "managed_assistant", dependsOn: "hangup_tool", relationship: "uses_tool" },
    ],
  });
  ui?.printProgress("success", "Persist the managed Audio Connector manifest", "Managed deployment state saved");
  return { run, runPath, deploymentPath, manualAction: run.manualAction };
}

function printDeploymentConfiguration(deployment) {
  console.log(`\nApplication: ${deployment.deployment.applicationName}`);
  console.log(`Deployment: ${deployment.deployment.name}`);
  console.log(`Deployment ID: ${deployment.deployment.id}`);
  console.log(`Organization: ${deployment.organization.name} (${deployment.organization.id})`);
  console.log(`Region: ${deployment.environment}`);
  console.log(`Public URL: ${deployment.publicBaseUrl}`);
  console.log(`Last updated: ${deployment.updatedAt || "unknown"}`);
  console.log("Allowed handoff queues:");
  deployment.queues.forEach(({ id, name }) => console.log(`  - ${name} (${id})`));
  console.log("Widget access groups:");
  deployment.groups.forEach(({ id, name }) => console.log(`  - ${name} (${id})`));
  console.log("Architect DNIS cases:");
  const routes = Array.isArray(deployment.architect?.routes) && deployment.architect.routes.length
    ? deployment.architect.routes
    : (deployment.architect?.dnis || []).map((dnis) => ({
        dnis,
        assistantId: deployment.resources.assistantId,
      }));
  routes.forEach(({ dnis, assistantName, assistantId }, index) => {
    console.log(`  ${index + 1}. ${dnis} -> ${assistantName || assistantId}`);
  });
  console.log("Managed object IDs:");
  console.log(`  Telnyx assistant:       ${deployment.resources.assistantId}`);
  console.log(`  Telnyx webhook tool:    ${deployment.resources.toolId}`);
  console.log(`  Telnyx Hangup tool:     ${deployment.resources.hangupToolId || "not recorded"}`);
  console.log(`  Genesys Audio Connector:${deployment.resources.audioConnectorIntegrationId}`);
  console.log(`  Genesys widget:         ${deployment.resources.widgetId}`);
  console.log(`  Genesys Architect flow: ${deployment.resources.flowId}`);
  console.log(`  Genesys inbound route:  ${deployment.resources.callRouteId || "not recorded"}`);
  console.log(`  Genesys handoff script: ${deployment.resources.scriptId}`);
}

function printInspection(ui, inspection) {
  const resources = inspection.resources;
  const label = (state) => state === "ok" ? "ok" : state === "drift" || state === "untracked" ? "warning" : "missing";
  console.log(ui.color.accent("\nLive resource ownership and status"));
  for (const [key, resource] of Object.entries(resources)) {
    ui.printCheck(key, label(resource.state), resource.detail);
  }
  const assistant = resources.assistant.value;
  const tool = resources.tool.value;
  const connector = resources.audioConnector.value;
  const connectorConfig = resources.audioConnector.config;
  const widget = resources.widget.value;
  const widgetConfig = resources.widget.config;
  const flow = resources.architectFlow.value;
  const script = resources.handoffScript.value;
  console.log(ui.color.accent("\nLive configuration"));
  console.log(`  Assistant name:         ${assistant?.name || "not available"}`);
  console.log(`  Webhook URL:            ${tool?.webhook?.url || "not available"}`);
  console.log(
    `  Audio Connector state:  ${connector?.intendedState || "not available"} / ` +
      `${connector?.reportedState?.code || "unknown"}`
  );
  console.log(`  Audio Connector URI:    ${connectorConfig?.properties?.baseUri || "not available"}`);
  console.log(
    `  Widget state:           ${widget?.intendedState || "not available"} / ` +
      `${widget?.reportedState?.code || "unknown"}`
  );
  console.log(`  Widget URL:             ${widgetConfig?.properties?.url || "not available"}`);
  console.log(
    `  Widget group IDs:       ${(widgetConfig?.properties?.groups || []).join(", ") || "none"}`
  );
  console.log(
    `  Widget queue IDs:       ${(widgetConfig?.properties?.queueIdFilterList || []).join(", ") || "none"}`
  );
  console.log(
    `  Architect flow:         ${flow?.name || "not available"} (${flow?.publishedVersion?.id || flow?.version || "unknown version"})`
  );
  console.log(`  Handoff script:         ${script?.name || "not available"}`);
}

async function reviewDeployment(ui, deployment, context) {
  printDeploymentConfiguration(deployment);
  try {
    const inspection = await ui.withSpinner(
      "Reading managed resources from Genesys Cloud and Telnyx",
      () => inspectManagedAudioDeployment({ deployment, context })
    );
    printInspection(ui, inspection);
  } catch (error) {
    ui.printProgress("failure", "Live deployment review", remoteErrorMessage(error));
  }
  await ui.pause();
}

async function modifyDeployment(ui, deployment, context) {
  let current = deployment;
  while (true) {
    const action = await ui.selectMenu(`Modify ${current.deployment.name}`, [
      {
        label: "Allowed handoff queues",
        value: "queues",
        description: "Updates the shared webhook enum and widget queue filter.",
      },
      {
        label: "Widget access groups",
        value: "groups",
        description: "Updates which Genesys groups can access the interaction widget.",
      },
      {
        label: "Reapply current configuration",
        value: "reapply",
        description: "Reconciles all managed resources without changing the selected values.",
      },
      ui.backOption(),
    ]);
    if (action === "back") return current;
    let queues = current.queues;
    let groups = current.groups;
    if (action === "queues") {
      const selected = await ui.checkboxMenu(
        "Select every Genesys queue the AI assistant may use for handoff",
        context.queues.map((queue) => ({
          label: queue.name,
          value: queue.id,
          checked: current.queues.some(({ id }) => id === queue.id),
        })),
        { validate: (values) => values.length ? true : "Select at least one handoff queue" }
      );
      queues = selected.map((id) => context.queues.find((queue) => queue.id === id));
    } else if (action === "groups") {
      const selected = await ui.checkboxMenu(
        "Select every Genesys group that may access the interaction widget",
        context.groups.map((group) => ({
          label: group.name,
          value: group.id,
          checked: current.groups.some(({ id }) => id === group.id),
        })),
        { validate: (values) => values.length ? true : "Select at least one widget access group" }
      );
      groups = selected.map((id) => context.groups.find((group) => group.id === id));
    }
    console.log("\nUpdate preview");
    console.log(`Deployment: ${current.deployment.name}`);
    console.log(`Queues: ${queues.map(({ name }) => name).join(", ")}`);
    console.log(`Groups: ${groups.map(({ name }) => name).join(", ")}`);
    console.log(
      `DNIS assignments: ${(current.architect.routes || []).map(({ dnis, assistantId }) =>
        `${dnis} -> ${assistantId}`
      ).join(", ")}`
    );
    if (!(await ui.confirm("Apply these changes to the managed deployment?", false))) continue;
    const result = await updateManagedAudioDeployment({
      deployment: current,
      context,
      queues,
      groups,
      ui,
    });
    current = result.deployment;
    console.log(ui.color.success(`Deployment updated. Run journal: ${result.journalPath}`));
    await ui.pause();
  }
}

async function destroyDeploymentInteractive(ui, deployment, context) {
  printDeploymentConfiguration(deployment);
  console.log(ui.color.danger("\nDestroy preview — remote deletion is irreversible"));
  console.log("The assistant, handoff tool, Audio Connector, widget and Architect flow will be deleted.");
  console.log(
    ui.color.warning(
      "The Genesys handoff script is retained because Genesys Cloud does not expose a script deletion API."
    )
  );
  console.log("The shared OAuth client and Telnyx integration secret will be retained.");
  if (!(await ui.confirm(`Permanently destroy deployment ${deployment.deployment.name}?`, false))) {
    return false;
  }
  const confirmation = String(
    await ui.input("Type the 6-character deployment ID to confirm", "")
  ).trim().toUpperCase();
  if (confirmation !== deployment.deployment.id) {
    console.log(ui.color.warning("Deployment ID did not match. Nothing was deleted."));
    await ui.pause();
    return false;
  }
  const result = await destroyManagedAudioDeployment({ deployment, context, ui });
  console.log(ui.color.success(`Deployment destroyed. Journal: ${result.journalPath}`));
  console.log(`Archived manifest: ${result.archivedPath}`);
  console.log(ui.color.warning(`Retained Genesys script ID: ${result.retainedScriptId}`));
  await ui.pause();
  return true;
}

async function deploymentMenu(ui, deployment, context) {
  let current = deployment;
  while (true) {
    const action = await ui.selectMenu(`Deployment ${current.deployment.name}`, [
      { label: "Review configuration and live status", value: "review" },
      { label: "Modify configuration", value: "modify" },
      {
        label: "Synchronize current public URL",
        value: "sync-url",
        description: "Updates this deployment's Telnyx tool, widget, OAuth callback and Audio Connector URI.",
      },
      { label: "Destroy deployment", value: "destroy" },
      ui.backOption("All deployments"),
    ]);
    if (action === "back") return;
    if (action === "review") await reviewDeployment(ui, current, context);
    if (action === "modify") current = await modifyDeployment(ui, current, context);
    if (action === "sync-url") {
      const results = await syncManagedDeploymentUrls({
        deployments: [current],
        onProgress(event) {
          ui.printProgress(event.status, event.label, event.detail);
        },
      });
      console.log(ui.color.success(`Public URL synchronized: ${results[0].publicBaseUrl}`));
      current = (await listManagedAudioDeployments()).find(
        ({ deployment: entry }) => entry.id === current.deployment.id
      );
      await ui.pause();
    }
    if (action === "destroy" && await destroyDeploymentInteractive(ui, current, context)) return;
  }
}

function printTunnelStatus(ui, status) {
  console.log(ui.color.accent("\nCloudflare Quick Tunnel status"));
  if (!status.state) {
    ui.printCheck("Managed tunnel", "warning", "not configured or no managed state exists");
    console.log(`  Configured public URL:   ${process.env.GC_PUBLIC_BASE_URL || "not configured"}`);
    return;
  }
  ui.printCheck("Managed tunnel", status.running ? "ok" : "warning", status.running ? "running" : "stopped");
  ui.printCheck("Tunnel health", status.healthy ? "ok" : "warning", status.healthy ? "local and public checks passed" : "one or more checks failed");
  console.log(`  Public URL:              ${status.state.publicBaseUrl || "not available"}`);
  console.log(`  Local URL:               ${status.state.localBaseUrl || "not available"}`);
  console.log(`  cloudflared process:     ${status.processes?.cloudflared?.running ? `running (PID ${status.processes.cloudflared.pid})` : "stopped"}`);
  console.log(`  Application server:      ${status.processes?.server?.running ? "running" : "stopped"}${status.processes?.server?.managed ? " (managed)" : " (user-managed)"}`);
  console.log(`  Local health:            ${status.health?.local?.ok ? "OK" : status.health?.local?.error || `HTTP ${status.health?.local?.status || 0}`}`);
  console.log(`  Public health:           ${status.health?.public?.ok ? "OK" : status.health?.public?.error || `HTTP ${status.health?.public?.status || 0}`}`);
}

async function tunnelMenu(ui) {
  while (true) {
    const status = await ui.withSpinner("Checking managed tunnel state", getQuickTunnelStatus);
    printTunnelStatus(ui, status);
    const reusableTunnel = managedQuickTunnelCanBeReused(status);
    const lifecycleChoice = reusableTunnel
      ? {
          label: "Stop and deactivate managed Quick Tunnel",
          value: "deactivate",
          description: status.healthy
            ? "Stops the tunnel after warning about deployments that still reference its URL."
            : "The public hostname is reachable but the local app is stopped; deactivate the tunnel if it is no longer needed.",
        }
      : {
          label: status.state
            ? "Replace unavailable managed Quick Tunnel"
            : "Start managed Quick Tunnel",
          value: "activate",
          description: status.state
            ? "Stops the stale process, creates and validates a new URL, then synchronizes deployments."
            : "Creates and validates a temporary URL, then synchronizes deployments.",
        };
    const action = await ui.selectMenu("Manage Cloudflare Quick Tunnel", [
      lifecycleChoice,
      { label: "Refresh status", value: "refresh" },
      { label: "Use an existing public HTTPS origin", value: "manual" },
      { label: "Synchronize URL to all managed deployments", value: "sync" },
      ui.backOption("Main menu"),
    ]);
    if (action === "back") return;
    if (action === "refresh") continue;
    if (action === "activate") {
      const configuredUrl = String(process.env.GC_PUBLIC_BASE_URL || "").trim();
      if (
        configuredUrl &&
        !isCloudflareQuickTunnelUrl(configuredUrl) &&
        !(await ui.confirm(
          `Replace the configured public origin ${configuredUrl} with a temporary Cloudflare Quick Tunnel?`,
          false
        ))
      ) {
        console.log(
          ui.color.warning(
            "Quick Tunnel activation cancelled; the configured public URL was not changed."
          )
        );
        continue;
      }
      const tunnel = await startCloudflareQuickTunnel({
        onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
      });
      try {
        const synchronized = await updateManagedPublicOrigin({
          baseUrl: tunnel.publicBaseUrl,
          previousBaseUrl: configuredUrl,
          onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
        });
        console.log(
          ui.color.success(
            `Saved managed Quick Tunnel URL and updated ${synchronized.total} deployment(s).`
          )
        );
      } catch (error) {
        if (!tunnel.reused) await stopCloudflareQuickTunnel().catch(() => {});
        throw error;
      }
      console.log(ui.color.success(`Managed Quick Tunnel URL: ${tunnel.publicBaseUrl}`));
      await ui.pause();
    }
    if (action === "manual") {
      const value = await ui.input(CONFIGURATION_PROMPTS.GC_PUBLIC_BASE_URL, process.env.GC_PUBLIC_BASE_URL, {
        validate(input) {
          try {
            normalizeInstallerConfigurationValue("GC_PUBLIC_BASE_URL", input);
            return true;
          } catch (error) {
            return error.message;
          }
        },
      });
      const synchronized = await updateManagedPublicOrigin({
        baseUrl: normalizeInstallerConfigurationValue("GC_PUBLIC_BASE_URL", value),
        onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
      });
      console.log(ui.color.success(`Saved public URL and updated ${synchronized.total} managed deployment(s).`));
      await ui.pause();
    }
    if (action === "sync") {
      const synchronized = await synchronizeAllManagedDeploymentUrls({
        onProgress: (event) => ui.printProgress(event.status, event.label, event.detail),
      });
      console.log(ui.color.success(`Updated ${synchronized.total} managed deployment(s).`));
      await ui.pause();
    }
    if (action === "deactivate") {
      const { listManagedWidgetDeployments } = await import("./manage-genesys-widget.mjs");
      const [audioDeployments, widgetDeployments] = await Promise.all([
        listManagedAudioDeployments(),
        listManagedWidgetDeployments(),
      ]);
      const consumers = audioDeployments.length + widgetDeployments.length;
      if (
        consumers > 0 &&
        !(await ui.confirm(
          `${consumers} managed deployment(s) still reference this URL. Stop the tunnel without clearing GC_PUBLIC_BASE_URL?`,
          false
        ))
      ) {
        console.log(ui.color.warning("Quick Tunnel stop cancelled."));
        continue;
      }
      const result = await stopCloudflareQuickTunnel();
      console.log(
        result.alreadyStopped
          ? ui.color.warning("No managed Quick Tunnel was running.")
          : ui.color.success("Managed Quick Tunnel stopped.")
      );
      console.log(
        ui.color.muted(
          "GC_PUBLIC_BASE_URL and managed resources retain the stopped URL. Configure a replacement URL and synchronize before using either integration."
        )
      );
      await ui.pause();
    }
  }
}

async function interactiveMain() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY. Use status/help for automation.");
  }
  const ui = await import("../lib/genesys/genesys-admin-ui.mjs");
  ui.header(
    "Telnyx × Genesys Cloud Administration CLI",
    "AI Assistant, Audio Connector, handoff, Architect and widget"
  );
  if (!(await configureAndVerifyGenesys(ui))) {
    console.log(
      ui.color.warning(
        "No remote changes were made. Update the required configuration and retry in Web Admin."
      )
    );
    return;
  }
  if (!(await configureAndVerifyTelnyx(ui))) {
    console.log(
      ui.color.warning(
        "No remote changes were made. Update the required configuration and retry in Web Admin."
      )
    );
    return;
  }

  const missingSecrets = missingAudioSecretNames();
  if (missingSecrets.length) {
    console.log(ui.color.accent("\nAudio secret bootstrap"));
    missingSecrets.forEach((name) => ui.printCheck(name, "missing", "can be generated"));
    const shouldGenerate = await ui.confirm(
      `Generate ${missingSecrets.length} missing Audio secret(s) and save them securely?`,
      true
    );
    if (shouldGenerate) {
      const bootstrap = await ui.withSpinner(
        "Generating and securely saving Audio secrets",
        bootstrapMissingAudioSecrets
      );
      console.log(
        ui.color.success(
          `Generated ${bootstrap.generated.join(", ")} and saved them to ${bootstrap.envFile}`
        )
      );
    }
  }

  const remainingBeforeUrl = environmentChecks()
    .filter(({ name, present }) => name !== "GC_PUBLIC_BASE_URL" && !present)
    .map(({ name }) => name);
  if (remainingBeforeUrl.length) {
    const values = await requestConfiguration(ui, remainingBeforeUrl);
    if (values === null) return;
    await saveInteractiveConfiguration(ui, values);
  }
  if (!environmentPresence("GC_PUBLIC_BASE_URL") && !(await configurePublicBaseUrl(ui))) {
    console.log(
      ui.color.warning(
        "No remote changes were made. Update the required configuration and retry in Web Admin."
      )
    );
    return;
  }

  console.log(ui.color.accent("\nCompleted startup checks"));
  const checks = environmentChecks();
  checks.forEach(({ name, present }) => ui.printCheck(name, present ? "ok" : "missing"));
  const missing = checks.filter((check) => !check.present).map((check) => check.name);
  if (missing.length) throw new Error(`Configuration remains incomplete: ${missing.join(", ")}`);

  let context = await ui.withSpinner("Authenticating and reading Genesys Cloud", connectGenesysAudio);
  ui.printCheck("Genesys organization", "ok", `${context.organization.name} / ${context.environment}`);
  ui.printCheck("Audio Connector entitlement", "ok", "integration type available");
  ui.printCheck("Audio Connector instances", "ok", `${context.integrations.length} installed`);
  ui.printCheck(
    "Audio Connector capacity",
    context.integrations.length < GENESYS_AUDIO_CONNECTOR_LIMIT ? "ok" : "missing",
    `${context.integrations.length}/${GENESYS_AUDIO_CONNECTOR_LIMIT}`
  );
  ui.printCheck("Genesys queues", context.queues.length ? "ok" : "missing", `${context.queues.length} available`);
  ui.printCheck("Genesys groups", context.groups.length ? "ok" : "missing", `${context.groups.length} available`);
  while (true) {
    const deployments = await listManagedAudioDeployments();
    console.log(ui.color.accent("\nAudio Connector deployment inventory"));
    ui.printCheck(
      "Managed deployments",
      deployments.length ? "ok" : "warning",
      `${deployments.length} configured locally`
    );
    ui.printCheck(
      "Audio Connector capacity",
      context.integrations.length < GENESYS_AUDIO_CONNECTOR_LIMIT ? "ok" : "warning",
      `${context.integrations.length}/${GENESYS_AUDIO_CONNECTOR_LIMIT}`
    );
    const action = await ui.selectMenu("Main menu", [
      ...(deployments.length
        ? [{
            label: "Manage an Audio Connector deployment",
            value: "manage",
            description: "Review, modify, synchronize or destroy a manifest-owned deployment.",
          }]
        : []),
      {
        label: "Create a new Audio Connector deployment",
        value: "create",
        disabled: `single managed deployment ${PRIMARY_AUDIO_DEPLOYMENT_ID} only`,
        description: "Configure DNIS-to-assistant assignments in the web administration application.",
      },
      {
        label: "Manage Cloudflare Quick Tunnel",
        value: "tunnel",
        description: "View health, activate or deactivate the tunnel, use a stable origin and synchronize URLs.",
      },
      { label: "Refresh Genesys and deployment inventory", value: "refresh" },
      { label: "Quit", value: "quit" },
    ]);
    if (action === "quit") return;
    if (action === "refresh") {
      context = await ui.withSpinner("Refreshing Genesys Cloud inventory", connectGenesysAudio);
      continue;
    }
    if (action === "tunnel") {
      await tunnelMenu(ui);
      continue;
    }
    if (action === "manage") {
      const selectedId = await ui.selectMenu(
        "Select a managed Audio Connector deployment",
        [
          ...deployments.map((deployment) => ({
            label: `${deployment.deployment.name} — ${deployment.environment}`,
            value: deployment.deployment.id,
            description: `Updated ${deployment.updatedAt || "unknown"}`,
          })),
          ui.backOption("Main menu"),
        ],
        { pageSize: 15 }
      );
      if (selectedId === "back") continue;
      const selected = deployments.find(({ deployment }) => deployment.id === selectedId);
      await deploymentMenu(ui, selected, context);
      context = await ui.withSpinner("Refreshing Genesys Cloud inventory", connectGenesysAudio);
    }
  }
}
