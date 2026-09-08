import { normalizeGenesysDid } from "./sip-destination.mjs";

export const WIDGET_VOICE_ROUTE_MARKER = "Managed by genesys:widget";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isDidPoolPropagationError(error) {
  return error?.code === "general.bad.request" &&
    (error?.details || []).some((detail) => detail?.errorCode === "DID_POOL_REQUIRED");
}

async function createIvrAfterDidPoolPropagation(architectApi, body, {
  attempts = 6,
  delayMs = 1_000,
} = {}) {
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

async function listIvrs(architectApi) {
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

function sameSingleDidPool(pool, phoneNumber) {
  try {
    return normalizeGenesysDid(pool.startPhoneNumber) === phoneNumber &&
      normalizeGenesysDid(pool.endPhoneNumber) === phoneNumber;
  } catch {
    return false;
  }
}

export async function ensureWidgetVoiceDidPool({
  telephonyApi,
  didPools,
  didPoolId,
  name,
  phoneNumber,
  deploymentId,
}) {
  const did = normalizeGenesysDid(phoneNumber);
  const pools = Array.isArray(didPools) ? didPools : [];
  let existing = didPoolId
    ? pools.find((pool) => pool.id === didPoolId)
    : pools.find((pool) => sameSingleDidPool(pool, did));
  if (didPoolId && telephonyApi.getTelephonyProvidersEdgesDidpool) {
    existing = await telephonyApi.getTelephonyProvidersEdgesDidpool(didPoolId).catch(() => existing);
  }
  if (existing) {
    const description = String(existing.description || existing.comments || "");
    const owned = description.includes(WIDGET_VOICE_ROUTE_MARKER) &&
      description.includes(`deployment ${deploymentId}`);
    if (!sameSingleDidPool(existing, did) || !owned || (existing.name && existing.name !== name)) {
      throw new Error(
        `Genesys DID ${did} is already owned by pool ${existing.name || existing.id}; refusing to adopt it`
      );
    }
    return { didPool: existing, created: false };
  }
  const didPool = await telephonyApi.postTelephonyProvidersEdgesDidpools({
    name,
    description: `${WIDGET_VOICE_ROUTE_MARKER}; deployment ${deploymentId}; single synthetic routing DID`,
    startPhoneNumber: did,
    endPhoneNumber: did,
    provider: "PURE_CLOUD",
  });
  if (!didPool?.id) throw new Error("Genesys did not return the created DID pool ID");
  return { didPool, created: true };
}

export async function ensureWidgetVoiceIvrRoute({
  architectApi,
  ivrId,
  name,
  phoneNumber,
  flow,
  deploymentId,
}) {
  const did = normalizeGenesysDid(phoneNumber);
  const ivrs = await listIvrs(architectApi);
  const existing = ivrId
    ? ivrs.find((ivr) => ivr.id === ivrId)
    : ivrs.find((ivr) => ivr.name === name || (ivr.dnis || []).includes(did));
  if (existing && existing.name !== name) {
    throw new Error(
      `Genesys DID ${did} is already assigned to inbound route ${existing.name}; refusing to replace it`
    );
  }
  const body = {
    name,
    description: `${WIDGET_VOICE_ROUTE_MARKER}; deployment ${deploymentId}; routes the synthetic DID to ${flow.name}`,
    dnis: [did],
    openHoursFlow: { id: flow.id, name: flow.name },
  };
  const ivr = existing
    ? await architectApi.putArchitectIvr(existing.id, body)
    : await createIvrAfterDidPoolPropagation(architectApi, body);
  if (!ivr?.id) throw new Error("Genesys did not return the inbound call route ID");
  return { ivr, created: !existing };
}
