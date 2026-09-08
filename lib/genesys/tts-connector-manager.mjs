import { createHash, randomUUID } from "node:crypto";

import {
  GENESYS_TTS_CONNECTOR_TYPE,
  GENESYS_TTS_CREDENTIAL_SLOT,
  assertTtsConnectorProfile,
  getTtsConnectorProfile,
} from "./tts-connector-profiles.mjs";

export const TTS_MANAGER_VERSION = "1.1.0";
export const TTS_PLAN_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_PLAN_AGE_MS = 60 * 60 * 1000;

const MANAGED_BY = "telnyx-genesys-tts-cli";
const SECRET_KEY_PATTERN = /authorization|api[-_]?key|secret|password|token|credentialfields/i;
const TELNYX_API_ORIGIN = "https://api.telnyx.com";
const TELNYX_TTS_PATH_PREFIX = "/v2/text-to-speech/";

export function deepClone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(entry),
      ])
    );
  }
  if (typeof value === "string") {
    return value
      .replace(
        /((?:["']?authorization["']?)\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[A-Za-z0-9._~+/=-]+/gi,
        "$1[REDACTED]"
      )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
      .replace(
        /((?:api[-_ ]?key|client[-_ ]?secret|password)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[REDACTED]"
      );
  }
  return value;
}

export function safeError(error) {
  const response = error?.response;
  const body = response?.body;
  const headers = response?.headers || {};
  return redactSecrets({
    name: error?.name || "Error",
    message: error?.message || body?.message || String(error || "Unknown error"),
    status: response?.status || error?.status,
    code: body?.code || error?.code,
    correlationId:
      headers["inin-correlation-id"] ||
      headers["ININ-Correlation-Id"] ||
      body?.correlationId,
  });
}

export function profileDefinitionHash(profile) {
  assertTtsConnectorProfile(profile);
  return sha256({
    id: profile.id,
    version: profile.version,
    integrationName: profile.integrationName,
    description: profile.description,
    properties: profile.properties,
    advanced: profile.advanced,
    voiceCatalog: profile.voiceCatalog,
    responseContract: profile.responseContract,
    probe: profile.probe,
  });
}

export function profileConfigFingerprint(profile, credentialId) {
  assertTtsConnectorProfile(profile);
  return sha256({
    profile: `${profile.id}@${profile.version}`,
    properties: profile.properties,
    advanced: profile.advanced,
    credentialId: credentialId || "__NEW_MANAGED_CREDENTIAL__",
  });
}

function normalizedRunId(runId) {
  const id = String(runId || "").trim();
  if (!/^[a-f0-9-]{16,64}$/i.test(id)) {
    throw new Error("A valid run ID is required for managed resource creation");
  }
  return id;
}

export function managedCredentialCreationName(runId) {
  const id = normalizedRunId(runId);
  return `Telnyx TTS managed ${id}`;
}

export function managedIntegrationCreationName(profileId, runId) {
  const profile = getTtsConnectorProfile(profileId);
  if (!profile || profile.status !== "verified") {
    throw new Error(`A verified profile is required for integration creation: ${profileId}`);
  }
  return `Telnyx TTS pending ${profile.id} ${normalizedRunId(runId)}`;
}

export function managedNotes(profile, credentialId) {
  const fingerprint = profileConfigFingerprint(profile, credentialId);
  return (
    `${profile.description}\n` +
    `managed-by=${MANAGED_BY}; profile=${profile.id}@${profile.version}; ` +
    `config-sha256=${fingerprint}`
  );
}

export function parseManagedMarker(notes) {
  const text = String(notes || "");
  const managedBy = text.match(/(?:^|[;\s])managed-by=([^;\s]+)/i)?.[1];
  if (managedBy !== MANAGED_BY) return null;
  const profileMatch = text.match(/(?:^|[;\s])profile=([^@;\s]+)@(\d+)/i);
  const hash = text.match(/(?:^|[;\s])config-sha256=([a-f0-9]{64})/i)?.[1];
  if (!profileMatch || !hash) return { invalid: true, managedBy };
  return {
    managedBy,
    profileId: profileMatch[1],
    profileVersion: Number(profileMatch[2]),
    configSha256: hash,
  };
}

export function markerForInventoryEntry(entry) {
  const integrationMarker = parseManagedMarker(entry.integration?.notes);
  const configMarker = parseManagedMarker(entry.config?.notes);
  if (integrationMarker?.invalid || configMarker?.invalid) return { invalid: true };
  if (integrationMarker && configMarker && canonicalJson(integrationMarker) !== canonicalJson(configMarker)) {
    return { invalid: true, reason: "integration/config managed markers disagree" };
  }
  return integrationMarker || configMarker;
}

function isAllowlistedTelnyxTtsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (
      url.protocol === "https:" &&
      url.origin === TELNYX_API_ORIGIN &&
      url.pathname.startsWith(TELNYX_TTS_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

export function isTelnyxTtsInventoryEntry(entry) {
  if (entry?.integration?.integrationType?.id !== GENESYS_TTS_CONNECTOR_TYPE) return false;
  const marker = markerForInventoryEntry(entry);
  if (marker && !marker.invalid && getTtsConnectorProfile(marker.profileId)) return true;
  const properties = entry?.config?.properties || {};
  return (
    isAllowlistedTelnyxTtsUrl(properties.ttsConnectorVoicesURI) &&
    isAllowlistedTelnyxTtsUrl(properties.ttsConnectorSynthesizeURI)
  );
}

export function profileOwnershipConflicts(inventory, profile, integrationId) {
  return inventory.filter((entry) => {
    if (entry.integration?.id === integrationId) return false;
    const marker = markerForInventoryEntry(entry);
    return (
      marker?.invalid ||
      marker?.profileId === profile.id ||
      entry.integration?.name === profile.integrationName
    );
  });
}

function credentialIdFromConfig(config) {
  return config?.credentials?.[GENESYS_TTS_CREDENTIAL_SLOT]?.id || null;
}

function normalizedProfileProperties(properties, { staticVoices = false } = {}) {
  const normalized = deepClone(properties || {});
  if (
    staticVoices &&
    (normalized.ttsConnectorVoicesURI === null || normalized.ttsConnectorVoicesURI === "")
  ) {
    delete normalized.ttsConnectorVoicesURI;
  }
  return normalized;
}

export function profilePayloadMatches(config, profile) {
  const staticVoices = Array.isArray(profile.advanced?.voices) && profile.advanced.voices.length > 0;
  return (
    canonicalJson(normalizedProfileProperties(config?.properties, { staticVoices })) ===
      canonicalJson(normalizedProfileProperties(profile.properties, { staticVoices })) &&
    canonicalJson(config?.advanced || {}) === canonicalJson(profile.advanced)
  );
}

export function connectorDefinitionMatchesProfile(entry, profile, credentialId) {
  const expectedNotes = managedNotes(profile, credentialId);
  return (
    entry.integration?.integrationType?.id === GENESYS_TTS_CONNECTOR_TYPE &&
    entry.integration?.name === profile.integrationName &&
    entry.integration?.notes === expectedNotes &&
    entry.config?.name === profile.integrationName &&
    entry.config?.notes === expectedNotes &&
    credentialIdFromConfig(entry.config) === credentialId &&
    profilePayloadMatches(entry.config, profile)
  );
}

export function configMatchesProfile(entry, profile, credentialId) {
  return (
    connectorDefinitionMatchesProfile(entry, profile, credentialId) &&
    String(entry.integration?.intendedState || "").toUpperCase() === "ENABLED" &&
    String(entry.integration?.reportedState?.code || "").toUpperCase() === "ACTIVE"
  );
}

export function integrationIsInactive(entry) {
  return (
    String(entry.integration?.intendedState || "").toUpperCase() === "DISABLED" &&
    String(entry.integration?.reportedState?.code || "").toUpperCase() === "INACTIVE"
  );
}

export function classifyInterruptedCreateLookup(result, matches) {
  if (!Array.isArray(matches)) throw new Error("Interrupted create lookup must return an array");
  if (matches.length > 1) return "multiple";
  if (matches.length === 1) return "found";
  return result.createMayHaveSucceeded === false ? "not-created" : "ambiguous";
}

export function classifyAppliedRollbackCandidate({ result, current, profile, credentialId }) {
  const currentHash = inventorySnapshotHash(current);
  if (result.created) {
    if (currentHash === result.afterSnapshotHash) {
      return result.beforeSnapshot ? "restore-created" : "disable-created";
    }
    if (
      result.beforeSnapshot &&
      restorableSnapshotHash(current) === restorableSnapshotHash(result.beforeSnapshot)
    ) {
      return "already-created-original";
    }
    if (
      integrationIsInactive(current) &&
      connectorDefinitionMatchesProfile(current, profile, credentialId)
    ) {
      return result.beforeSnapshot ? "restore-created" : "already-disabled";
    }
    return "drift";
  }
  if (currentHash === result.afterSnapshotHash) return "restore-existing";
  if (
    result.beforeSnapshot &&
    restorableSnapshotHash(current) === restorableSnapshotHash(result.beforeSnapshot)
  ) {
    return "already-original";
  }
  return "drift";
}

export function buildCredentialReference(credential) {
  if (!credential?.id) throw new Error("Genesys credential ID is required");
  return {
    id: credential.id,
    ...(credential.name ? { name: credential.name } : {}),
    ...(credential.type ? { type: deepClone(credential.type) } : {}),
    selfUri:
      credential.selfUri || `/api/v2/integrations/credentials/${credential.id}`,
  };
}

export function buildDesiredConfig({ profile, currentConfig, credential }) {
  assertTtsConnectorProfile(profile);
  const credentialReference = buildCredentialReference(credential);
  const notes = managedNotes(profile, credential.id);
  return {
    id: currentConfig?.id || "current",
    name: profile.integrationName,
    version: currentConfig?.version || 1,
    properties: deepClone(profile.properties),
    advanced: deepClone(profile.advanced),
    notes,
    credentials: {
      [GENESYS_TTS_CREDENTIAL_SLOT]: credentialReference,
    },
  };
}

function rawInventorySnapshot(entry) {
  if (!entry?.integration?.id || !entry?.config) {
    throw new Error("Cannot snapshot an incomplete integration inventory entry");
  }
  return {
    integration: {
      id: entry.integration.id,
      name: entry.integration.name,
      integrationType: deepClone(entry.integration.integrationType),
      notes: entry.integration.notes || "",
      intendedState: entry.integration.intendedState,
    },
    config: {
      id: entry.config.id || "current",
      name: entry.config.name,
      version: entry.config.version,
      properties: deepClone(entry.config.properties || {}),
      advanced: deepClone(entry.config.advanced || {}),
      notes: entry.config.notes || "",
      credentials: deepClone(entry.config.credentials || {}),
    },
  };
}

export function snapshotInventoryEntry(entry) {
  const snapshot = rawInventorySnapshot(entry);
  const redacted = redactSecrets(snapshot);
  if (canonicalJson(snapshot) !== canonicalJson(redacted)) {
    throw new Error(
      `Integration ${entry.integration.id} contains inline secret-like configuration that ` +
        "cannot be stored losslessly in a rollback journal; move secrets to a Genesys credential"
    );
  }
  return snapshot;
}

export function inventorySnapshotHash(entryOrSnapshot) {
  return sha256(rawInventorySnapshot(entryOrSnapshot));
}

export function restorableSnapshotHash(entryOrSnapshot) {
  const snapshot = rawInventorySnapshot(entryOrSnapshot);
  delete snapshot.config.version;
  return sha256(snapshot);
}

export function parseAdoptions(value) {
  const result = {};
  if (!value) return result;
  for (const item of String(value).split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf("=");
    if (separator < 1 || separator === item.length - 1) {
      throw new Error(`Invalid --adopt entry ${item}; expected profile=integration-id`);
    }
    const requestedProfile = item.slice(0, separator).trim();
    const profile = getTtsConnectorProfile(requestedProfile);
    if (!profile || profile.status !== "verified") {
      throw new Error(`Cannot adopt an integration for profile ${requestedProfile}`);
    }
    const integrationId = item.slice(separator + 1).trim();
    if (result[profile.id] && result[profile.id] !== integrationId) {
      throw new Error(`Profile ${profile.id} has more than one adoption target`);
    }
    result[profile.id] = integrationId;
  }
  return result;
}

function candidateManagedEntries(inventory, profileId) {
  return inventory.filter((entry) => markerForInventoryEntry(entry)?.profileId === profileId);
}

function integrationTypeId(entry) {
  return entry.integration?.integrationType?.id;
}

export function buildTtsPlan({
  environment,
  organization,
  integrationType,
  inventory,
  profiles,
  credential,
  adoptions = {},
  now = new Date(),
  planId = randomUUID(),
  maxPlanAgeMs = DEFAULT_MAX_PLAN_AGE_MS,
}) {
  const observedAt = new Date(now);
  const maxInstances = Number(integrationType?.maxInstances || 10);
  const operations = [];
  const conflicts = [];
  const targetedIntegrationIds = new Set();
  const invalidManagedEntries = inventory.filter(
    (entry) => markerForInventoryEntry(entry)?.invalid
  );

  for (const profile of profiles) {
    assertTtsConnectorProfile(profile);
    const managedCandidates = candidateManagedEntries(inventory, profile.id);
    const adoptedId = adoptions[profile.id];
    let target;
    let adopted = false;

    if (adoptedId) {
      target = inventory.find((entry) => entry.integration?.id === adoptedId);
      adopted = true;
      if (!target) {
        conflicts.push({ profileId: profile.id, reason: `Adoption target ${adoptedId} was not found` });
      } else if (integrationTypeId(target) !== GENESYS_TTS_CONNECTOR_TYPE) {
        conflicts.push({ profileId: profile.id, reason: `${adoptedId} is not a Genesys TTS Connector` });
        target = undefined;
      } else {
        const marker = markerForInventoryEntry(target);
        if (marker?.invalid) {
          conflicts.push({ profileId: profile.id, reason: `${adoptedId} has an invalid managed marker` });
          target = undefined;
        } else if (marker && marker.profileId !== profile.id) {
          conflicts.push({
            profileId: profile.id,
            reason: `${adoptedId} is already managed as ${marker.profileId}`,
          });
          target = undefined;
        } else if (!marker && !profilePayloadMatches(target.config, profile)) {
          conflicts.push({
            profileId: profile.id,
            reason:
              `${adoptedId} does not exactly match profile ${profile.id}; ` +
              "the installer does not repurpose unrelated connectors",
          });
          target = undefined;
        }
      }
      const otherManaged = managedCandidates.filter(
        (entry) => entry.integration.id !== adoptedId
      );
      if (otherManaged.length) {
        conflicts.push({
          profileId: profile.id,
          reason: `Another managed connector already exists: ${otherManaged.map((entry) => entry.integration.id).join(", ")}`,
        });
        target = undefined;
      }
    } else if (managedCandidates.length === 1) {
      target = managedCandidates[0];
    } else if (managedCandidates.length > 1) {
      conflicts.push({
        profileId: profile.id,
        reason: `Multiple managed connectors exist: ${managedCandidates.map((entry) => entry.integration.id).join(", ")}`,
      });
    } else {
      const nameConflicts = inventory.filter(
        (entry) => entry.integration?.name === profile.integrationName
      );
      if (nameConflicts.length) {
        conflicts.push({
          profileId: profile.id,
          reason: `Unmanaged connector already uses name ${profile.integrationName}; use --adopt=${profile.id}=<integration-id>`,
        });
      }
    }

    if (target && targetedIntegrationIds.has(target.integration.id)) {
      conflicts.push({
        profileId: profile.id,
        reason: `Integration ${target.integration.id} is targeted by more than one profile`,
      });
      target = undefined;
    }
    const targetMarker = target ? markerForInventoryEntry(target) : null;
    if (targetMarker?.profileVersion > profile.version) {
      conflicts.push({
        profileId: profile.id,
        reason:
          `Integration ${target.integration.id} uses future profile version ` +
          `${targetMarker.profileVersion}; refusing downgrade to ${profile.version}`,
      });
      target = undefined;
    }
    if (target) {
      const duplicateNames = inventory.filter(
        (entry) =>
          entry.integration?.name === profile.integrationName &&
          entry.integration?.id !== target.integration.id
      );
      if (duplicateNames.length) {
        conflicts.push({
          profileId: profile.id,
          reason:
            `Another connector already uses name ${profile.integrationName}: ` +
            duplicateNames.map((entry) => entry.integration.id).join(", "),
        });
        target = undefined;
      }
    }
    if (target) targetedIntegrationIds.add(target.integration.id);

    const profileConflicts = conflicts.filter((conflict) => conflict.profileId === profile.id);
    if (profileConflicts.length) {
      operations.push({
        profileId: profile.id,
        profileVersion: profile.version,
        profileDefinitionHash: profileDefinitionHash(profile),
        action: "CONFLICT",
        reasons: profileConflicts.map((conflict) => conflict.reason),
      });
      continue;
    }

    const desiredConfigHash = profileConfigFingerprint(profile, credential.id);
    if (!target) {
      operations.push({
        profileId: profile.id,
        profileVersion: profile.version,
        profileDefinitionHash: profileDefinitionHash(profile),
        action: "CREATE",
        integrationId: null,
        expectedSnapshotHash: null,
        expectedConfigVersion: null,
        desiredConfigHash,
        requiresDowntime: false,
      });
      continue;
    }

    const isNoop =
      credential.mode === "existing" &&
      configMatchesProfile(target, profile, credential.id);
    operations.push({
      profileId: profile.id,
      profileVersion: profile.version,
      profileDefinitionHash: profileDefinitionHash(profile),
      action: isNoop ? "NOOP" : "UPDATE",
      integrationId: target.integration.id,
      expectedSnapshotHash: inventorySnapshotHash(target),
      expectedConfigVersion: target.config.version,
      desiredConfigHash,
      requiresDowntime: !isNoop && String(target.integration.intendedState).toUpperCase() === "ENABLED",
      adopted,
    });
  }

  const createCount = operations.filter((operation) => operation.action === "CREATE").length;
  const freeSlots = Math.max(0, maxInstances - inventory.length);
  const blockers = [];
  if (createCount > freeSlots) {
    blockers.push(
      `Plan needs ${createCount} new connector slot(s), but only ${freeSlots} of ${maxInstances} are free`
    );
    for (const operation of operations) {
      if (operation.action === "CREATE") {
        operation.action = "BLOCKED";
        operation.reasons = ["Genesys TTS Connector instance limit would be exceeded"];
      }
    }
  }
  if (conflicts.length) blockers.push(`${conflicts.length} connector conflict(s) must be resolved`);
  if (invalidManagedEntries.length) {
    const invalidIds = invalidManagedEntries.map((entry) => entry.integration.id).join(", ");
    blockers.push(
      `Inventory contains invalid or inconsistent managed marker(s): ${invalidIds}; ` +
        "repair them before planning any managed connector change"
    );
    for (const operation of operations) {
      if (operation.action === "CONFLICT") continue;
      operation.action = "BLOCKED";
      operation.reasons = [
        ...(operation.reasons || []),
        `Invalid managed marker exists on integration(s): ${invalidIds}`,
      ];
    }
  }

  return {
    schemaVersion: TTS_PLAN_SCHEMA_VERSION,
    toolVersion: TTS_MANAGER_VERSION,
    planId,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + maxPlanAgeMs).toISOString(),
    environment,
    organization: {
      id: organization.id,
      name: organization.name,
    },
    integrationType: {
      id: GENESYS_TTS_CONNECTOR_TYPE,
      maxInstances,
    },
    inventory: {
      total: inventory.length,
      freeSlots,
    },
    credential: redactSecrets(deepClone(credential)),
    adoptions: deepClone(adoptions),
    operations,
    blockers,
  };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assertPlanShape(plan) {
  const observedAt = Date.parse(plan.observedAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)) {
    throw new Error("Plan has an invalid observedAt or expiresAt timestamp");
  }
  const planLifetime = expiresAt - observedAt;
  if (planLifetime !== DEFAULT_MAX_PLAN_AGE_MS) {
    throw new Error(`Plan lifetime must be exactly ${DEFAULT_MAX_PLAN_AGE_MS} ms`);
  }
  if (!plan.planId || typeof plan.planId !== "string") throw new Error("Plan ID is missing");
  if (plan.integrationType?.id !== GENESYS_TTS_CONNECTOR_TYPE) {
    throw new Error(`Unexpected integration type ${plan.integrationType?.id}`);
  }
  if (
    !Number.isInteger(plan.integrationType.maxInstances) ||
    plan.integrationType.maxInstances < 1 ||
    !Number.isInteger(plan.inventory?.total) ||
    plan.inventory.total < 0 ||
    !Number.isInteger(plan.inventory?.freeSlots) ||
    plan.inventory.freeSlots < 0
  ) {
    throw new Error("Plan has invalid integration limit or inventory counts");
  }
  if (!Array.isArray(plan.blockers) || !Array.isArray(plan.operations) || !plan.operations.length) {
    throw new Error("Plan must contain operations and a blockers array");
  }
  if (!plan.credential || !["existing", "create"].includes(plan.credential.mode)) {
    throw new Error("Plan has an invalid credential mode");
  }
  if (plan.credential.type !== "userDefined") {
    throw new Error("Plan credential must have type userDefined");
  }
  if (plan.credential.mode === "existing" && !String(plan.credential.id || "").trim()) {
    throw new Error("Existing plan credential has no ID");
  }
  if (
    plan.credential.mode === "create" &&
    (plan.credential.id !== null || !String(plan.credential.name || "").trim())
  ) {
    throw new Error("New plan credential must have a name and a null ID");
  }
  if (canonicalJson(plan.credential) !== canonicalJson(redactSecrets(plan.credential))) {
    throw new Error("Plan credential unexpectedly contains secret material");
  }
  if (!plan.adoptions || Array.isArray(plan.adoptions) || typeof plan.adoptions !== "object") {
    throw new Error("Plan adoptions must be an object");
  }

  const profileIds = new Set();
  const integrationIds = new Set();
  for (const operation of plan.operations) {
    if (!operation || !["CREATE", "UPDATE", "NOOP", "CONFLICT", "BLOCKED"].includes(operation.action)) {
      throw new Error(`Plan has an invalid operation action ${operation?.action}`);
    }
    if (!operation.profileId || profileIds.has(operation.profileId)) {
      throw new Error(`Plan has a missing or duplicate profile ${operation.profileId}`);
    }
    profileIds.add(operation.profileId);
    if (!Number.isInteger(operation.profileVersion) || operation.profileVersion < 1) {
      throw new Error(`Plan has an invalid profile version for ${operation.profileId}`);
    }
    if (!SHA256_PATTERN.test(String(operation.profileDefinitionHash || ""))) {
      throw new Error(`Plan has an invalid profile definition hash for ${operation.profileId}`);
    }
    if (["CONFLICT", "BLOCKED"].includes(operation.action)) continue;
    if (!SHA256_PATTERN.test(String(operation.desiredConfigHash || ""))) {
      throw new Error(`Plan has an invalid desired config hash for ${operation.profileId}`);
    }
    if (typeof operation.requiresDowntime !== "boolean") {
      throw new Error(`Plan has an invalid downtime flag for ${operation.profileId}`);
    }
    if (operation.action === "CREATE") {
      if (
        operation.integrationId !== null ||
        operation.expectedSnapshotHash !== null ||
        operation.expectedConfigVersion !== null
      ) {
        throw new Error(`CREATE fields are inconsistent for ${operation.profileId}`);
      }
      continue;
    }
    if (!String(operation.integrationId || "").trim() || integrationIds.has(operation.integrationId)) {
      throw new Error(`Plan has a missing or duplicate target integration ${operation.integrationId}`);
    }
    integrationIds.add(operation.integrationId);
    if (!SHA256_PATTERN.test(String(operation.expectedSnapshotHash || ""))) {
      throw new Error(`Plan has an invalid snapshot hash for ${operation.profileId}`);
    }
    if (!Number.isInteger(operation.expectedConfigVersion) || operation.expectedConfigVersion < 0) {
      throw new Error(`Plan has an invalid config version for ${operation.profileId}`);
    }
    if (operation.action === "NOOP" && plan.credential.mode !== "existing") {
      throw new Error("A NOOP operation cannot use a newly created credential");
    }
  }

  for (const [profileId, integrationId] of Object.entries(plan.adoptions)) {
    const operation = plan.operations.find((candidate) => candidate.profileId === profileId);
    if (
      !operation ||
      !operation.adopted ||
      operation.integrationId !== integrationId ||
      !integrationIds.has(integrationId)
    ) {
      throw new Error(`Adoption ${profileId}=${integrationId} is inconsistent with plan operations`);
    }
  }
  for (const operation of plan.operations) {
    if (operation.adopted && plan.adoptions[operation.profileId] !== operation.integrationId) {
      throw new Error(`Operation ${operation.profileId} has an inconsistent adoption marker`);
    }
  }
  return { observedAt, expiresAt };
}

export function planApplyIntent(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    toolVersion: plan.toolVersion,
    planId: plan.planId,
    environment: plan.environment,
    organizationId: plan.organization?.id,
    integrationType: plan.integrationType,
    inventory: plan.inventory,
    credential: plan.credential,
    adoptions: plan.adoptions,
    operations: plan.operations,
    blockers: plan.blockers,
  };
}

export function assertApplicablePlan(plan, { environment, organizationId, now = new Date() }) {
  if (plan?.schemaVersion !== TTS_PLAN_SCHEMA_VERSION) {
    throw new Error(`Unsupported plan schema version: ${plan?.schemaVersion}`);
  }
  if (plan.toolVersion !== TTS_MANAGER_VERSION) {
    throw new Error(`Plan was created by tool ${plan.toolVersion}; current version is ${TTS_MANAGER_VERSION}`);
  }
  const { observedAt, expiresAt } = assertPlanShape(plan);
  if (plan.environment !== environment) {
    throw new Error(`Plan targets ${plan.environment}, not ${environment}`);
  }
  if (plan.organization?.id !== organizationId) {
    throw new Error(`Plan targets organization ${plan.organization?.id}, not ${organizationId}`);
  }
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs) || nowMs >= expiresAt) {
    throw new Error(`Plan expired at ${plan.expiresAt}; generate a fresh plan`);
  }
  if (observedAt - nowMs > 5 * 60 * 1000) {
    throw new Error(`Plan observedAt ${plan.observedAt} is unreasonably far in the future`);
  }
  if (plan.blockers?.length || plan.operations.some((operation) => ["CONFLICT", "BLOCKED"].includes(operation.action))) {
    throw new Error("Plan contains conflicts or blockers and cannot be applied");
  }
  for (const operation of plan.operations) {
    const profile = getTtsConnectorProfile(operation.profileId);
    if (!profile || profile.status !== "verified") {
      throw new Error(`Plan references unavailable or blocked profile ${operation.profileId}`);
    }
    if (
      profile.version !== operation.profileVersion ||
      profileDefinitionHash(profile) !== operation.profileDefinitionHash
    ) {
      throw new Error(`Profile ${profile.id} changed after this plan was created`);
    }
    if (
      !["CONFLICT", "BLOCKED"].includes(operation.action) &&
      profileConfigFingerprint(profile, plan.credential.id) !== operation.desiredConfigHash
    ) {
      throw new Error(`Desired config hash is invalid for profile ${profile.id}`);
    }
  }
  return plan;
}
