import platformClient from "purecloud-platform-client-v2";

import { GENESYS_TTS_CONNECTOR_TYPE } from "./tts-connector-profiles.mjs";

const TRANSIENT_READ_STATUSES = new Set([429, 502, 503, 504]);
export const DEFAULT_DELETE_UNUSED_TTS_CREDENTIALS = false;

export const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

function statusOf(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function retryAfterMs(error, fallbackMs) {
  const value =
    error?.response?.headers?.["retry-after"] ||
    error?.response?.headers?.["Retry-After"];
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}

export async function readWithRetry(operation, { attempts = 4, sleepImpl = sleep } = {}) {
  let delayMs = 500;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_READ_STATUSES.has(statusOf(error))) throw error;
      await sleepImpl(retryAfterMs(error, delayMs) + Math.floor(Math.random() * 200));
      delayMs = Math.min(delayMs * 2, 4000);
    }
  }
}

export function hardenGenesysSdkClient(apiClient) {
  const config = apiClient?.config;
  const logger = config?.logger;
  if (
    !config ||
    typeof config.setGateway !== "function" ||
    typeof config.setConfigPath !== "function" ||
    !logger ||
    typeof logger.setLogger !== "function" ||
    !logger.logLevelEnum?.level?.LNone
  ) {
    throw new Error("Cannot safely disable inherited Genesys SDK gateway and logging settings");
  }

  try {
    config.live_reload_config = false;
    config.setConfigPath("");
    config.setGateway();

    const previousLogger = logger.logger;
    logger.log_level = logger.logLevelEnum.level.LNone;
    logger.log_request_body = false;
    logger.log_response_body = false;
    logger.log_to_console = false;
    logger.log_file_path = undefined;
    logger.setLogger();
    if (previousLogger !== logger.logger && typeof previousLogger?.close === "function") {
      previousLogger.close();
    }
  } catch (error) {
    throw new Error("Failed to neutralize inherited Genesys SDK gateway or logging", {
      cause: error,
    });
  }

  const transports = logger.logger?.transports;
  if (
    config.live_reload_config !== false ||
    config.configPath !== "" ||
    config.gateway !== undefined ||
    logger.log_level !== logger.logLevelEnum.level.LNone ||
    logger.log_request_body !== false ||
    logger.log_response_body !== false ||
    logger.log_to_console !== false ||
    logger.log_file_path !== undefined ||
    !Array.isArray(transports) ||
    transports.length !== 0
  ) {
    throw new Error("Genesys SDK logging or gateway hardening did not take effect");
  }
  return apiClient;
}

export function normalizeGenesysEnvironment(environment, sdk = platformClient) {
  const raw = String(environment || "").trim();
  if (!raw) throw new Error("GC_ENVIRONMENT is required");
  if (/^http:\/\//i.test(raw)) {
    throw new Error("GC_ENVIRONMENT must use HTTPS or contain only the Genesys region host");
  }

  let host;
  if (/^https:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("GC_ENVIRONMENT is not a valid Genesys region host");
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("GC_ENVIRONMENT must not contain credentials, a port, path, query, or fragment");
    }
    host = parsed.hostname.toLowerCase();
  } else {
    if (/[\/:@?#]/.test(raw)) {
      throw new Error("GC_ENVIRONMENT must contain only the Genesys region host");
    }
    host = raw.toLowerCase().replace(/\.+$/, "");
  }

  if (host.startsWith("api.")) host = host.slice(4);
  const allowed = new Set(Object.values(sdk.PureCloudRegionHosts || {}).map(String));
  if (!allowed.has(host)) {
    throw new Error(
      `GC_ENVIRONMENT ${host || "(empty)"} is not an official Genesys Cloud region host`
    );
  }
  return host;
}

export async function connectGenesys({ environment, clientId, clientSecret, sdk = platformClient }) {
  // Validate before the OAuth secret can reach any SDK-derived login endpoint.
  const normalizedEnvironment = normalizeGenesysEnvironment(environment, sdk);
  const apiClient = sdk.ApiClient.instance;
  hardenGenesysSdkClient(apiClient);
  apiClient.setEnvironment(normalizedEnvironment);
  apiClient.timeout = 30_000;
  const authData = await apiClient.loginClientCredentialsGrant(clientId, clientSecret);
  const accessToken = authData?.accessToken || apiClient.authData?.accessToken;
  if (!accessToken) throw new Error("Genesys access token was not returned");
  const integrationsApi = new sdk.IntegrationsApi();
  const organizationApi = new sdk.OrganizationApi();
  const architectApi = new sdk.ArchitectApi();
  const [organization, integrationType] = await Promise.all([
    readWithRetry(() => organizationApi.getOrganizationsMe()),
    readWithRetry(() => integrationsApi.getIntegrationsType(GENESYS_TTS_CONNECTOR_TYPE))
      .catch((error) => {
        if (![403, 404].includes(statusOf(error))) throw error;
        throw new Error(
          "Genesys TTS Connector is not enabled for this organization. " +
            "An administrator must enable it and accept any required terms in Genesys AppFoundry first.",
          { cause: error }
        );
      }),
  ]);
  if (integrationType.id !== GENESYS_TTS_CONNECTOR_TYPE) {
    throw new Error(`Genesys returned unexpected integration type ${integrationType.id}`);
  }
  const acceptedCredentialTypes =
    integrationType.credentials?.basicAuth?.credentialTypes || [];
  if (acceptedCredentialTypes.length && !acceptedCredentialTypes.includes("userDefined")) {
    throw new Error("Genesys TTS Connector does not accept a userDefined credential in basicAuth");
  }
  const installed = await listAllTtsIntegrations(integrationsApi);
  return {
    apiClient,
    accessToken,
    integrationsApi,
    organizationApi,
    architectApi,
    organization,
    integrationType,
    installedTtsIntegrations: installed,
  };
}

export async function listAllTtsIntegrations(integrationsApi) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await readWithRetry(() =>
      integrationsApi.getIntegrations({
        pageNumber,
        pageSize: 100,
        integrationType: GENESYS_TTS_CONNECTOR_TYPE,
      })
    );
    entities.push(...(page.entities || []));
    if (
      !page.nextUri ||
      pageNumber >= Number(page.pageCount || 1) ||
      !(page.entities || []).length
    ) {
      return entities;
    }
  }
  throw new Error("Genesys integration pagination exceeded 100 pages");
}

export async function listAllGenesysIntegrations(integrationsApi) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await readWithRetry(() =>
      integrationsApi.getIntegrations({ pageNumber, pageSize: 100 })
    );
    entities.push(...(page.entities || []));
    if (
      !page.nextUri ||
      pageNumber >= Number(page.pageCount || 1) ||
      !(page.entities || []).length
    ) {
      return entities;
    }
  }
  throw new Error("Genesys integration pagination exceeded 100 pages");
}

function objectContainsExactValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((item) => objectContainsExactValue(item, expected));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => objectContainsExactValue(item, expected));
  }
  return false;
}

export async function findGenesysCredentialReferences(
  integrationsApi,
  credentialIds,
  { excludeIntegrationIds = [] } = {}
) {
  const ids = [...new Set((Array.isArray(credentialIds) ? credentialIds : [credentialIds])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
  if (!ids.length) throw new Error("At least one credential ID is required");
  const excluded = new Set(excludeIntegrationIds.map((id) => String(id || "").trim()));
  const references = Object.fromEntries(ids.map((id) => [id, []]));
  const integrations = await listAllGenesysIntegrations(integrationsApi);
  for (const integration of integrations) {
    if (excluded.has(integration.id)) continue;
    let config = null;
    try {
      config = await readWithRetry(() =>
        integrationsApi.getIntegrationConfigCurrent(integration.id)
      );
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    for (const credentialId of ids) {
      if (
        objectContainsExactValue(integration, credentialId) ||
        objectContainsExactValue(config, credentialId)
      ) {
        references[credentialId].push({
          id: integration.id,
          name: integration.name,
          integrationType:
            integration.integrationType?.id || integration.integrationType?.name || null,
        });
      }
    }
  }
  return references;
}

export async function findTtsIntegrationsByName(
  integrationsApi,
  name,
  { attempts = 6, sleepImpl = sleep } = {}
) {
  let matches = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    matches = (await listAllTtsIntegrations(integrationsApi)).filter(
      (integration) => integration.name === name
    );
    if (matches.length || attempt === attempts) return matches;
    await sleepImpl(Math.min(250 * 2 ** (attempt - 1), 4000));
  }
  return matches;
}

export async function loadTtsInventory(integrationsApi) {
  const integrations = await listAllTtsIntegrations(integrationsApi);
  const inventory = [];
  for (const integration of integrations) {
    const config = await readWithRetry(() =>
      integrationsApi.getIntegrationConfigCurrent(integration.id)
    );
    inventory.push({ integration, config });
  }
  return inventory;
}

export async function loadTtsInventoryEntry(integrationsApi, integrationId) {
  const [integration, config] = await Promise.all([
    readWithRetry(() => integrationsApi.getIntegration(integrationId)),
    readWithRetry(() => integrationsApi.getIntegrationConfigCurrent(integrationId)),
  ]);
  return { integration, config };
}

export async function deleteTtsIntegrationSafely(
  integrationsApi,
  integrationId,
  {
    attempts = 8,
    sleepImpl = sleep,
  } = {}
) {
  if (!String(integrationId || "").trim()) throw new Error("Integration ID is required for delete");
  let ambiguous = false;
  try {
    await integrationsApi.deleteIntegration(integrationId);
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) return { integrationId, deleted: true, alreadyAbsent: true };
    if (!ambiguousMutationError(error)) throw error;
    ambiguous = true;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await integrationsApi.getIntegration(integrationId);
    } catch (error) {
      if (statusOf(error) === 404) {
        return {
          integrationId,
          deleted: true,
          reconciledAfterAmbiguousDelete: ambiguous,
        };
      }
      if (!TRANSIENT_READ_STATUSES.has(statusOf(error))) throw error;
    }
    if (attempt < attempts) {
      await sleepImpl(Math.min(300 * 2 ** (attempt - 1), 4000));
    }
  }
  throw new Error(
    `Genesys still returns integration ${integrationId} after delete; inspect the organization before retrying`
  );
}

export async function validateGenesysCredential(integrationsApi, credentialId) {
  const credential = await readWithRetry(() =>
    integrationsApi.getIntegrationsCredential(credentialId)
  );
  if (credential.type?.name !== "userDefined") {
    throw new Error(
      `Credential ${credentialId} has type ${credential.type?.name || "unknown"}; expected userDefined`
    );
  }
  return credential;
}

export async function deleteGenesysCredentialSafely(
  integrationsApi,
  credentialId,
  {
    attempts = 8,
    sleepImpl = sleep,
  } = {}
) {
  if (!String(credentialId || "").trim()) throw new Error("Credential ID is required for delete");
  let ambiguous = false;
  try {
    await integrationsApi.deleteIntegrationsCredential(credentialId);
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) return { credentialId, deleted: true, alreadyAbsent: true };
    if (!ambiguousMutationError(error)) throw error;
    ambiguous = true;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await integrationsApi.getIntegrationsCredential(credentialId);
    } catch (error) {
      if (statusOf(error) === 404) {
        return {
          credentialId,
          deleted: true,
          reconciledAfterAmbiguousDelete: ambiguous,
        };
      }
      if (!TRANSIENT_READ_STATUSES.has(statusOf(error))) throw error;
    }
    if (attempt < attempts) {
      await sleepImpl(Math.min(300 * 2 ** (attempt - 1), 4000));
    }
  }
  throw new Error(
    `Genesys still returns credential ${credentialId} after delete; inspect the organization before retrying`
  );
}

export async function listAllGenesysCredentials(integrationsApi) {
  const entities = [];
  let after;
  for (let page = 0; page < 100; page += 1) {
    const listing = await readWithRetry(() =>
      integrationsApi.getIntegrationsCredentialsListing({
        pageSize: "200",
        ...(after ? { after } : {}),
      })
    );
    entities.push(...(listing.entities || []));
    const nextAfter = listing.nextUri
      ? new URL(listing.nextUri, "https://placeholder.invalid").searchParams.get("after")
      : null;
    if (!nextAfter || nextAfter === after) return entities;
    after = nextAfter;
  }
  throw new Error("Genesys credential pagination exceeded 100 pages");
}

function ambiguousMutationError(error) {
  const status = statusOf(error);
  return !status || status >= 500;
}

function markCreateOutcome(error, mayHaveSucceeded) {
  if (error && typeof error === "object") {
    error.createMayHaveSucceeded = mayHaveSucceeded;
  }
  return error;
}

export async function createTtsIntegrationSafely(integrationsApi, profile, creationName) {
  try {
    const created = await integrationsApi.postIntegrations({
      body: {
        name: creationName,
        integrationType: { id: GENESYS_TTS_CONNECTOR_TYPE },
      },
    });
    if (created?.id) return created;
  } catch (error) {
    if ([403, 404].includes(statusOf(error))) {
      throw markCreateOutcome(
        new Error(
          "Genesys refused to create the TTS Connector instance. " +
            "Enable Genesys TTS Connector and accept any required terms in AppFoundry, then retry.",
          { cause: error }
        ),
        false
      );
    }
    if (!ambiguousMutationError(error)) throw markCreateOutcome(error, false);
    let matches;
    try {
      matches = (await listAllTtsIntegrations(integrationsApi)).filter(
        (integration) => integration.name === creationName
      );
    } catch (reconciliationError) {
      throw markCreateOutcome(reconciliationError, true);
    }
    if (matches.length === 1) {
      return { ...matches[0], reconciledAfterAmbiguousCreate: true };
    }
    throw markCreateOutcome(error, true);
  }
  let matches;
  try {
    matches = (await listAllTtsIntegrations(integrationsApi)).filter(
      (integration) => integration.name === creationName
    );
  } catch (reconciliationError) {
    throw markCreateOutcome(reconciliationError, true);
  }
  if (matches.length === 1) return { ...matches[0], reconciledAfterAmbiguousCreate: true };
  throw markCreateOutcome(
    new Error(`Genesys did not return an ID for new profile ${profile.id}`),
    true
  );
}

export async function createTelnyxCredential(integrationsApi, { name, apiKey }) {
  if (!String(apiKey || "").trim()) throw new Error("TELNYX_API_KEY is required");
  const before = (await listAllGenesysCredentials(integrationsApi)).filter(
    (credential) => credential.name === name
  );
  if (before.length) {
    throw new Error(`Credential name ${name} already exists; generate a fresh plan`);
  }
  try {
    const created = await integrationsApi.postIntegrationsCredentials({
      body: {
        name,
        type: { name: "userDefined" },
        credentialFields: {
          Authorization: `Bearer ${apiKey}`,
          "Accept-Encoding": "identity",
        },
      },
    });
    if (created?.id) {
      if (created.type?.name && created.type.name !== "userDefined") {
        throw new Error(`Created credential ${created.id} has unexpected type ${created.type.name}`);
      }
      return created.type?.name
        ? created
        : validateGenesysCredential(integrationsApi, created.id);
    }
    const matches = (await listAllGenesysCredentials(integrationsApi)).filter(
      (credential) => credential.name === name && credential.type?.name === "userDefined"
    );
    if (matches.length === 1) return { ...matches[0], reconciledAfterAmbiguousCreate: true };
    throw new Error(`Genesys did not return an ID for new credential ${name}`);
  } catch (error) {
    if (!ambiguousMutationError(error)) throw error;
    const matches = (await listAllGenesysCredentials(integrationsApi)).filter(
      (credential) => credential.name === name && credential.type?.name === "userDefined"
    );
    if (matches.length === 1) return { ...matches[0], reconciledAfterAmbiguousCreate: true };
    throw error;
  }
}

function stateCode(integration) {
  return String(integration?.reportedState?.code || "").toUpperCase();
}

function stateEffective(integration) {
  return String(integration?.reportedState?.effective || "").toUpperCase();
}

function stateError(integration) {
  const code = stateCode(integration);
  const effective = stateEffective(integration);
  return code === "ERROR" || code.endsWith("_ERROR") || effective === "ERROR";
}

export async function pollIntegrationState(
  integrationsApi,
  integrationId,
  desiredCode,
  {
    timeoutMs = 180_000,
    sleepImpl = sleep,
    now = Date.now,
  } = {}
) {
  const desired = String(desiredCode).toUpperCase();
  const deadline = now() + timeoutMs;
  let delayMs = 1000;

  while (now() < deadline) {
    const integration = await readWithRetry(
      () => integrationsApi.getIntegration(integrationId),
      { sleepImpl }
    );
    const code = stateCode(integration);
    if (code === desired) return integration;
    if (stateError(integration)) {
      throw new Error(
        integration.reportedState?.detail?.message ||
          `Integration ${integrationId} entered ${code || "ERROR"}`
      );
    }
    await sleepImpl(delayMs);
    delayMs = Math.min(Math.round(delayMs * 1.5), 5000);
  }
  throw new Error(`Integration ${integrationId} did not reach ${desired} within ${timeoutMs} ms`);
}

export async function setIntegrationState(integrationsApi, integrationId, intendedState) {
  const intended = String(intendedState).toUpperCase();
  if (!new Set(["ENABLED", "DISABLED"]).has(intended)) {
    throw new Error(`Unsupported intended state ${intendedState}`);
  }
  await integrationsApi.patchIntegration(integrationId, {
    body: { intendedState: intended },
  });
  return pollIntegrationState(
    integrationsApi,
    integrationId,
    intended === "ENABLED" ? "ACTIVE" : "INACTIVE"
  );
}

export async function verifyGenesysTtsEngine(integrationsApi, integrationId) {
  const engineId = `connector-${integrationId}`;
  const engine = await readWithRetry(() =>
    integrationsApi.getIntegrationsSpeechTtsEngine(engineId, { includeVoices: true })
  );
  const voices = Array.isArray(engine.voices) ? engine.voices : [];
  return {
    engineId,
    engineName: engine.name,
    voiceCount: voices.length,
    voiceCatalogAvailable: voices.length > 0,
  };
}
