import "dotenv/config";

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  GENESYS_TTS_CONNECTOR_TYPE,
  getTtsConnectorProfile,
  listTtsConnectorProfiles,
  selectTtsConnectorProfiles,
  verifiedTtsConnectorProfiles,
} from "../lib/genesys/tts-connector-profiles.mjs";
import {
  TTS_MANAGER_VERSION,
  assertApplicablePlan,
  buildDesiredConfig,
  buildTtsPlan,
  canonicalJson,
  classifyAppliedRollbackCandidate,
  classifyInterruptedCreateLookup,
  configMatchesProfile,
  connectorDefinitionMatchesProfile,
  integrationIsInactive,
  inventorySnapshotHash,
  isTelnyxTtsInventoryEntry,
  managedCredentialCreationName,
  managedIntegrationCreationName,
  managedNotes,
  markerForInventoryEntry,
  parseAdoptions,
  planApplyIntent,
  profilePayloadMatches,
  profileOwnershipConflicts,
  redactSecrets,
  restorableSnapshotHash,
  safeError,
  snapshotInventoryEntry,
} from "../lib/genesys/tts-connector-manager.mjs";
import {
  DEFAULT_DELETE_UNUSED_TTS_CREDENTIALS,
  connectGenesys,
  createTtsIntegrationSafely,
  createTelnyxCredential,
  deleteGenesysCredentialSafely,
  deleteTtsIntegrationSafely,
  findGenesysCredentialReferences,
  findTtsIntegrationsByName,
  listAllGenesysCredentials,
  listAllTtsIntegrations,
  loadTtsInventory,
  loadTtsInventoryEntry,
  normalizeGenesysEnvironment,
  pollIntegrationState,
  setIntegrationState,
  validateGenesysCredential,
  verifyGenesysTtsEngine,
} from "../lib/genesys/tts-connector-genesys.mjs";
import {
  DEFAULT_DELETE_ASSOCIATED_TEST_FLOWS,
  deleteManagedGenesysTtsTestFlow,
  findManagedGenesysTtsTestFlows,
  genesysTtsTestFlowIsManaged,
  prepareGenesysTtsArchitectTargets,
  publishGenesysTtsTestFlows,
} from "../lib/genesys/tts-connector-architect.mjs";
import {
  loadTtsProviderCatalog,
  providerCountLabel,
} from "../lib/genesys/tts-provider-catalog.mjs";
import { saveInstallerEnvironmentValues } from "../lib/genesys/installer-environment.mjs";
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

const EXIT_VALIDATION = 2;
const EXIT_APPLY_FAILURE = 3;
const EXIT_ROLLBACK_INCOMPLETE = 4;
const DEFAULT_STATE_DIRECTORY = ".genesys-tts";
export const TTS_INSTALLER_VARIABLES = Object.freeze([
  "GC_ENVIRONMENT",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "TELNYX_API_KEY",
]);
const TTS_MASKED_CONFIGURATION_VARIABLES = new Set([
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "TELNYX_API_KEY",
]);
const TTS_CONFIGURATION_PROMPTS = Object.freeze({
  GC_ENVIRONMENT: "Genesys Cloud region domain (GC_ENVIRONMENT)",
  GC_CLIENT_CRED_CLIENT_ID:
    "Genesys Client Credentials client ID (GC_CLIENT_CRED_CLIENT_ID)",
  GC_CLIENT_CRED_CLIENT_SECRET:
    "Genesys Client Credentials client secret (GC_CLIENT_CRED_CLIENT_SECRET)",
  TELNYX_API_KEY: "Telnyx API key (TELNYX_API_KEY)",
});

let activeLockPath;

function releaseLockSync() {
  if (!activeLockPath) return;
  try {
    if (existsSync(activeLockPath)) unlinkSync(activeLockPath);
  } catch {
    // A stale lock is safer than deleting an unrelated file.
  }
  activeLockPath = undefined;
}

process.once("exit", releaseLockSync);
process.once("SIGINT", () => {
  releaseLockSync();
  process.stderr.write("Interrupted. Inspect the run journal and execute status before continuing.\n");
  process.exit(130);
});

function option(options, ...names) {
  for (const name of names) {
    if (options[name] !== undefined) return options[name];
  }
  return undefined;
}

function enabled(options, ...names) {
  const value = option(options, ...names);
  if (value === undefined || value === false) return false;
  return !["0", "false", "no"].includes(String(value).toLowerCase());
}

function bareFlag(options, name, { required = false } = {}) {
  const value = option(options, name);
  if (value === undefined) {
    if (required) throw new Error(`--${name} must be provided as a bare flag`);
    return false;
  }
  if (value !== true) {
    throw new Error(`--${name} accepts no value; provide the bare --${name} flag`);
  }
  return true;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function genesysEnvironment() {
  return normalizeGenesysEnvironment(requiredEnvironment("GC_ENVIRONMENT"));
}

function stateDirectory(options) {
  return path.resolve(String(option(options, "state-dir") || DEFAULT_STATE_DIRECTORY));
}

async function ensurePrivateDirectory(directory, { harden = false } = {}) {
  const createdPath = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!harden) return;
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`State path ${directory} must be a real directory, not a symlink`);
  }
  if (createdPath !== undefined) {
    await chmod(directory, 0o700);
  } else if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      `Existing state directory ${directory} is too permissive; set its mode to 0700 manually`
    );
  }
}

async function writeJsonAtomic(filePath, value) {
  const safeValue = redactSecrets(value);
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(safeValue, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
  return filePath;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON file ${filePath}: ${error.message}`);
  }
}

async function acquireMutationLock(directory, command) {
  await ensurePrivateDirectory(directory, { harden: true });
  const lockPath = path.join(directory, "mutation.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const detail = await readFile(lockPath, "utf8").catch(() => "");
      throw new Error(`Another mutation is locked by ${detail.trim() || lockPath}`);
    }
    throw error;
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }),
    "utf8"
  );
  await handle.close();
  activeLockPath = lockPath;
  return async () => {
    if (activeLockPath !== lockPath) return;
    await unlink(lockPath).catch(() => {});
    activeLockPath = undefined;
  };
}

async function genesysContext() {
  return connectGenesys({
    environment: genesysEnvironment(),
    clientId: requiredEnvironment("GC_CLIENT_CRED_CLIENT_ID"),
    clientSecret: requiredEnvironment("GC_CLIENT_CRED_CLIENT_SECRET"),
  });
}

function profileIdsFromOptions(options) {
  return option(options, "profiles", "providers");
}

function planSummary(plan) {
  const lines = [
    `Plan: ${plan.planId}`,
    `Organization: ${plan.organization.name} (${plan.organization.id})`,
    `Region: ${plan.environment}`,
    `TTS Connector instances: ${plan.inventory.total}/${plan.integrationType.maxInstances}`,
    `Credential: ${plan.credential.mode}${plan.credential.id ? ` (${plan.credential.id})` : " (new managed credential)"}`,
    "",
  ];
  for (const operation of plan.operations) {
    lines.push(
      `${operation.action.padEnd(8)} ${operation.profileId}` +
        `${operation.integrationId ? ` -> ${operation.integrationId}` : ""}` +
        `${operation.requiresDowntime ? " [brief TTS interruption]" : ""}`
    );
    for (const reason of operation.reasons || []) lines.push(`           ${reason}`);
  }
  if (plan.blockers.length) {
    lines.push("", "Blockers:", ...plan.blockers.map((blocker) => `- ${blocker}`));
  }
  return lines.join("\n");
}

function printProfiles({ json = false } = {}) {
  const profiles = listTtsConnectorProfiles().map((profile) => ({
    id: profile.id,
    aliases: profile.aliases || [],
    status: profile.status,
    provider: profile.provider || profile.displayName,
    audio:
      profile.status === "verified"
        ? `${profile.responseContract.container} ${profile.responseContract.codec} ${profile.responseContract.sampleRate} Hz`
        : undefined,
    reason: profile.reason,
  }));
  if (json) {
    console.log(JSON.stringify(profiles, null, 2));
    return;
  }
  for (const profile of profiles) {
    console.log(
      `${profile.status.toUpperCase().padEnd(8)} ${profile.id.padEnd(18)} ${profile.provider}` +
        `${profile.audio ? ` — ${profile.audio}` : ` — ${profile.reason}`}`
    );
  }
}

async function commandPlan(options, { interactive = false, quiet = false } = {}) {
  const profiles = selectTtsConnectorProfiles(profileIdsFromOptions(options));
  const adoptions = parseAdoptions(option(options, "adopt"));
  for (const profileId of Object.keys(adoptions)) {
    if (!profiles.some((profile) => profile.id === profileId)) {
      throw new Error(`--adopt references unselected profile ${profileId}`);
    }
  }

  const requestedCredentialId = String(option(options, "credential-id") || "").trim();
  const shouldCreateCredential = enabled(options, "create-credential");
  if (requestedCredentialId && shouldCreateCredential) {
    throw new Error("Use either --credential-id or --create-credential, not both");
  }
  if (!requestedCredentialId && !shouldCreateCredential) {
    throw new Error("Provide --credential-id=<id> or --create-credential");
  }
  if (shouldCreateCredential) requiredEnvironment("TELNYX_API_KEY");

  const context = await genesysContext();
  const inventory = await loadTtsInventory(context.integrationsApi);
  const planId = randomUUID();
  let credential;
  if (requestedCredentialId) {
    const existing = await validateGenesysCredential(context.integrationsApi, requestedCredentialId);
    credential = {
      mode: "existing",
      id: existing.id,
      name: existing.name,
      type: existing.type?.name,
      credentialValueReadable: false,
    };
  } else {
    credential = {
      mode: "create",
      id: null,
      name:
        String(option(options, "credential-name") || "").trim() ||
        `Telnyx TTS managed ${planId}`,
      type: "userDefined",
    };
  }

  const plan = buildTtsPlan({
    environment: genesysEnvironment(),
    organization: context.organization,
    integrationType: context.integrationType,
    inventory,
    profiles,
    credential,
    adoptions,
    planId,
  });

  const defaultPath = path.join(stateDirectory(options), "plans", `${plan.planId}.json`);
  const outputPath = path.resolve(String(option(options, "out", "output") || defaultPath));
  await writeJsonAtomic(outputPath, plan);
  if (!quiet) {
    console.log(planSummary(plan));
    console.log(`\nPlan file: ${outputPath}`);
  }
  if (plan.blockers.length && !interactive) process.exitCode = EXIT_VALIDATION;
  return { plan, outputPath };
}

export function classifyTtsInventoryEntry(entry) {
  const marker = markerForInventoryEntry(entry);
  const staticMatches = verifiedTtsConnectorProfiles().filter((profile) =>
    profilePayloadMatches(entry.config, profile)
  );
  const profile = marker?.profileId ? getTtsConnectorProfile(marker.profileId) : staticMatches[0];
  const credentialId = entry.config?.credentials?.basicAuth?.id || null;
  const configHealthy =
    Boolean(marker && !marker.invalid && profile?.status === "verified") &&
    configMatchesProfile(entry, profile, credentialId);
  const active = String(entry.integration.reportedState?.code || "").toUpperCase() === "ACTIVE";
  return {
    integrationId: entry.integration.id,
    name: entry.integration.name,
    managed: Boolean(marker && !marker.invalid),
    markerInvalid: Boolean(marker?.invalid),
    profileId: profile?.id || null,
    unmanagedProfileMatches: marker ? [] : staticMatches.map((candidate) => candidate.id),
    intendedState: entry.integration.intendedState,
    reportedState: entry.integration.reportedState?.code,
    configVersion: entry.config.version,
    credentialId,
    credentialValueReadable: false,
    configHealthy,
    healthy: configHealthy && active,
    telnyx: isTelnyxTtsInventoryEntry(entry),
    observedSnapshotHash: inventorySnapshotHash(entry),
  };
}

const classifyInventoryEntry = classifyTtsInventoryEntry;

async function commandStatus(options, { quiet = false } = {}) {
  const context = await genesysContext();
  const inventory = await loadTtsInventory(context.integrationsApi);
  const entries = inventory.map(classifyInventoryEntry);
  if (enabled(options, "check-voices")) {
    for (const status of entries) {
      const profile = getTtsConnectorProfile(status.profileId);
      if (!profile || profile.status !== "verified" || status.reportedState !== "ACTIVE") continue;
      try {
        status.engine = await verifyGenesysTtsEngine(
          context.integrationsApi,
          status.integrationId
        );
      } catch (error) {
        status.engine = { error: safeError(error) };
      }
    }
  }
  const status = {
    checkedAt: new Date().toISOString(),
    environment: genesysEnvironment(),
    organization: { id: context.organization.id, name: context.organization.name },
    usage: {
      current: inventory.length,
      maximum: Number(context.integrationType.maxInstances || 10),
    },
    integrations: entries,
  };
  if (!quiet) {
    console.log(
      JSON.stringify(
        status,
        null,
        2
      )
    );
  }
  return { status, context, inventory };
}

async function ensureInactive(integrationsApi, integrationId) {
  const integration = await integrationsApi.getIntegration(integrationId);
  const code = String(integration.reportedState?.code || "").toUpperCase();
  const intended = String(integration.intendedState || "").toUpperCase();
  if (code === "INACTIVE" && intended === "DISABLED") return integration;
  // A connector can remain in ERROR after a failed activation even though it is
  // already administratively disabled. Genesys allows its configuration to be
  // repaired in that state; waiting for INACTIVE would only replay the stale
  // validation error and prevent the repair from being written.
  if (code === "ERROR" && intended === "DISABLED") return integration;
  return setIntegrationState(integrationsApi, integrationId, "DISABLED");
}

async function patchMetadataAndEnable(integrationsApi, integrationId, profile, credentialId) {
  return integrationsApi.patchIntegration(integrationId, {
    body: {
      name: profile.integrationName,
      notes: managedNotes(profile, credentialId),
      intendedState: "ENABLED",
    },
  });
}

async function assertExclusiveProfileOwnership(integrationsApi, integrationId, profile, stage) {
  const inventory = await loadTtsInventory(integrationsApi);
  const conflicts = profileOwnershipConflicts(inventory, profile, integrationId);
  if (conflicts.length) {
    throw new Error(
      `Profile ownership conflict ${stage} for ${profile.id}: ` +
        conflicts.map((entry) => entry.integration.id).join(", ")
    );
  }
}

async function restoreSnapshot(integrationsApi, snapshot) {
  const integrationId = snapshot.integration.id;
  await ensureInactive(integrationsApi, integrationId);
  const current = await integrationsApi.getIntegrationConfigCurrent(integrationId);
  await integrationsApi.putIntegrationConfigCurrent(integrationId, {
    body: {
      id: current.id || "current",
      name: snapshot.config.name,
      version: current.version,
      properties: snapshot.config.properties,
      advanced: snapshot.config.advanced,
      notes: snapshot.config.notes,
      credentials: snapshot.config.credentials,
    },
  });
  const intendedState = String(snapshot.integration.intendedState || "DISABLED").toUpperCase();
  await integrationsApi.patchIntegration(integrationId, {
    body: {
      name: snapshot.integration.name,
      notes: snapshot.integration.notes,
      intendedState,
    },
  });
  if (intendedState === "ENABLED") {
    await pollIntegrationState(integrationsApi, integrationId, "ACTIVE");
  } else {
    await ensureInactive(integrationsApi, integrationId);
  }
  const restored = await loadTtsInventoryEntry(integrationsApi, integrationId);
  if (restorableSnapshotHash(restored) !== restorableSnapshotHash(snapshot)) {
    throw new Error(`Genesys did not restore the expected snapshot for ${integrationId}`);
  }
  return restored;
}

async function preflightApply(plan, context) {
  assertApplicablePlan(plan, {
    environment: genesysEnvironment(),
    organizationId: context.organization.id,
  });
  const inventory = await loadTtsInventory(context.integrationsApi);
  if (inventory.length !== plan.inventory.total) {
    throw new Error(
      `TTS Connector count changed from ${plan.inventory.total} to ${inventory.length}; generate a fresh plan`
    );
  }
  const rebuilt = buildTtsPlan({
    environment: genesysEnvironment(),
    organization: context.organization,
    integrationType: context.integrationType,
    inventory,
    profiles: plan.operations.map((operation) => getTtsConnectorProfile(operation.profileId)),
    credential: plan.credential,
    adoptions: plan.adoptions,
    now: new Date(plan.observedAt),
    planId: plan.planId,
    maxPlanAgeMs: Date.parse(plan.expiresAt) - Date.parse(plan.observedAt),
  });
  if (canonicalJson(planApplyIntent(rebuilt)) !== canonicalJson(planApplyIntent(plan))) {
    throw new Error(
      "Plan intent no longer matches a fresh plan from current Genesys inventory; generate a fresh plan"
    );
  }
  const byId = new Map(inventory.map((entry) => [entry.integration.id, entry]));
  const creates = plan.operations.filter((operation) => operation.action === "CREATE").length;
  const maximum = Number(context.integrationType.maxInstances || 10);
  if (inventory.length + creates > maximum) {
    throw new Error(`Apply would exceed the Genesys limit of ${maximum} TTS Connector instances`);
  }
  for (const operation of plan.operations) {
    const profile = getTtsConnectorProfile(operation.profileId);
    if (operation.action === "CREATE") {
      const newConflict = inventory.find((entry) => {
        const marker = markerForInventoryEntry(entry);
        return marker?.profileId === profile.id || entry.integration.name === profile.integrationName;
      });
      if (newConflict) {
        throw new Error(`New conflict for ${profile.id}: integration ${newConflict.integration.id}`);
      }
      continue;
    }
    const current = byId.get(operation.integrationId);
    if (!current) throw new Error(`Integration ${operation.integrationId} disappeared after planning`);
    const currentHash = inventorySnapshotHash(current);
    if (currentHash !== operation.expectedSnapshotHash) {
      throw new Error(`Integration ${operation.integrationId} drifted after planning`);
    }
  }
  return { inventory, byId };
}

async function applyOperation({ context, operation, profile, credential, journal, journalPath }) {
  const result = {
    profileId: profile.id,
    action: operation.action,
    status: "started",
    integrationId: operation.integrationId,
    created: false,
    beforeSnapshot: null,
    startedAt: new Date().toISOString(),
  };
  if (operation.action === "CREATE") {
    result.creationName = managedIntegrationCreationName(profile.id, journal.runId);
  }
  journal.results.push(result);

  if (operation.action === "NOOP") {
    result.status = "no-op";
    result.completedAt = new Date().toISOString();
    await writeJsonAtomic(journalPath, journal);
    return result;
  }

  if (operation.action === "UPDATE") {
    const currentEntry = await loadTtsInventoryEntry(
      context.integrationsApi,
      operation.integrationId
    );
    if (inventorySnapshotHash(currentEntry) !== operation.expectedSnapshotHash) {
      throw new Error(`Integration ${operation.integrationId} drifted immediately before update`);
    }
    result.beforeSnapshot = snapshotInventoryEntry(currentEntry);
    result.phase = "snapshot-saved";
    await writeJsonAtomic(journalPath, journal);
    result.phase = "disabling";
    await writeJsonAtomic(journalPath, journal);
    await ensureInactive(context.integrationsApi, operation.integrationId);
    result.phase = "inactive";
    await writeJsonAtomic(journalPath, journal);
  } else if (operation.action === "CREATE") {
    result.created = true;
    result.phase = "creating";
    await writeJsonAtomic(journalPath, journal);
    let created;
    try {
      created = await createTtsIntegrationSafely(
        context.integrationsApi,
        profile,
        result.creationName
      );
    } catch (error) {
      result.createMayHaveSucceeded =
        error?.createMayHaveSucceeded !== false;
      result.phase = result.createMayHaveSucceeded
        ? "create-outcome-unknown"
        : "create-rejected";
      await writeJsonAtomic(journalPath, journal);
      throw error;
    }
    result.integrationId = created.id;
    result.reconciledAfterAmbiguousCreate = Boolean(created.reconciledAfterAmbiguousCreate);
    result.phase = "created";
    await writeJsonAtomic(journalPath, journal);
    result.phase = "disabling";
    await writeJsonAtomic(journalPath, journal);
    await ensureInactive(context.integrationsApi, created.id);
    const createdEntry = await loadTtsInventoryEntry(context.integrationsApi, created.id);
    result.beforeSnapshot = snapshotInventoryEntry(createdEntry);
    result.phase = "initial-snapshot-saved";
    await writeJsonAtomic(journalPath, journal);
  } else {
    throw new Error(`Unsupported apply action ${operation.action}`);
  }

  const currentConfig = await context.integrationsApi.getIntegrationConfigCurrent(result.integrationId);
  const desiredConfig = buildDesiredConfig({ profile, currentConfig, credential });
  await assertExclusiveProfileOwnership(
    context.integrationsApi,
    result.integrationId,
    profile,
    "before configuration"
  );
  result.phase = "putting-config";
  await writeJsonAtomic(journalPath, journal);
  await context.integrationsApi.putIntegrationConfigCurrent(result.integrationId, {
    body: desiredConfig,
  });
  result.phase = "config-updated";
  await writeJsonAtomic(journalPath, journal);
  result.phase = "enabling";
  await writeJsonAtomic(journalPath, journal);
  await patchMetadataAndEnable(
    context.integrationsApi,
    result.integrationId,
    profile,
    credential.id
  );
  await assertExclusiveProfileOwnership(
    context.integrationsApi,
    result.integrationId,
    profile,
    "after final rename"
  );
  await pollIntegrationState(context.integrationsApi, result.integrationId, "ACTIVE");
  await assertExclusiveProfileOwnership(
    context.integrationsApi,
    result.integrationId,
    profile,
    "after activation"
  );
  result.phase = "active";
  await writeJsonAtomic(journalPath, journal);
  const afterEntry = await loadTtsInventoryEntry(context.integrationsApi, result.integrationId);
  if (!configMatchesProfile(afterEntry, profile, credential.id)) {
    throw new Error(`Genesys did not persist the expected configuration for ${profile.id}`);
  }
  result.phase = "verifying-engine";
  await writeJsonAtomic(journalPath, journal);
  try {
    result.engine = await verifyGenesysTtsEngine(
      context.integrationsApi,
      result.integrationId
    );
    if (!result.engine.voiceCatalogAvailable) {
      result.warnings = [
        "The engine is active, but Genesys returned an empty voice catalog. Check voice cache before production use.",
      ];
    }
  } catch (error) {
    result.warnings = [
      `The connector is active, but engine metadata verification failed: ${safeError(error).message}`,
    ];
  }
  result.afterSnapshotHash = inventorySnapshotHash(afterEntry);
  result.phase = "completed";
  result.status = "applied";
  result.completedAt = new Date().toISOString();
  await writeJsonAtomic(journalPath, journal);
  return result;
}

async function rollbackCurrentFailedOperation(context, result) {
  if (result.created && !result.integrationId && result.createMayHaveSucceeded !== false) {
    throw new Error(
      `Create outcome for ${result.profileId} is ambiguous; use manual rollback with --recover-incomplete`
    );
  }
  if (!result.integrationId) return { status: "not-required" };
  if (result.created) {
    if (result.beforeSnapshot) {
      await restoreSnapshot(context.integrationsApi, result.beforeSnapshot);
      return {
        status: "restored-created-integration-to-initial-state",
        integrationId: result.integrationId,
        note: "The integration was not deleted and still consumes a Genesys slot.",
      };
    }
    await ensureInactive(context.integrationsApi, result.integrationId);
    return {
      status: "disabled-created-integration",
      integrationId: result.integrationId,
      note: "The integration was not deleted and still consumes a Genesys slot.",
    };
  }
  if (result.beforeSnapshot) {
    await restoreSnapshot(context.integrationsApi, result.beforeSnapshot);
    return { status: "restored-existing-integration", integrationId: result.integrationId };
  }
  return { status: "not-required" };
}

async function commandApply(
  options,
  { interactive = false, quiet = false, onProgress = () => {} } = {}
) {
  try {
    bareFlag(options, "apply", { required: true });
  } catch (error) {
    if (!interactive) process.exitCode = EXIT_VALIDATION;
    throw error;
  }
  const planValue = option(options, "plan");
  if (!planValue) throw new Error("--plan=<path> is required");
  const planPath = path.resolve(String(planValue));
  const plan = await readJson(planPath);
  const directory = stateDirectory(options);
  const releaseLock = await acquireMutationLock(directory, "apply");
  let journal;
  let journalPath;
  try {
    onProgress({ phase: "preflight", status: "active", label: "Validating plan and current Genesys state" });
    const context = await genesysContext();
    await preflightApply(plan, context);
    onProgress({ phase: "preflight", status: "success", label: "Plan and current Genesys state validated" });
    let credential;
    const runId = randomUUID();
    journalPath = path.join(directory, "runs", `${runId}.json`);
    journal = {
      schemaVersion: 1,
      toolVersion: TTS_MANAGER_VERSION,
      runId,
      planId: plan.planId,
      planPath,
      environment: genesysEnvironment(),
      organization: { id: context.organization.id, name: context.organization.name },
      startedAt: new Date().toISOString(),
      status: "applying",
      credential: null,
      results: [],
    };
    await writeJsonAtomic(journalPath, journal);

    if (plan.credential.mode === "existing") {
      onProgress({ phase: "credential", status: "active", label: "Validating Genesys credential" });
      credential = await validateGenesysCredential(
        context.integrationsApi,
        plan.credential.id
      );
      journal.credential = {
        mode: "existing",
        id: credential.id,
        name: credential.name,
        type: credential.type?.name,
      };
      onProgress({ phase: "credential", status: "success", label: "Genesys credential validated" });
    } else if (plan.credential.mode === "create") {
      const credentialCreationName = managedCredentialCreationName(runId);
      journal.credential = {
        mode: "creating",
        id: null,
        name: credentialCreationName,
        creationName: credentialCreationName,
        requestedName: plan.credential.name,
        type: "userDefined",
        retainedOnRollback: true,
      };
      await writeJsonAtomic(journalPath, journal);
      onProgress({ phase: "credential", status: "active", label: "Creating managed Telnyx credential" });
      credential = await createTelnyxCredential(context.integrationsApi, {
        name: credentialCreationName,
        apiKey: requiredEnvironment("TELNYX_API_KEY"),
      });
      journal.credential = {
        mode: "created",
        id: credential.id,
        name: credential.name,
        creationName: credentialCreationName,
        requestedName: plan.credential.name,
        type: credential.type?.name,
        retainedOnRollback: true,
      };
      onProgress({ phase: "credential", status: "success", label: "Managed Telnyx credential created" });
    } else {
      throw new Error(`Unsupported credential mode ${plan.credential.mode}`);
    }
    await writeJsonAtomic(journalPath, journal);

    for (const [index, operation] of plan.operations.entries()) {
      const profile = getTtsConnectorProfile(operation.profileId);
      onProgress({
        phase: "provider",
        status: "active",
        label: `${operation.action} ${profile.displayName}`,
        profileId: profile.id,
        index,
        total: plan.operations.length,
      });
      try {
        const applied = await applyOperation({
          context,
          operation,
          profile,
          credential,
          journal,
          journalPath,
        });
        onProgress({
          phase: "provider",
          status: "success",
          label: `${profile.displayName}: ${applied.status}`,
          profileId: profile.id,
          index,
          total: plan.operations.length,
        });
      } catch (error) {
        onProgress({
          phase: "provider",
          status: "failure",
          label: `${profile.displayName}: ${safeError(error).message}`,
          profileId: profile.id,
          index,
          total: plan.operations.length,
        });
        const result = journal.results.at(-1);
        if (result) {
          result.status = "failed";
          result.error = safeError(error);
        }
        journal.status = "failed";
        journal.error = safeError(error);
        await writeJsonAtomic(journalPath, journal);
        try {
          if (result) {
            result.automaticRollback = await rollbackCurrentFailedOperation(context, result);
            result.status = "failed-current-operation-rolled-back";
          }
          journal.status = "failed-current-operation-rolled-back";
        } catch (rollbackError) {
          if (result) result.automaticRollback = { status: "incomplete", error: safeError(rollbackError) };
          journal.status = "rollback-incomplete";
          if (!interactive) process.exitCode = EXIT_ROLLBACK_INCOMPLETE;
        }
        journal.finishedAt = new Date().toISOString();
        await writeJsonAtomic(journalPath, journal);
        throw error;
      }
    }

    journal.status = "completed";
    journal.finishedAt = new Date().toISOString();
    await writeJsonAtomic(journalPath, journal);
    const summary = {
      runId,
      status: journal.status,
      journalPath,
      credential: journal.credential,
      results: journal.results.map(({ beforeSnapshot, ...result }) => result),
    };
    if (!quiet) console.log(JSON.stringify(summary, null, 2));
    return summary;
  } catch (error) {
    if (journal && journal.status === "applying") {
      journal.status = "failed-before-connector-mutation";
      journal.error = safeError(error);
      journal.finishedAt = new Date().toISOString();
      if (journalPath) await writeJsonAtomic(journalPath, journal).catch(() => {});
    }
    if (!interactive && !process.exitCode) process.exitCode = EXIT_APPLY_FAILURE;
    if (journalPath && !quiet) process.stderr.write(`Run journal: ${journalPath}\n`);
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function createTtsInstallationPlan({
  profiles,
  credentialId,
  createCredential = false,
  credentialName,
  stateDirectory,
} = {}) {
  const options = {
    profiles: Array.isArray(profiles) ? profiles.join(",") : profiles,
    ...(credentialId ? { "credential-id": credentialId } : {}),
    ...(createCredential ? { "create-credential": true } : {}),
    ...(credentialName ? { "credential-name": credentialName } : {}),
    ...(stateDirectory ? { "state-dir": stateDirectory } : {}),
  };
  const result = await commandPlan(options, { quiet: true, interactive: true });
  if (result.plan.blockers?.length) {
    throw new Error(result.plan.blockers.map((blocker) => blocker.message || blocker).join("; "));
  }
  return result;
}

export function applyTtsInstallationPlan(
  planPath,
  { onProgress = () => {}, stateDirectory } = {}
) {
  return commandApply(
    {
      apply: true,
      plan: planPath,
      ...(stateDirectory ? { "state-dir": stateDirectory } : {}),
    },
    { quiet: true, interactive: true, onProgress }
  );
}

export async function publishTtsArchitectTestFlows(
  targets,
  { onProgress = () => {} } = {}
) {
  if (!Array.isArray(targets) || !targets.length) {
    return { flows: [], skipped: [] };
  }
  await hydrateRuntimeSecrets({ required: true });
  const context = await genesysContext();
  const providerCatalog = await loadTtsProviderCatalog(listTtsConnectorProfiles(), {
    apiKey: process.env.TELNYX_API_KEY,
  });
  const prepared = prepareGenesysTtsArchitectTargets(targets, providerCatalog);
  if (!prepared.targets.length) return { flows: [], skipped: prepared.skipped };
  const published = await publishGenesysTtsTestFlows({
    environment: genesysEnvironment(),
    accessToken: context.accessToken,
    architectApi: context.architectApi,
    targets: prepared.targets,
    onProgress,
  });
  return {
    flows: published.flows,
    skipped: [...prepared.skipped, ...published.skipped],
  };
}

export async function deleteTtsArchitectTestFlows(
  flows,
  { onProgress = () => {} } = {}
) {
  if (!Array.isArray(flows) || !flows.length) return { deleted: [] };
  await hydrateRuntimeSecrets({ required: true });
  const context = await genesysContext();
  const deleted = [];
  for (const flow of flows) {
    const profile = getTtsConnectorProfile(flow.profileId);
    if (!profile || profile.status !== "verified") {
      throw new Error(`Unknown or blocked TTS profile ${flow.profileId}`);
    }
    onProgress({
      status: "active",
      label: `Deleting Architect flow ${flow.name}`,
      profileId: profile.id,
    });
    try {
      const result = await deleteManagedGenesysTtsTestFlow(
        context.architectApi,
        { ...flow, profile }
      );
      deleted.push(result);
      onProgress({
        status: "success",
        label: `${flow.name}: deleted`,
        profileId: profile.id,
      });
    } catch (error) {
      onProgress({
        status: "failure",
        label: `${flow.name}: ${safeError(error).message}`,
        profileId: profile.id,
      });
      throw error;
    }
  }
  return { deleted };
}

function resolveRunPath(options) {
  const explicitPath = option(options, "run");
  if (explicitPath) return path.resolve(String(explicitPath));
  const runId = option(options, "run-id");
  if (!runId) throw new Error("--run=<path> or --run-id=<id> is required");
  return path.join(stateDirectory(options), "runs", `${runId}.json`);
}

async function reconcileUncertainCredential(journal, context) {
  if (journal.credential?.mode !== "creating" || journal.credential.id) return;
  if (!journal.credential.creationName) {
    throw new Error(
      `Interrupted run ${journal.runId} has no journaled credential creationName; manual inspection is required`
    );
  }
  const matches = (await listAllGenesysCredentials(context.integrationsApi)).filter(
    (credential) =>
      credential.name === journal.credential.creationName && credential.type?.name === "userDefined"
  );
  if (matches.length > 1) {
    throw new Error(`Multiple credentials match interrupted run ${journal.runId}`);
  }
  if (matches.length === 1) {
    journal.credential = {
      mode: "created-reconciled",
      id: matches[0].id,
      name: matches[0].name,
      creationName: journal.credential.creationName,
      requestedName: journal.credential.requestedName,
      type: matches[0].type?.name,
      retainedOnRollback: true,
    };
  }
}

async function preflightRollback(journal, context, { recoverIncomplete = false } = {}) {
  if (journal.environment !== genesysEnvironment()) {
    throw new Error(`Run targets ${journal.environment}, not ${genesysEnvironment()}`);
  }
  if (journal.organization?.id !== context.organization.id) {
    throw new Error(`Run targets organization ${journal.organization?.id}, not ${context.organization.id}`);
  }
  if (!Array.isArray(journal.results)) throw new Error("Run journal has no results array");
  if (journal.schemaVersion !== 1 || journal.toolVersion !== TTS_MANAGER_VERSION) {
    throw new Error("Run journal schema or tool version is not supported");
  }
  if (["creating", "created", "created-reconciled"].includes(journal.credential?.mode)) {
    const expectedCredentialName = managedCredentialCreationName(journal.runId);
    if (journal.credential.creationName !== expectedCredentialName) {
      throw new Error("Run journal has an invalid credential creationName");
    }
  }
  for (const result of journal.results) {
    const profile = getTtsConnectorProfile(result.profileId);
    if (!profile || profile.status !== "verified") {
      throw new Error(`Run journal references unavailable profile ${result.profileId}`);
    }
    if (result.created) {
      const expectedCreationName = managedIntegrationCreationName(profile.id, journal.runId);
      if (result.creationName !== expectedCreationName) {
        throw new Error(`Run journal has an invalid creationName for ${profile.id}`);
      }
    }
    if (
      result.beforeSnapshot?.integration?.id &&
      result.integrationId &&
      result.beforeSnapshot.integration.id !== result.integrationId
    ) {
      throw new Error(`Run journal snapshot target does not match ${result.integrationId}`);
    }
  }
  await reconcileUncertainCredential(journal, context);
  const candidates = [];
  for (const result of journal.results) {
    if (["no-op", "rolled-back", "failed-current-operation-rolled-back"].includes(result.status)) {
      continue;
    }
    if (result.status === "applied") {
      const current = await loadTtsInventoryEntry(context.integrationsApi, result.integrationId);
      const mode = classifyAppliedRollbackCandidate({
        result,
        current,
        profile: getTtsConnectorProfile(result.profileId),
        credentialId: journal.credential?.id,
      });
      if (mode === "drift") {
        throw new Error(`Integration ${result.integrationId} drifted after run ${journal.runId}`);
      }
      candidates.push({ result, mode });
      continue;
    }

    if (result.created) {
      if (!result.integrationId) {
        if (!result.creationName) {
          throw new Error(
            `Interrupted create for ${result.profileId} has no journaled creationName; ` +
              "manual inspection is required"
          );
        }
        const matches = await findTtsIntegrationsByName(
          context.integrationsApi,
          result.creationName,
          {
            attempts: result.createMayHaveSucceeded === false ? 1 : 6,
          }
        );
        const lookup = classifyInterruptedCreateLookup(result, matches);
        if (lookup === "multiple") {
          process.exitCode = EXIT_ROLLBACK_INCOMPLETE;
          throw new Error(`Multiple integrations match interrupted profile ${result.profileId}`);
        }
        if (lookup === "not-created") {
          candidates.push({ result, mode: "not-created" });
          continue;
        }
        if (lookup === "ambiguous") {
          process.exitCode = EXIT_ROLLBACK_INCOMPLETE;
          throw new Error(
            `Create outcome for ${result.profileId} remains ambiguous after polling ` +
              `${result.creationName}; retry rollback after checking status`
          );
        }
        if (!recoverIncomplete) {
          throw new Error(
            `Interrupted create for ${result.profileId} has one name-matched resource but no ` +
              "journaled integration ID; inspect status, then rerun rollback with --recover-incomplete"
          );
        }
        result.integrationId = matches[0].id;
        result.reconciledAfterInterruptedCreate = true;
      }
      const current = await loadTtsInventoryEntry(context.integrationsApi, result.integrationId);
      if (current.integration.integrationType?.id !== GENESYS_TTS_CONNECTOR_TYPE) {
        throw new Error(`Interrupted resource ${result.integrationId} is not a TTS Connector`);
      }
      if (
        result.beforeSnapshot &&
        restorableSnapshotHash(current) === restorableSnapshotHash(result.beforeSnapshot)
      ) {
        candidates.push({ result, mode: "already-created-original" });
      } else if (
        result.beforeSnapshot &&
        connectorDefinitionMatchesProfile(
          current,
          getTtsConnectorProfile(result.profileId),
          journal.credential?.id
        )
      ) {
        candidates.push({ result, mode: "restore-created" });
      } else if (integrationIsInactive(current) && !result.beforeSnapshot) {
        candidates.push({ result, mode: "already-disabled" });
      } else if (
        connectorDefinitionMatchesProfile(
          current,
          getTtsConnectorProfile(result.profileId),
          journal.credential?.id
        ) ||
        recoverIncomplete
      ) {
        candidates.push({
          result,
          mode: result.beforeSnapshot ? "restore-created" : "disable-created",
        });
      } else {
        throw new Error(
          `Interrupted integration ${result.integrationId} has an unexpected active configuration; ` +
            "inspect status, then rerun rollback with --recover-incomplete"
        );
      }
      continue;
    }

    if (result.beforeSnapshot) {
      const current = await loadTtsInventoryEntry(context.integrationsApi, result.integrationId);
      if (restorableSnapshotHash(current) === restorableSnapshotHash(result.beforeSnapshot)) {
        candidates.push({ result, mode: "already-original" });
      } else if (recoverIncomplete) {
        candidates.push({ result, mode: "restore-existing" });
      } else {
        throw new Error(
          `Interrupted integration ${result.integrationId} is in an uncertain state; ` +
            "inspect status, then rerun rollback with --recover-incomplete"
        );
      }
    }
  }
  return candidates;
}

async function commandRollback(options) {
  let recoverIncomplete;
  try {
    bareFlag(options, "apply", { required: true });
    recoverIncomplete = bareFlag(options, "recover-incomplete");
  } catch (error) {
    process.exitCode = EXIT_VALIDATION;
    throw error;
  }
  const runPath = resolveRunPath(options);
  const journal = await readJson(runPath);
  const directory = stateDirectory(options);
  const releaseLock = await acquireMutationLock(directory, "rollback");
  try {
    const context = await genesysContext();
    const candidates = await preflightRollback(journal, context, {
      recoverIncomplete,
    });
    journal.manualRollback = {
      startedAt: new Date().toISOString(),
      results: [],
      status: "running",
    };
    await writeJsonAtomic(runPath, journal);
    for (const candidate of [...candidates].reverse()) {
      const { result, mode } = candidate;
      try {
        if (mode === "disable-created") {
          await ensureInactive(context.integrationsApi, result.integrationId);
          journal.manualRollback.results.push({
            integrationId: result.integrationId,
            status: "disabled-created-integration",
            deleted: false,
          });
        } else if (mode === "restore-created") {
          await restoreSnapshot(context.integrationsApi, result.beforeSnapshot);
          journal.manualRollback.results.push({
            integrationId: result.integrationId,
            status: "restored-created-integration-to-initial-state",
            deleted: false,
          });
        } else if (mode === "restore-existing") {
          await restoreSnapshot(context.integrationsApi, result.beforeSnapshot);
          journal.manualRollback.results.push({
            integrationId: result.integrationId,
            status: "restored-existing-integration",
          });
        } else {
          journal.manualRollback.results.push({
            integrationId: result.integrationId || null,
            profileId: result.profileId,
            status: mode,
          });
        }
        result.status = "rolled-back";
        await writeJsonAtomic(runPath, journal);
      } catch (error) {
        journal.manualRollback.results.push({
          integrationId: result.integrationId,
          status: "incomplete",
          error: safeError(error),
        });
        journal.manualRollback.status = "incomplete";
        journal.manualRollback.finishedAt = new Date().toISOString();
        await writeJsonAtomic(runPath, journal);
        process.exitCode = EXIT_ROLLBACK_INCOMPLETE;
        throw error;
      }
    }
    journal.manualRollback.status = "completed";
    journal.manualRollback.finishedAt = new Date().toISOString();
    journal.status = "rolled-back";
    await writeJsonAtomic(runPath, journal);
    console.log(
      JSON.stringify(
        {
          runId: journal.runId,
          status: journal.status,
          credentialRetained: journal.credential,
          results: journal.manualRollback.results,
          journalPath: runPath,
        },
        null,
        2
      )
    );
  } finally {
    await releaseLock();
  }
}

async function loadInteractiveUi() {
  try {
    return await import("../lib/genesys/genesys-admin-ui.mjs");
  } catch (error) {
    throw new Error(
      `Interactive dependencies are unavailable (${error.message}). Run yarn install and retry.`
    );
  }
}

function environmentPresence(name) {
  return Boolean(String(process.env[name] || "").trim());
}

export function normalizeTtsInstallerConfigurationValue(name, value) {
  const normalized = String(value || "").trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
  return name === "GC_ENVIRONMENT"
    ? normalizeGenesysEnvironment(normalized)
    : normalized;
}

export async function saveTtsEnvironmentValues({
  values,
  replaceNames = [],
  environment = process.env,
  envFile = path.resolve(".env"),
} = {}) {
  if (!encryptedSecretStoreConfigured(environment)) {
    return saveInstallerEnvironmentValues({
      values,
      allowedNames: TTS_INSTALLER_VARIABLES,
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
    allowedNames: TTS_INSTALLER_VARIABLES,
    replaceNames,
    environment,
    envFile,
  });
  return { ...saved, saved: [...Object.keys(managed), ...saved.saved] };
}

async function collectTtsConfiguration(ui, names) {
  const values = {};
  for (const name of names) {
    const validate = (input) => {
      try {
        normalizeTtsInstallerConfigurationValue(name, input);
        return true;
      } catch (error) {
        return error.message;
      }
    };
    const input = TTS_MASKED_CONFIGURATION_VARIABLES.has(name)
      ? await ui.password(TTS_CONFIGURATION_PROMPTS[name], { validate })
      : await ui.input(
          TTS_CONFIGURATION_PROMPTS[name],
          String(process.env[name] || "").trim(),
          { validate }
        );
    values[name] = normalizeTtsInstallerConfigurationValue(name, input);
  }
  return values;
}

async function requestTtsConfiguration(ui, names, message) {
  const action = await ui.selectMenu(message, [
    { label: "Enter values now and save them securely", value: "enter" },
    { label: "Exit and run genesys:deploy", value: "exit" },
  ]);
  return action === "exit" ? null : collectTtsConfiguration(ui, names);
}

async function saveInteractiveTtsConfiguration(ui, values, replaceNames = []) {
  const saved = await ui.withSpinner("Securely saving configuration", () =>
    saveTtsEnvironmentValues({ values, replaceNames })
  );
  console.log(ui.color.success(`Saved ${saved.saved.join(", ")} to ${saved.envFile}`));
}

async function configureAndVerifyTtsGenesys(ui) {
  const names = TTS_INSTALLER_VARIABLES.filter((name) => name !== "TELNYX_API_KEY");
  console.log(ui.color.accent("\nGenesys Cloud preflight"));
  names.forEach((name) => ui.printCheck(name, environmentPresence(name) ? "ok" : "missing"));
  while (true) {
    const missing = names.filter((name) => !environmentPresence(name));
    if (missing.length) {
      const values = await requestTtsConfiguration(ui, missing, "Genesys configuration is missing");
      if (values === null) return null;
      await saveInteractiveTtsConfiguration(ui, values);
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
      return access;
    } catch (error) {
      ui.printCheck("Genesys platform access", "missing", error.message);
      const action = await ui.selectMenu("Genesys credentials could not be verified", [
        { label: "Re-enter Genesys API credentials and retry", value: "retry" },
        { label: "Exit and run genesys:deploy", value: "exit" },
      ]);
      if (action === "exit") return null;
      const values = await collectTtsConfiguration(ui, names);
      await saveInteractiveTtsConfiguration(ui, values, names);
    }
  }
}

async function configureAndVerifyTtsTelnyx(ui) {
  console.log(ui.color.accent("\nTelnyx API preflight"));
  ui.printCheck("TELNYX_API_KEY", environmentPresence("TELNYX_API_KEY") ? "ok" : "missing");
  while (true) {
    if (!environmentPresence("TELNYX_API_KEY")) {
      const values = await requestTtsConfiguration(
        ui,
        ["TELNYX_API_KEY"],
        "Telnyx API configuration is missing"
      );
      if (values === null) return null;
      await saveInteractiveTtsConfiguration(ui, values);
    }
    try {
      await ui.withSpinner("Verifying Telnyx account and Text-to-Speech API access", () =>
        verifyTelnyxPlatformAccess({ apiKey: process.env.TELNYX_API_KEY, capability: "tts" })
      );
      ui.printCheck("Telnyx API access", "ok", "account and Text-to-Speech API");
      return true;
    } catch (error) {
      ui.printCheck("Telnyx API access", "missing", error.message);
      const action = await ui.selectMenu("The Telnyx API key could not be verified", [
        { label: "Re-enter the Telnyx API key and retry", value: "retry" },
        { label: "Exit and run genesys:deploy", value: "exit" },
      ]);
      if (action === "exit") return null;
      const values = await collectTtsConfiguration(ui, ["TELNYX_API_KEY"]);
      await saveInteractiveTtsConfiguration(ui, values, ["TELNYX_API_KEY"]);
    }
  }
}

async function interactiveStartup(ui) {
  if (!(await configureAndVerifyTtsGenesys(ui))) return null;
  if (!(await configureAndVerifyTtsTelnyx(ui))) return null;
  return interactivePreflight(ui);
}

async function interactivePreflight(ui) {
  console.log(ui.color.accent("\nTTS Connector checks"));
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeReady = Number.isInteger(nodeMajor) && nodeMajor >= 20;
  ui.printCheck("Node.js 20+", nodeReady ? "ok" : "missing", process.versions.node);
  ui.printCheck("@inquirer/prompts", "ok", "interactive menus");
  ui.printCheck("chalk", "ok", "terminal colors");
  ui.printCheck("Genesys SDK", "ok", "purecloud-platform-client-v2");

  const genesysVariables = [
    "GC_ENVIRONMENT",
    "GC_CLIENT_CRED_CLIENT_ID",
    "GC_CLIENT_CRED_CLIENT_SECRET",
  ];
  for (const name of genesysVariables) {
    ui.printCheck(name, environmentPresence(name) ? "ok" : "missing");
  }
  ui.printCheck("TELNYX_API_KEY", environmentPresence("TELNYX_API_KEY") ? "ok" : "missing");
  const missingGenesys = [...genesysVariables, "TELNYX_API_KEY"].filter(
    (name) => !environmentPresence(name)
  );
  if (!nodeReady || missingGenesys.length) {
    return {
      ready: false,
      context: null,
      inventory: [],
      error: missingGenesys.length
        ? `Missing: ${missingGenesys.join(", ")}`
        : "Node.js 20 or newer is required",
    };
  }

  try {
    const context = await ui.withSpinner("Authenticating and reading Genesys Cloud", genesysContext);
    const inventory = await ui.withSpinner(
      "Loading Genesys TTS Connector inventory",
      () => loadTtsInventory(context.integrationsApi)
    );
    const maximum = Number(context.integrationType.maxInstances || 10);
    ui.printCheck(
      "Genesys organization",
      "ok",
      `${context.organization.name} / ${genesysEnvironment()}`
    );
    ui.printCheck("TTS Connector capacity", inventory.length < maximum ? "ok" : "warning", `${inventory.length}/${maximum}`);
    return { ready: true, context, inventory, error: null };
  } catch (error) {
    const safe = safeError(error);
    ui.printCheck("Genesys API access", "missing", safe.message);
    return { ready: false, context: null, inventory: [], error: safe.message };
  }
}

async function refreshInteractiveInventory(session, ui) {
  if (!session.ready || !session.context) throw new Error("Genesys preflight is not ready");
  session.inventory = await ui.withSpinner(
    "Refreshing Genesys TTS Connector inventory",
    () => loadTtsInventory(session.context.integrationsApi)
  );
  return session.inventory;
}

function profileStatusLabel(profile, ui) {
  return profile.status === "verified"
    ? ui.color.success("compatible")
    : ui.color.danger("blocked");
}

async function providerDetailsFlow(profile, catalog, ui) {
  console.log(ui.color.title(`\n${profile.displayName}`));
  console.log(`  Profile ID:      ${profile.id}`);
  console.log(`  Status:          ${profileStatusLabel(profile, ui)}`);
  console.log(`  Provider:        ${profile.provider || profile.displayName}`);
  if (profile.description) console.log(`  Description:     ${profile.description}`);
  if (profile.verification) console.log(`  Verification:    ${profile.verification} (${profile.verifiedAt})`);
  if (profile.reason) console.log(`  Blocked reason:  ${ui.color.danger(profile.reason)}`);
  if (profile.responseContract) {
    const audio = profile.responseContract;
    console.log(
      `  Audio contract:  ${audio.container} / ${audio.codec} / ${audio.sampleRate} Hz / ` +
        `${audio.channels} channel / ${audio.bitsPerSample} bit`
    );
  }
  console.log(`  Voice catalog:   ${providerCountLabel(catalog)} (${catalog.source})`);
  console.log(`  Languages:       ${catalog.languages.join(", ") || "not reported"}`);
  if (catalog.error) console.log(`  Catalog warning: ${ui.color.warning(catalog.error)}`);
  if (catalog.voices.length) {
    console.log(ui.color.accent("\n  Voices"));
    for (const voice of catalog.voices.slice(0, 40)) {
      const metadata = [voice.languages.join("/"), voice.gender, voice.model].filter(Boolean).join(", ");
      console.log(`    - ${voice.name}${metadata ? ` ${ui.color.muted(`(${metadata})`)}` : ""}`);
    }
    if (catalog.voices.length > 40) {
      console.log(ui.color.muted(`    … and ${catalog.voices.length - 40} more`));
    }
  }
  await ui.pause();
}

async function viewProvidersFlow(session, ui) {
  const profiles = listTtsConnectorProfiles();
  if (!session.providerCatalog) {
    session.providerCatalog = await ui.withSpinner(
      environmentPresence("TELNYX_API_KEY")
        ? "Loading live Telnyx voice catalogs"
        : "Loading verified provider metadata",
      () => loadTtsProviderCatalog(profiles, { apiKey: process.env.TELNYX_API_KEY })
    );
  }
  while (true) {
    const choice = await ui.selectMenu("View providers", [
      ...profiles.map((profile) => {
        const catalog = session.providerCatalog.get(profile.id);
        return {
          label:
            `${profile.status === "verified" ? "✓" : "×"} ${profile.displayName} — ` +
            `${providerCountLabel(catalog)} [${profile.status}]`,
          value: profile.id,
          description: profile.description || profile.reason,
        };
      }),
      { label: "↻ Refresh voice catalogs", value: "refresh" },
      ui.backOption("Back to main menu"),
    ], { pageSize: 18 });
    if (choice === "back") return;
    if (choice === "refresh") {
      session.providerCatalog = null;
      return viewProvidersFlow(session, ui);
    }
    await providerDetailsFlow(
      getTtsConnectorProfile(choice),
      session.providerCatalog.get(choice),
      ui
    );
  }
}

function installedEntryLabel(status, ui) {
  const profile = getTtsConnectorProfile(status.profileId);
  const provider = profile?.displayName || status.name || "Unrecognized Telnyx TTS";
  const state = String(status.reportedState || "UNKNOWN").toUpperCase();
  const stateLabel = state === "ACTIVE" ? ui.color.success(state) : ui.color.warning(state);
  const ownership = status.managed ? "managed" : status.profileId ? "recognized legacy" : "unrecognized";
  return `${provider} — ${stateLabel}, ${ownership}`;
}

function printInstalledDetails(status, ui) {
  const profile = getTtsConnectorProfile(status.profileId);
  console.log(ui.color.title(`\n${profile?.displayName || status.name}`));
  console.log(`  Integration name: ${status.name}`);
  console.log(`  Integration ID:   ${status.integrationId}`);
  console.log(`  Profile:          ${status.profileId || "unrecognized Telnyx configuration"}`);
  console.log(`  Managed by CLI:   ${status.managed ? "yes" : "no"}`);
  console.log(`  Intended state:   ${status.intendedState || "unknown"}`);
  console.log(`  Reported state:   ${status.reportedState || "unknown"}`);
  console.log(`  Config version:   ${status.configVersion}`);
  console.log(`  Credential ID:    ${status.credentialId || "none"}`);
  console.log(`  Configuration:    ${status.healthy ? ui.color.success("healthy") : ui.color.warning("not fully managed/healthy")}`);
}

async function currentlyInstalledFlow(session, ui) {
  while (true) {
    const inventory = await refreshInteractiveInventory(session, ui);
    const allStatuses = inventory.map(classifyInventoryEntry);
    const installed = allStatuses.filter((status) => status.telnyx);
    const maximum = Number(session.context.integrationType.maxInstances || 10);
    console.log(ui.color.accent(`\nGenesys TTS Connector capacity: ${inventory.length}/${maximum}`));
    if (!installed.length) {
      console.log(ui.color.warning("No Telnyx-backed TTS Connectors were found."));
      await ui.pause();
      return;
    }
    const choice = await ui.selectMenu("Currently installed Telnyx TTS providers", [
      ...installed.map((status) => ({
        label: installedEntryLabel(status, ui),
        value: status.integrationId,
      })),
      ui.backOption("Back to main menu"),
    ]);
    if (choice === "back") return;
    printInstalledDetails(
      installed.find((status) => status.integrationId === choice),
      ui
    );
    await ui.pause();
  }
}

function installationCandidates(inventory) {
  const statuses = inventory.map(classifyInventoryEntry);
  return verifiedTtsConnectorProfiles().map((profile) => {
    const matches = statuses.filter(
      (status) =>
        status.profileId === profile.id ||
        status.unmanagedProfileMatches.includes(profile.id)
    );
    const managed = matches.find((status) => status.managed);
    const recognized = managed || matches[0] || null;
    return {
      profile,
      status: recognized,
      create: !recognized,
      selectable: !recognized || (recognized.managed && !recognized.healthy),
    };
  });
}

async function chooseInstallCredential(session, ui) {
  const credentials = await ui.withSpinner(
    "Loading Genesys credentials",
    () => listAllGenesysCredentials(session.context.integrationsApi)
  );
  const userDefined = credentials.filter((credential) => credential.type?.name === "userDefined");
  const referencedCounts = new Map();
  for (const entry of session.inventory.filter(isTelnyxTtsInventoryEntry)) {
    const id = entry.config?.credentials?.basicAuth?.id;
    if (id) referencedCounts.set(id, (referencedCounts.get(id) || 0) + 1);
  }
  const eligible = userDefined.filter(
    (credential) =>
      referencedCounts.has(credential.id) ||
      /telnyx/i.test(String(credential.name || ""))
  );
  eligible.sort((left, right) => {
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
  const choices = eligible.map((credential) => ({
    label: `${credential.name || "Unnamed userDefined credential"} — ${credential.id}` +
      `${referencedCounts.has(credential.id) ? ` [used by ${referencedCounts.get(credential.id)} Telnyx connector(s)]` : ""}`,
    value: { mode: "existing", id: credential.id },
  }));
  if (environmentPresence("TELNYX_API_KEY")) {
    choices.push({
      label: "Create a new managed credential from TELNYX_API_KEY",
      value: { mode: "create" },
    });
  }
  choices.push(ui.backOption("Back to provider selection"));
  if (choices.length === 1) {
    throw new Error(
      "No userDefined Genesys credential exists and TELNYX_API_KEY is missing; configure one before installing"
    );
  }
  const selected = await ui.selectMenu("Credential for the selected providers", choices, { pageSize: 15 });
  return selected === "back" ? null : selected;
}

function printTestFlowDialInstructions({ flows, skipped }, ui) {
  if (flows.length) {
    console.log(ui.color.success("\nArchitect test flow creation completed."));
  } else {
    console.log(ui.color.warning("\nNo Architect test flows were published."));
  }
  for (const flow of flows) {
    console.log(ui.color.accent("\nFlow name — copy this value:"));
    console.log(`  ${flow.name}`);
  }
  for (const flow of skipped) {
    console.log(ui.color.warning(`\nSkipped ${flow.name}: ${flow.reason}`));
  }
  if (!flows.length) return;
  console.log(ui.color.accent("\nHow to call a test flow from Genesys Cloud:"));
  console.log("  1. Copy the flow name shown above.");
  console.log("  2. Paste it into the Genesys Cloud dial pad search field.");
  console.log("  3. Press Enter to confirm the selected flow.");
  console.log("  4. Click the Dial button to start the call.");
  console.log(ui.color.muted("No DID or call route was created or changed."));
}

export async function architectTargetsWithVoiceCatalogs(targets, session, ui) {
  if (!session.providerCatalog) {
    session.providerCatalog = await ui.withSpinner(
      "Loading live Telnyx voice catalogs",
      () => loadTtsProviderCatalog(listTtsConnectorProfiles(), {
        apiKey: process.env.TELNYX_API_KEY,
      })
    );
  }
  return prepareGenesysTtsArchitectTargets(targets, session.providerCatalog);
}

async function publishArchitectTestFlowTargets({ targets, session, ui }) {
  const prepared = await architectTargetsWithVoiceCatalogs(targets, session, ui);
  if (!prepared.targets.length) return { flows: [], skipped: prepared.skipped };
  console.log(ui.color.accent("\nPublishing Architect test flows"));
  const published = await publishGenesysTtsTestFlows({
    environment: genesysEnvironment(),
    accessToken: session.context.accessToken,
    architectApi: session.context.architectApi,
    targets: prepared.targets,
    onProgress: (event) => ui.printProgress(event.status, event.label),
  });
  return {
    flows: published.flows,
    skipped: [...prepared.skipped, ...published.skipped],
  };
}

async function offerArchitectTestFlows({ session, ui, installationSummary }) {
  const targets = (installationSummary.results || [])
    .filter((result) => result.integrationId && ["applied", "no-op"].includes(result.status))
    .map((result) => ({
      integrationId: result.integrationId,
      profile: getTtsConnectorProfile(result.profileId),
    }))
    .filter((target) => target.profile?.status === "verified");
  if (!targets.length) return;
  if (!(await ui.confirm("Create Architect test flow(s) for the installed provider(s)?", false))) {
    console.log(ui.color.muted("Architect test flow creation skipped."));
    return;
  }

  try {
    const outcome = await publishArchitectTestFlowTargets({ targets, session, ui });
    printTestFlowDialInstructions(outcome, ui);
  } catch (error) {
    console.log(
      ui.color.warning(
        `\nConnectors were installed, but Architect test flow creation failed: ${safeError(error).message}`
      )
    );
  }
}

async function architectTestFlowsFlow(session, ui) {
  const inventory = await refreshInteractiveInventory(session, ui);
  const targets = inventory
    .map(classifyInventoryEntry)
    .filter((status) => status.managed && status.healthy)
    .map((status) => ({
      status,
      integrationId: status.integrationId,
      profile: getTtsConnectorProfile(status.profileId),
    }))
    .filter((target) => target.profile?.status === "verified");
  if (!targets.length) {
    console.log(ui.color.warning("No healthy managed Telnyx TTS connectors are available."));
    await ui.pause();
    return;
  }

  const selected = await ui.checkboxMenu(
    "Select providers whose Architect test flows should be created or updated",
    [
      ...targets.map((target) => ({
        label: `${target.profile.displayName} — ${target.status.name}`,
        value: target.integrationId,
      })),
      ui.backOption("Back to main menu"),
    ],
    {
      validate(values) {
        if (!values.length) return "Select at least one provider or Back";
        if (values.includes("back")) {
          return values.length === 1 ? true : "Select Back by itself";
        }
        return true;
      },
    }
  );
  if (selected.includes("back")) return;
  const selectedTargets = targets
    .filter((target) => selected.includes(target.integrationId))
    .map(({ integrationId, profile }) => ({ integrationId, profile }));
  if (!(await ui.confirm(
    `Create or update ${selectedTargets.length} managed Architect test flow(s)?`,
    false
  ))) {
    console.log(ui.color.warning("Architect test flow operation cancelled."));
    return;
  }

  const outcome = await publishArchitectTestFlowTargets({
    targets: selectedTargets,
    session,
    ui,
  });
  printTestFlowDialInstructions(outcome, ui);
  await ui.pause();
}

async function installProvidersFlow(session, ui) {
  const inventory = await refreshInteractiveInventory(session, ui);
  const maximum = Number(session.context.integrationType.maxInstances || 10);
  const freeSlots = Math.max(0, maximum - inventory.length);
  const candidates = installationCandidates(inventory);
  console.log(ui.color.accent(`\nCapacity: ${inventory.length}/${maximum}; free slots: ${freeSlots}`));
  const choices = candidates.map(({ profile, status, create, selectable }) => {
    let suffix = "not installed";
    let disabled = false;
    if (status?.healthy) {
      suffix = "installed and healthy";
      disabled = "Already installed";
    } else if (status && !status.managed) {
      suffix = "installed as recognized legacy connector";
      disabled = "Already installed; use Currently installed for details";
    } else if (status) {
      suffix = "installed but needs repair/update";
    } else if (freeSlots === 0) {
      disabled = "No free Genesys TTS Connector slots";
    }
    if (!selectable && !disabled) disabled = "Already installed";
    return {
      label: `${profile.displayName} — ${suffix}${create ? " (uses 1 slot)" : ""}`,
      value: profile.id,
      description: profile.description,
      disabled,
    };
  });
  const enabledChoices = choices.filter((choice) => !choice.disabled);
  if (!enabledChoices.length) {
    console.log(ui.color.warning("There are no providers that can be installed or repaired right now."));
    console.log(ui.color.muted("Destroy an unused connector first if the Genesys limit is full."));
    await ui.pause();
    return;
  }
  while (true) {
    const selected = await ui.checkboxMenu(
      "Select providers to install or repair (Space selects, Enter continues)",
      [...choices, ui.backOption("Back to main menu")],
      {
        validate(values) {
          if (!values.length) return "Select at least one provider or Back";
          if (values.includes("back")) {
            return values.length === 1 ? true : "Select Back by itself";
          }
          const createCount = candidates.filter(
            (candidate) => values.includes(candidate.profile.id) && candidate.create
          ).length;
          return createCount <= freeSlots
            ? true
            : `Selection needs ${createCount} slots, but only ${freeSlots} are free`;
        },
      }
    );
    if (selected.includes("back")) return;
    const credential = await chooseInstallCredential(session, ui);
    if (!credential) continue;

    const planOptions = {
      profiles: selected.join(","),
      ...(credential.mode === "existing"
        ? { "credential-id": credential.id }
        : { "create-credential": true }),
    };
    const { plan, outputPath } = await ui.withSpinner(
      "Building a drift-protected installation plan",
      () => commandPlan(planOptions, { interactive: true, quiet: true })
    );
    console.log(ui.color.accent("\nInstallation preview"));
    console.log(planSummary(plan));
    console.log(ui.color.muted(`Plan file: ${outputPath}`));
    if (plan.blockers.length) {
      console.log(ui.color.danger("\nThe plan has blockers and cannot be applied."));
      await ui.pause();
      return;
    }
    if (!(await ui.confirm("Apply this installation plan to Genesys Cloud?", false))) {
      console.log(ui.color.warning("Installation cancelled; the read-only plan file was retained."));
      return;
    }
    console.log(ui.color.accent("\nApplying providers"));
    const summary = await commandApply(
      { plan: outputPath, apply: true },
      {
        interactive: true,
        quiet: true,
        onProgress(event) {
          ui.printProgress(event.status === "active" ? "active" : event.status, event.label);
        },
      },
    );
    console.log(ui.color.success(`\nInstallation completed. Run journal: ${summary.journalPath}`));
    await refreshInteractiveInventory(session, ui);
    await offerArchitectTestFlows({ session, ui, installationSummary: summary });
    await ui.pause();
    return;
  }
}

async function remainingTelnyxTtsInventory(integrationsApi, excludedIntegrationIds = []) {
  const excluded = new Set(excludedIntegrationIds);
  const integrations = (await listAllTtsIntegrations(integrationsApi)).filter(
    (integration) => !excluded.has(integration.id)
  );
  const inventory = await Promise.all(
    integrations.map((integration) =>
      loadTtsInventoryEntry(integrationsApi, integration.id)
    )
  );
  return inventory.filter(isTelnyxTtsInventoryEntry);
}

export async function destroyTtsIntegrations(
  targets,
  {
    expectedOrganizationId,
    credentials = [],
    testFlows = [],
    options = {},
    onProgress = () => {},
  } = {}
) {
  if (!Array.isArray(targets) || !targets.length) throw new Error("At least one destroy target is required");
  const ids = targets.map((target) => String(target.integrationId || "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Destroy targets contain a missing or duplicate integration ID");
  }
  const flowIds = testFlows.map((flow) => String(flow.id || "").trim());
  if (flowIds.some((id) => !id) || new Set(flowIds).size !== flowIds.length) {
    throw new Error("Test flow targets contain a missing or duplicate flow ID");
  }
  for (const flow of testFlows) {
    if (!ids.includes(String(flow.integrationId || "").trim())) {
      throw new Error(`Test flow ${flow.id} is not associated with a selected connector`);
    }
    if (!genesysTtsTestFlowIsManaged(flow, flow.profile, flow.integrationId)) {
      throw new Error(`Test flow ${flow.id} does not have the expected ownership markers`);
    }
  }
  const credentialIds = credentials.map((credential) => String(credential.id || "").trim());
  if (
    credentialIds.some((id) => !id) ||
    new Set(credentialIds).size !== credentialIds.length
  ) {
    throw new Error("Credential targets contain a missing or duplicate credential ID");
  }
  const directory = stateDirectory(options);
  const releaseLock = await acquireMutationLock(directory, "destroy");
  const runId = randomUUID();
  const journalPath = path.join(directory, "destroy-runs", `${runId}.json`);
  let journal;
  try {
    onProgress({ status: "active", label: "Revalidating destroy targets" });
    const context = await genesysContext();
    if (context.organization.id !== expectedOrganizationId) {
      throw new Error(`Destroy targets belong to another Genesys organization`);
    }
    const entries = await Promise.all(ids.map((id) => loadTtsInventoryEntry(context.integrationsApi, id)));
    for (const [index, entry] of entries.entries()) {
      if (!isTelnyxTtsInventoryEntry(entry)) {
        throw new Error(`Integration ${ids[index]} is not a recognized Telnyx-backed TTS Connector`);
      }
      if (inventorySnapshotHash(entry) !== targets[index].expectedSnapshotHash) {
        throw new Error(`Integration ${ids[index]} changed after selection; destroy was cancelled`);
      }
    }
    if (credentials.length) {
      const selectedCredentialIds = new Set(
        entries.map((entry) => entry.config?.credentials?.basicAuth?.id).filter(Boolean)
      );
      for (const credential of credentials) {
        if (!selectedCredentialIds.has(credential.id)) {
          throw new Error(
            `Credential ${credential.id} is not used by a selected Telnyx TTS Connector`
          );
        }
        const current = await validateGenesysCredential(context.integrationsApi, credential.id);
        if (current.name !== credential.name) {
          throw new Error(`Credential ${credential.id} changed after selection; destroy was cancelled`);
        }
      }
      const remainingTelnyx = await remainingTelnyxTtsInventory(
        context.integrationsApi,
        ids
      );
      if (remainingTelnyx.length) {
        throw new Error(
          "Credential deletion is allowed only when every Telnyx TTS Connector is selected"
        );
      }
      const references = await findGenesysCredentialReferences(
        context.integrationsApi,
        credentialIds,
        { excludeIntegrationIds: ids }
      );
      for (const credential of credentials) {
        if (references[credential.id]?.length) {
          throw new Error(
            `Credential ${credential.id} is still used by another Genesys integration`
          );
        }
      }
    }
    journal = {
      schemaVersion: 1,
      toolVersion: TTS_MANAGER_VERSION,
      runId,
      environment: genesysEnvironment(),
      organization: { id: context.organization.id, name: context.organization.name },
      startedAt: new Date().toISOString(),
      status: "destroying",
      credentialsDeleted: false,
      credentials: credentials.map((credential) => ({
        id: credential.id,
        name: credential.name,
        status: "selected",
      })),
      testFlows: testFlows.map(({ profile, ...flow }) => ({
        ...flow,
        status: "selected",
      })),
      results: entries.map((entry) => ({
        integrationId: entry.integration.id,
        name: entry.integration.name,
        status: "validated",
        beforeSnapshot: snapshotInventoryEntry(entry),
      })),
    };
    await writeJsonAtomic(journalPath, journal);
    onProgress({ status: "success", label: "Destroy targets revalidated" });

    for (const result of journal.results) {
      try {
        result.status = "disabling";
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "active", label: `Disabling ${result.name}` });
        await ensureInactive(context.integrationsApi, result.integrationId);
        result.status = "deleting";
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "active", label: `Deleting ${result.name}` });
        const deletion = await deleteTtsIntegrationSafely(
          context.integrationsApi,
          result.integrationId
        );
        result.status = "deleted";
        result.deletedAt = new Date().toISOString();
        result.deletion = deletion;
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "success", label: `${result.name} deleted` });
      } catch (error) {
        result.status = "failed";
        result.error = safeError(error);
        try {
          const remaining = await loadTtsInventoryEntry(
            context.integrationsApi,
            result.integrationId
          );
          if (!isTelnyxTtsInventoryEntry(remaining)) {
            throw new Error("Remaining integration no longer has the expected Telnyx TTS scope");
          }
          await restoreSnapshot(context.integrationsApi, result.beforeSnapshot);
          result.automaticRestore = { status: "restored-after-delete-failure" };
          result.status = "failed-delete-restored";
        } catch (restoreError) {
          result.automaticRestore = {
            status: "incomplete",
            error: safeError(restoreError),
          };
        }
        journal.status = "partial-failure";
        journal.finishedAt = new Date().toISOString();
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "failure", label: `${result.name}: ${result.error.message}` });
        throw error;
      }
    }

    const flowTargets = new Map(testFlows.map((flow) => [flow.id, flow]));
    for (const flowResult of journal.testFlows) {
      const target = flowTargets.get(flowResult.id);
      try {
        flowResult.status = "deleting";
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "active", label: `Deleting Architect flow ${flowResult.name}` });
        flowResult.deletion = await deleteManagedGenesysTtsTestFlow(
          context.architectApi,
          target
        );
        flowResult.status = flowResult.deletion.alreadyAbsent ? "already-absent" : "deleted";
        flowResult.deletedAt = new Date().toISOString();
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "success", label: `${flowResult.name} deleted` });
      } catch (error) {
        flowResult.status = "failed";
        flowResult.error = safeError(error);
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "failure", label: `${flowResult.name}: ${flowResult.error.message}` });
      }
    }

    const failedFlows = journal.testFlows.filter((flow) => flow.status === "failed");
    const credentialTargets = new Map(credentials.map((credential) => [credential.id, credential]));
    for (const credentialResult of journal.credentials) {
      const target = credentialTargets.get(credentialResult.id);
      try {
        credentialResult.status = "revalidating";
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "active", label: `Revalidating credential ${credentialResult.name}` });
        const remainingInventory = await remainingTelnyxTtsInventory(
          context.integrationsApi,
          ids
        );
        if (remainingInventory.length) {
          throw new Error("A Telnyx TTS Connector exists; credential deletion was cancelled");
        }
        const current = await validateGenesysCredential(
          context.integrationsApi,
          credentialResult.id
        );
        if (current.name !== target.name) {
          throw new Error(`Credential ${credentialResult.id} changed after selection`);
        }
        const references = await findGenesysCredentialReferences(
          context.integrationsApi,
          [credentialResult.id],
          { excludeIntegrationIds: ids }
        );
        if (references[credentialResult.id]?.length) {
          throw new Error(`Credential ${credentialResult.id} is used by another integration`);
        }
        credentialResult.status = "deleting";
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "active", label: `Deleting credential ${credentialResult.name}` });
        credentialResult.deletion = await deleteGenesysCredentialSafely(
          context.integrationsApi,
          credentialResult.id
        );
        credentialResult.status = credentialResult.deletion.alreadyAbsent
          ? "already-absent"
          : "deleted";
        credentialResult.deletedAt = new Date().toISOString();
        await writeJsonAtomic(journalPath, journal);
        onProgress({ status: "success", label: `${credentialResult.name} deleted` });
      } catch (error) {
        credentialResult.status = "failed";
        credentialResult.error = safeError(error);
        await writeJsonAtomic(journalPath, journal);
        onProgress({
          status: "failure",
          label: `${credentialResult.name}: ${credentialResult.error.message}`,
        });
      }
    }

    const failedCredentials = journal.credentials.filter(
      (credential) => credential.status === "failed"
    );
    journal.credentialsDeleted = journal.credentials.some((credential) =>
      ["deleted", "already-absent"].includes(credential.status)
    );
    journal.status = failedCredentials.length
      ? failedFlows.length
        ? "completed-with-resource-errors"
        : "completed-with-credential-errors"
      : failedFlows.length
        ? "completed-with-flow-errors"
        : "completed";
    journal.finishedAt = new Date().toISOString();
    await writeJsonAtomic(journalPath, journal);
    return {
      runId,
      journalPath,
      deleted: journal.results.map(({ integrationId, name }) => ({ integrationId, name })),
      deletedFlows: journal.testFlows
        .filter((flow) => ["deleted", "already-absent"].includes(flow.status))
        .map(({ id, name, status }) => ({ id, name, status })),
      flowFailures: failedFlows.map(({ id, name, error }) => ({ id, name, error })),
      deletedCredentials: journal.credentials
        .filter((credential) => ["deleted", "already-absent"].includes(credential.status))
        .map(({ id, name, status }) => ({ id, name, status })),
      credentialFailures: failedCredentials.map(({ id, name, error }) => ({ id, name, error })),
      credentialsDeleted: journal.credentialsDeleted,
    };
  } catch (error) {
    if (journal && journal.status === "destroying") {
      journal.status = "failed-before-delete";
      journal.error = safeError(error);
      journal.finishedAt = new Date().toISOString();
      await writeJsonAtomic(journalPath, journal).catch(() => {});
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

async function destroyProvidersFlow(session, ui) {
  const inventory = await refreshInteractiveInventory(session, ui);
  const statuses = inventory.map(classifyInventoryEntry);
  const destroyable = statuses.filter((status) => status.telnyx);
  if (!destroyable.length) {
    console.log(ui.color.warning("No Telnyx-backed TTS Connectors are available for deletion."));
    await ui.pause();
    return;
  }
  const selectedIds = await ui.checkboxMenu(
    "Select Telnyx TTS Connectors to destroy (Space selects, Enter continues)",
    [
      ...destroyable.map((status) => ({
        label: `${installedEntryLabel(status, ui)} — ${status.integrationId}`,
        value: status.integrationId,
      })),
      ui.backOption("Back to main menu"),
    ],
    {
      validate(values) {
        if (!values.length) return "Select at least one connector or Back";
        if (values.includes("back")) return values.length === 1 ? true : "Select Back by itself";
        return true;
      },
    }
  );
  if (selectedIds.includes("back")) return;
  const selected = destroyable.filter((status) => selectedIds.includes(status.integrationId));
  const flowLookupTargets = selected
    .map((status) => ({
      integrationId: status.integrationId,
      profile: getTtsConnectorProfile(status.profileId),
    }))
    .filter((target) => target.profile?.status === "verified");
  const flowLookup = flowLookupTargets.length
    ? await ui.withSpinner(
        "Checking for managed Architect test flows",
        () => findManagedGenesysTtsTestFlows(session.context.architectApi, flowLookupTargets)
      )
    : { flows: [], conflicts: [] };
  for (const conflict of flowLookup.conflicts) {
    console.log(
      ui.color.warning(
        `Architect flow ${conflict.name} exists but is not owned by this connector; it will not be deleted.`
      )
    );
  }
  let testFlows = [];
  if (flowLookup.flows.length) {
    console.log(ui.color.accent("\nManaged Architect test flow(s) found:"));
    for (const flow of flowLookup.flows) console.log(`  - ${flow.name} (${flow.id})`);
    if (
      await ui.confirm(
        `Also delete ${flowLookup.flows.length} associated Architect test flow(s)?`,
        DEFAULT_DELETE_ASSOCIATED_TEST_FLOWS
      )
    ) {
      testFlows = flowLookup.flows.map((flow) => ({
        ...flow,
        profile: getTtsConnectorProfile(flow.profileId),
      }));
    }
  }
  let credentials = [];
  if (selected.length === destroyable.length) {
    const candidateCredentialIds = [
      ...new Set(selected.map((status) => status.credentialId).filter(Boolean)),
    ];
    if (candidateCredentialIds.length) {
      const credentialLookup = await ui.withSpinner(
        "Checking credentials used by the last Telnyx TTS Connector(s)",
        async () => {
          const [allCredentials, references] = await Promise.all([
            listAllGenesysCredentials(session.context.integrationsApi),
            findGenesysCredentialReferences(
              session.context.integrationsApi,
              candidateCredentialIds,
              { excludeIntegrationIds: selectedIds }
            ),
          ]);
          const byId = new Map(allCredentials.map((credential) => [credential.id, credential]));
          return {
            eligible: candidateCredentialIds
              .map((id) => byId.get(id))
              .filter(
                (credential) =>
                  credential?.type?.name === "userDefined" &&
                  !references[credential.id]?.length
              ),
            blocked: candidateCredentialIds
              .map((id) => ({ credential: byId.get(id), references: references[id] || [] }))
              .filter(
                ({ credential, references: found }) =>
                  credential?.type?.name !== "userDefined" || found.length
              ),
          };
        }
      );
      for (const blocked of credentialLookup.blocked) {
        const label = blocked.credential?.name || blocked.credential?.id || "Unknown credential";
        console.log(
          ui.color.warning(
            blocked.references.length
              ? `Credential ${label} is used by another integration and will not be offered for deletion.`
              : `Credential ${label} could not be verified and will not be offered for deletion.`
          )
        );
      }
      if (credentialLookup.eligible.length) {
        console.log(ui.color.accent("\nUnused credential(s) after this destroy:"));
        for (const credential of credentialLookup.eligible) {
          console.log(`  - ${credential.name} (${credential.id})`);
        }
        console.log(
          ui.color.warning(
            "Credential secrets cannot be read back or recovered after deletion."
          )
        );
        if (
          await ui.confirm(
            `Also permanently delete ${credentialLookup.eligible.length} unused credential(s)?`,
            DEFAULT_DELETE_UNUSED_TTS_CREDENTIALS
          )
        ) {
          credentials = credentialLookup.eligible.map(({ id, name }) => ({ id, name }));
        }
      }
    }
  }
  console.log(ui.color.danger("\nDestroy preview — this operation is irreversible"));
  for (const status of selected) {
    console.log(`  - ${status.name} (${status.integrationId})`);
  }
  if (credentials.length) {
    console.log(
      ui.color.danger(`${credentials.length} unused Genesys credential(s) will also be deleted.`)
    );
  } else {
    console.log(ui.color.warning("Genesys credentials will be retained."));
  }
  if (testFlows.length) {
    console.log(ui.color.warning(`${testFlows.length} associated Architect test flow(s) will also be deleted.`));
  }
  if (!(await ui.confirm(`Permanently delete ${selected.length} connector(s) from ${session.context.organization.name}?`, false))) {
    console.log(ui.color.warning("Destroy cancelled; no changes were made."));
    return;
  }
  const summary = await destroyTtsIntegrations(
    selected.map((status) => ({
      integrationId: status.integrationId,
      expectedSnapshotHash: status.observedSnapshotHash,
    })),
    {
      expectedOrganizationId: session.context.organization.id,
      credentials,
      testFlows,
      onProgress: (event) => ui.printProgress(event.status, event.label),
    }
  );
  console.log(ui.color.success(`\nDeleted ${summary.deleted.length} connector(s).`));
  if (summary.deletedFlows.length) {
    console.log(ui.color.success(`Deleted ${summary.deletedFlows.length} Architect test flow(s).`));
  }
  for (const failure of summary.flowFailures) {
    console.log(
      ui.color.warning(
        `Architect flow ${failure.name} was not deleted: ${failure.error.message}`
      )
    );
  }
  if (summary.deletedCredentials.length) {
    console.log(
      ui.color.success(`Deleted ${summary.deletedCredentials.length} Genesys credential(s).`)
    );
  }
  for (const failure of summary.credentialFailures) {
    console.log(
      ui.color.warning(
        `Credential ${failure.name} was not deleted: ${failure.error.message}`
      )
    );
  }
  console.log(ui.color.muted(`Destroy journal: ${summary.journalPath}`));
  await refreshInteractiveInventory(session, ui);
  await ui.pause();
}

async function interactiveMain() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY. Run with help for automation commands.");
  }
  const ui = await loadInteractiveUi();
  ui.header(
    "Telnyx × Genesys Cloud Administration CLI",
    "TTS provider discovery, installation, status and removal"
  );
  let session = await interactiveStartup(ui);
  if (!session) {
    console.log(
      ui.color.warning(
        `No remote changes were made. Update the required configuration and retry in Web Admin.`
      )
    );
    return;
  }
  if (!session.ready) {
    console.log(
      ui.color.warning(
        "TTS Connector checks did not pass. No remote changes were made; resolve the reported issue and retry in Web Admin."
      )
    );
    return;
  }
  while (true) {
    const disabledReason = session.ready ? false : `Genesys unavailable: ${session.error}`;
    const action = await ui.selectMenu("Main menu", [
      { label: "View providers", value: "providers", description: "Voice counts, languages and compatibility details" },
      { label: "Currently installed", value: "installed", disabled: disabledReason },
      { label: "Install provider", value: "install", disabled: disabledReason },
      {
        label: "Architect test flows",
        value: "test-flows",
        description: "Create, update or retry test flows for installed providers",
        disabled: disabledReason,
      },
      { label: "Destroy provider", value: "destroy", disabled: disabledReason },
      { label: "Re-run startup checks", value: "preflight" },
      { label: "Quit", value: "quit" },
    ]);
    if (action === "quit") {
      // Genesys SDK clients keep sockets/timers alive after the menu returns.
      // At this point every operation has completed, so terminate the CLI
      // explicitly instead of leaving the prompt process hanging.
      process.exit(0);
    }
    try {
      if (action === "providers") await viewProvidersFlow(session, ui);
      if (action === "installed") await currentlyInstalledFlow(session, ui);
      if (action === "install") await installProvidersFlow(session, ui);
      if (action === "test-flows") await architectTestFlowsFlow(session, ui);
      if (action === "destroy") await destroyProvidersFlow(session, ui);
      if (action === "preflight") {
        const refreshed = await interactiveStartup(ui);
        if (!refreshed) return;
        if (!refreshed.ready) {
          console.log(
            ui.color.warning(
              "TTS Connector checks did not pass. Resolve the reported issue and retry in Web Admin."
            )
          );
          return;
        }
        session = refreshed;
      }
    } catch (error) {
      if (error?.name === "ExitPromptError") throw error;
      console.error(ui.color.danger(`\nERROR: ${safeError(error).message}`));
      await ui.pause();
    }
  }
}
