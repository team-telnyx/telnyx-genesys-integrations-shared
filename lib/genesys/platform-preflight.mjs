import platformClient from "purecloud-platform-client-v2";

import {
  hardenGenesysSdkClient,
  normalizeGenesysEnvironment,
  readWithRetry,
} from "./tts-connector-genesys.mjs";

const TELNYX_API_ORIGIN = "https://api.telnyx.com";
const TELNYX_CAPABILITY_PATHS = Object.freeze({
  tts: "/v2/text-to-speech/voices?provider=telnyx",
  audio: "/v2/ai/assistants?page%5Bsize%5D=1",
  widget: "/v2/ai/assistants?page%5Bsize%5D=1",
});

function responseStatus(error) {
  return Number(error?.response?.status || error?.status || 0);
}

export function platformAccessError(error, service) {
  const status = responseStatus(error);
  if (status === 401 || status === 403) {
    return new Error(`${service} rejected the supplied credentials (HTTP ${status})`);
  }
  const message = String(error?.message || error || `${service} access check failed`)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
  return new Error(message, { cause: error });
}

function genesysClientCredentialsGrantError(error) {
  const status = responseStatus(error);
  if (status === 400 || status === 401) {
    return new Error(
      `Genesys Cloud rejected the Client Credentials OAuth grant (HTTP ${status}). ` +
      "Use an OAuth client whose grant type is CLIENT-CREDENTIALS and verify that its client secret matches. " +
      "A Code Authorization OAuth client cannot be used for this step.",
      { cause: error }
    );
  }
  return platformAccessError(error, "Genesys Cloud");
}

function genesysOrganizationAccessError(error) {
  const status = responseStatus(error);
  if (status === 403) {
    return new Error(
      "Genesys Cloud authenticated the Client Credentials OAuth client, but it cannot read the organization " +
      "(HTTP 403). Assign the required Organization permission to the role used by this OAuth client.",
      { cause: error }
    );
  }
  return platformAccessError(error, "Genesys Cloud");
}

export async function verifyGenesysPlatformAccess({
  environment,
  clientId,
  clientSecret,
  sdk = platformClient,
} = {}) {
  const normalizedEnvironment = normalizeGenesysEnvironment(environment, sdk);
  const apiClient = sdk.ApiClient.instance;
  hardenGenesysSdkClient(apiClient);
  apiClient.setEnvironment(normalizedEnvironment);
  apiClient.timeout = 30_000;
  let auth;
  try {
    auth = await apiClient.loginClientCredentialsGrant(
      String(clientId || "").trim(),
      String(clientSecret || "").trim()
    );
  } catch (error) {
    throw genesysClientCredentialsGrantError(error);
  }
  const accessToken = auth?.accessToken || apiClient.authData?.accessToken;
  if (!accessToken) throw new Error("Genesys access token was not returned");
  try {
    const organization = await readWithRetry(() => new sdk.OrganizationApi().getOrganizationsMe());
    if (!organization?.id || !organization?.name) {
      throw new Error("Genesys organization details were not returned");
    }
    return { environment: normalizedEnvironment, organization };
  } catch (error) {
    throw genesysOrganizationAccessError(error);
  }
}

async function telnyxRequest(pathname, apiKey, fetchImpl, timeoutMs) {
  const url = new URL(pathname, TELNYX_API_ORIGIN);
  if (url.origin !== TELNYX_API_ORIGIN || url.protocol !== "https:") {
    throw new Error("Refusing to call an unexpected Telnyx API origin");
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = new Error(`Telnyx API access check failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  await response.body?.cancel?.();
  return response;
}

export async function verifyTelnyxPlatformAccess({
  apiKey,
  capability,
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  const normalizedKey = String(apiKey || "").trim();
  if (!normalizedKey) throw new Error("TELNYX_API_KEY is required");
  const capabilityPath = TELNYX_CAPABILITY_PATHS[capability];
  if (!capabilityPath) throw new Error(`Unsupported Telnyx preflight capability ${capability}`);
  try {
    await telnyxRequest("/v2/balance", normalizedKey, fetchImpl, timeoutMs);
    await telnyxRequest(capabilityPath, normalizedKey, fetchImpl, timeoutMs);
    return { capability };
  } catch (error) {
    throw platformAccessError(error, "Telnyx API");
  }
}
