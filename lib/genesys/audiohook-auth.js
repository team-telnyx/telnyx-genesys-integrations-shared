import { createHmac, timingSafeEqual } from "node:crypto";

function header(request, name) {
  return request?.headers?.get?.(name) || "";
}

function parseSignatureInput(value) {
  const match = String(value || "").match(
    /^([A-Za-z0-9_-]+)=(\([^)]*\)(?:;[^;=]+=(?:"[^"]*"|[^;]+))*)$/
  );
  if (!match) return null;
  const [, label, signatureParams] = match;
  const componentMatch = signatureParams.match(/^\(([^)]*)\)/);
  if (!componentMatch) return null;
  const components = [...componentMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  const attributes = {};
  for (const item of signatureParams.slice(componentMatch[0].length).split(";")) {
    if (!item) continue;
    const index = item.indexOf("=");
    if (index < 1) continue;
    const key = item.slice(0, index);
    const rawValue = item.slice(index + 1);
    attributes[key] = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  }
  return { label, signatureParams, components, attributes };
}

function parseSignature(value, label) {
  const entries = String(value || "").split(",");
  for (const entry of entries) {
    const match = entry.trim().match(/^([A-Za-z0-9_-]+)=:([^:]+):$/);
    if (match?.[1] === label) return match[2];
  }
  return null;
}

function authority(request) {
  return header(request, "host") || new URL(request.url).host;
}

function requestTarget(request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function signatureBase(request, parsed) {
  const lines = parsed.components.map((component) => {
    if (component === "@request-target") {
      return `"@request-target": ${requestTarget(request)}`;
    }
    if (component === "@authority") {
      return `"@authority": ${authority(request)}`;
    }
    return `"${component}": ${header(request, component)}`;
  });
  lines.push(`"@signature-params": ${parsed.signatureParams}`);
  return lines.join("\n");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyGenesysAudioHookRequest(
  request,
  {
    apiKey = process.env.GC_AUDIO_CONNECTOR_API_KEY,
    clientSecret = process.env.GC_AUDIO_CONNECTOR_CLIENT_SECRET,
    now = Date.now(),
    clockSkewSeconds = 30,
  } = {}
) {
  const presentedApiKey = header(request, "x-api-key");
  if (!apiKey || !presentedApiKey || !safeEqual(presentedApiKey, apiKey)) {
    return { ok: false, error: "Invalid AudioHook API key" };
  }

  if (!clientSecret) {
    return { ok: false, error: "AudioHook client secret is not configured" };
  }

  const parsed = parseSignatureInput(header(request, "signature-input"));
  if (!parsed || parsed.attributes.alg !== "hmac-sha256") {
    return { ok: false, error: "Invalid AudioHook signature input" };
  }
  if (parsed.attributes.keyid !== presentedApiKey || !parsed.attributes.nonce) {
    return { ok: false, error: "Invalid AudioHook signature identity" };
  }

  const requiredComponents = [
    "@request-target",
    "audiohook-session-id",
    "audiohook-organization-id",
    "audiohook-correlation-id",
    "x-api-key",
    "@authority",
  ];
  if (!requiredComponents.every((component) => parsed.components.includes(component))) {
    return { ok: false, error: "AudioHook signature is missing required components" };
  }

  const nowSeconds = Math.floor(now / 1000);
  const created = Number(parsed.attributes.created);
  const expires = Number(parsed.attributes.expires);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    created > nowSeconds + clockSkewSeconds ||
    expires < nowSeconds - clockSkewSeconds
  ) {
    return { ok: false, error: "AudioHook signature is outside its validity window" };
  }

  const signatureValue = parseSignature(header(request, "signature"), parsed.label);
  if (!signatureValue) {
    return { ok: false, error: "AudioHook signature is missing" };
  }

  let expected;
  let actual;
  try {
    expected = createHmac("sha256", Buffer.from(clientSecret, "base64"))
      .update(signatureBase(request, parsed))
      .digest();
    actual = Buffer.from(signatureValue, "base64");
  } catch {
    return { ok: false, error: "AudioHook signature could not be decoded" };
  }

  if (!safeEqual(actual, expected)) {
    return { ok: false, error: "AudioHook signature mismatch" };
  }

  return {
    ok: true,
    apiKey: presentedApiKey,
    sessionId: header(request, "audiohook-session-id"),
    organizationId: header(request, "audiohook-organization-id"),
    correlationId: header(request, "audiohook-correlation-id"),
  };
}
