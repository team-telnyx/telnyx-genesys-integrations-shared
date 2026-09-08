import { normalizeGenesysDid } from "./sip-destination.mjs";
import { listGenesysDidNumbers } from "./did-inventory.mjs";

export const AUDIO_CALL_ROUTE_MARKER = "Managed by genesys:audio";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isDidPoolPropagationError(error) {
  return error?.code === "general.bad.request" &&
    (error?.details || []).some((detail) => detail?.errorCode === "DID_POOL_REQUIRED");
}

async function createAfterDidPropagation(architectApi, body, { attempts = 6, delayMs = 1_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await architectApi.postArchitectIvrs(body);
    } catch (error) {
      lastError = error;
      if (!isDidPoolPropagationError(error) || attempt === attempts) throw error;
      await wait(delayMs * attempt);
    }
  }
  throw lastError;
}

export async function listAudioCallRoutes(architectApi) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await architectApi.getArchitectIvrs({
      pageNumber,
      pageSize: 100,
      sortBy: "name",
      sortOrder: "ASC",
      expand: ["dnis"],
    });
    entries.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error("Genesys inbound call route pagination exceeded 100 pages");
}

function managedDescription(deploymentId) {
  return `${AUDIO_CALL_ROUTE_MARKER}; deployment ${deploymentId}`;
}

function isManagedRoute(route, deploymentId) {
  return String(route?.description || "").includes(managedDescription(deploymentId));
}

function routeUpdateBody(route, dnis) {
  const body = {
    name: route.name,
    description: route.description || "",
    dnis,
  };
  for (const key of ["openHoursFlow", "closedHoursFlow", "holidayHoursFlow", "scheduleGroup"]) {
    if (route[key]?.id) body[key] = { id: route[key].id, name: route[key].name };
  }
  return body;
}

function contactMatchesDid(contact, dnis) {
  const expectedDigits = normalizeGenesysDid(dnis).replace(/\D/g, "");
  return [contact?.address, contact?.display].some((value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return digits && digits === expectedDigits;
  });
}

async function releaseDirectDidOwner(usersApi, takeover) {
  if (String(takeover.ownerType || "").toUpperCase() !== "USER") {
    throw new Error(
      `Automatic reassignment of Genesys DID ${takeover.dnis} from ${takeover.ownerType || "this assignee type"} is not supported`
    );
  }
  if (!usersApi?.getUser || !usersApi?.patchUser) {
    throw new Error("Genesys Users API is required to reassign a DID from a person");
  }
  const user = await usersApi.getUser(takeover.ownerId);
  const addresses = Array.isArray(user.addresses) ? user.addresses : [];
  const primaryContactInfo = Array.isArray(user.primaryContactInfo) ? user.primaryContactInfo : [];
  if (!addresses.some((contact) => contactMatchesDid(contact, takeover.dnis))) {
    throw new Error("Genesys DID ownership changed after plan review; refresh the plan before deployment");
  }
  const updated = await usersApi.patchUser(takeover.ownerId, {
    version: user.version,
    addresses: addresses.filter((contact) => !contactMatchesDid(contact, takeover.dnis)),
    primaryContactInfo: primaryContactInfo.filter((contact) => !contactMatchesDid(contact, takeover.dnis)),
  });
  return {
    takeover,
    addresses,
    primaryContactInfo,
    version: updated?.version,
  };
}

async function restoreDirectDidOwner(usersApi, released) {
  const current = await usersApi.getUser(released.takeover.ownerId);
  await usersApi.patchUser(released.takeover.ownerId, {
    version: current.version,
    addresses: released.addresses,
    primaryContactInfo: released.primaryContactInfo,
  });
}

function publicTakeover(conflict) {
  return {
    dnis: conflict.dnis,
    routeId: conflict.route.id,
    routeName: conflict.route.name || conflict.route.id,
    routeDnis: (conflict.route.dnis || []).map((value) => normalizeGenesysDid(value)),
  };
}

export function resolveAudioCallRoute({
  ivrs = [],
  ivrId,
  name,
  dnis = [],
  deploymentId,
  takeoverDnis = [],
  expectedTakeovers = null,
}) {
  const routeName = String(name || "").trim();
  const targetDnis = [...new Set(dnis.map((value) => normalizeGenesysDid(value)))];
  if (!routeName) throw new Error("Audio Connector call route name is required");
  if (!targetDnis.length) throw new Error("Audio Connector call route requires at least one DNIS");
  const byId = ivrId ? ivrs.find((route) => route.id === ivrId) : null;
  const byName = ivrs.find((route) => route.name === routeName);
  if (ivrId && !byId) {
    throw new Error(`Managed Genesys call route ${routeName} (${ivrId}) no longer exists`);
  }
  const existing = byId || byName || null;
  if (existing && existing.name !== routeName) {
    throw new Error(`Managed Genesys call route ${existing.id} changed name to ${existing.name}`);
  }
  if (existing && !isManagedRoute(existing, deploymentId)) {
    throw new Error(`Genesys call route ${routeName} exists but is not owned by this deployment`);
  }
  const approvedTakeovers = new Set(takeoverDnis.map((value) => normalizeGenesysDid(value)));
  const conflicts = [];
  for (const route of ivrs) {
    if (route.id === existing?.id) continue;
    const assigned = new Set((route.dnis || []).map((value) => normalizeGenesysDid(value)));
    for (const conflict of targetDnis.filter((value) => assigned.has(value))) {
      if (!approvedTakeovers.has(conflict)) {
        throw new Error(`Genesys DID ${conflict} is already assigned to call route ${route.name || route.id}`);
      }
      conflicts.push({ dnis: conflict, route });
    }
  }
  const takeovers = conflicts.map(publicTakeover);
  if (Array.isArray(expectedTakeovers)) {
    const snapshotKey = (entry) => [
      normalizeGenesysDid(entry.dnis),
      entry.routeId,
      [...new Set((entry.routeDnis || []).map((value) => normalizeGenesysDid(value)))].sort().join(","),
    ].join("|");
    const expected = new Set(expectedTakeovers.map(snapshotKey));
    const actual = new Set(takeovers.map(snapshotKey));
    if (expected.size !== actual.size || [...expected].some((entry) => !actual.has(entry))) {
      throw new Error("Genesys DID ownership changed after plan review; refresh the plan before deployment");
    }
  }
  return {
    existing,
    dnis: targetDnis,
    operation: existing ? "UPDATE" : "CREATE",
    conflicts,
    takeovers,
  };
}

export async function ensureAudioCallRoute({
  architectApi,
  telephonyApi,
  usersApi,
  ivrId,
  name,
  dnis,
  flow,
  deploymentId,
  takeovers = [],
  ownerTakeovers = [],
}) {
  if (!flow?.id || !flow?.name) throw new Error("Published Architect flow is required for the call route");
  if (ownerTakeovers.length) {
    const currentDids = new Map(
      (await listGenesysDidNumbers(telephonyApi)).map((did) => [did.dnis, did])
    );
    for (const expected of ownerTakeovers) {
      const current = currentDids.get(normalizeGenesysDid(expected.dnis));
      const owner = current?.owner;
      if (
        !current || current.id !== expected.didId || !owner || owner.id !== expected.ownerId ||
        String(owner.type || "UNKNOWN") !== String(expected.ownerType || "UNKNOWN")
      ) {
        throw new Error("Genesys DID ownership changed after plan review; refresh the plan before deployment");
      }
    }
  }
  const resolution = resolveAudioCallRoute({
    ivrs: await listAudioCallRoutes(architectApi),
    ivrId,
    name,
    dnis,
    deploymentId,
    takeoverDnis: takeovers.map((entry) => entry.dnis),
    expectedTakeovers: takeovers,
  });
  const body = {
    name,
    description: `${managedDescription(deploymentId)}; routes selected DNIS values to ${flow.name}`,
    dnis: resolution.dnis,
    openHoursFlow: { id: flow.id, name: flow.name },
  };
  const sourceRoutes = new Map(resolution.conflicts.map(({ route }) => [route.id, route]));
  const updatedSources = [];
  const releasedOwners = [];
  let route;
  try {
    for (const takeover of ownerTakeovers) {
      releasedOwners.push(await releaseDirectDidOwner(usersApi, takeover));
    }
    for (const source of sourceRoutes.values()) {
      const claimed = new Set(resolution.conflicts
        .filter(({ route: conflictRoute }) => conflictRoute.id === source.id)
        .map(({ dnis: conflictDnis }) => conflictDnis));
      const remaining = (source.dnis || [])
        .map((value) => normalizeGenesysDid(value))
        .filter((value) => !claimed.has(value));
      await architectApi.putArchitectIvr(source.id, routeUpdateBody(source, remaining));
      updatedSources.push(source);
    }
    route = resolution.existing
      ? await architectApi.putArchitectIvr(resolution.existing.id, body)
      : await createAfterDidPropagation(architectApi, body);
  } catch (error) {
    const rollbackErrors = [];
    for (const source of updatedSources.reverse()) {
      try {
        await architectApi.putArchitectIvr(
          source.id,
          routeUpdateBody(source, (source.dnis || []).map((value) => normalizeGenesysDid(value)))
        );
      } catch (rollbackError) {
        rollbackErrors.push(`${source.name || source.id}: ${rollbackError.message || rollbackError}`);
      }
    }
    for (const released of releasedOwners.reverse()) {
      try {
        await restoreDirectDidOwner(usersApi, released);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${released.takeover.ownerName || released.takeover.ownerId}: ${rollbackError.message || rollbackError}`
        );
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message || error}; failed to restore previous call routes: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
  if (!route?.id) throw new Error("Genesys did not return the inbound call route ID");
  return {
    route,
    created: !resolution.existing,
    takeovers: resolution.takeovers,
    ownerTakeovers,
  };
}
