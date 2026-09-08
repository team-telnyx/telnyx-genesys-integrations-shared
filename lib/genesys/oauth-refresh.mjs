import { createHash } from "node:crypto";

const refreshesInFlight = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function refreshKey(refreshToken) {
  return createHash("sha256").update(refreshToken).digest("hex");
}

async function requestRefreshedGenesysTokens(refreshToken, {
  clientId = process.env.GC_CLIENT_ID,
  clientSecret = process.env.GC_CLIENT_SECRET,
  environment = process.env.GC_ENVIRONMENT || "mypurecloud.com",
  fetchImpl = fetch,
} = {}) {
  const normalizedRefreshToken = String(refreshToken || "").trim();
  const normalizedClientId = String(clientId || "").trim();
  if (!normalizedRefreshToken) throw new Error("Genesys refresh token is missing");
  if (!normalizedClientId) throw new Error("GC_CLIENT_ID is not configured");

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: normalizedRefreshToken,
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${normalizedClientId}:${clientSecret}`).toString("base64")}`;
  } else {
    params.set("client_id", normalizedClientId);
  }

  const response = await fetchImpl(`https://login.${environment}/oauth/token`, {
    method: "POST",
    headers,
    body: params,
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const error = new Error("Genesys refresh token was rejected");
    error.status = response.status;
    error.code = body.code || body.error || null;
    throw error;
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || normalizedRefreshToken,
    accessTokenMaxAge: positiveInteger(body.expires_in, 3600),
  };
}

export function refreshGenesysTokens(refreshToken, options = {}) {
  const normalizedRefreshToken = String(refreshToken || "").trim();
  if (!normalizedRefreshToken) return requestRefreshedGenesysTokens(refreshToken, options);

  const key = refreshKey(normalizedRefreshToken);
  const current = refreshesInFlight.get(key);
  if (current) return current;

  const pending = requestRefreshedGenesysTokens(normalizedRefreshToken, options)
    .finally(() => refreshesInFlight.delete(key));
  refreshesInFlight.set(key, pending);
  return pending;
}
