import { createHmac, timingSafeEqual } from "node:crypto";

function header(request, name) {
  return request?.headers?.get?.(name) || "";
}

/**
 * Parse an RFC 9421 Signature-Input header.
 *
 * Split and scanned rather than matched against one shape. The single
 * validating regex this replaces ended in
 * `(?:;[^;=]+=(?:"[^"]*"|[^;]+))*`, whose alternation can match a quoted
 * value two ways — as `"[^"]*"` or as `[^;]+` — so a failing input made the
 * engine try 2^n splits. 26 segments, 161 bytes, blocked the event loop for
 * 2.2 seconds, and every two further segments multiplied that by four.
 *
 * This header arrives from the network and is parsed BEFORE the signature is
 * verified, on the same process that serves the AudioHook WebSocket and every
 * HTTP route. Nothing here may be superlinear in the length of the input.
 */
function parseSignatureInput(value) {
  const input = String(value || "");

  const labelEnd = input.indexOf("=");
  if (labelEnd < 1) return null;
  const label = input.slice(0, labelEnd);
  // A single character class over the whole string: linear, and it cannot
  // backtrack because there is nothing to backtrack into.
  if (!/^[A-Za-z0-9_-]+$/.test(label)) return null;

  const signatureParams = input.slice(labelEnd + 1);
  if (!signatureParams.startsWith("(")) return null;
  const close = signatureParams.indexOf(")");
  if (close < 0) return null;

  const components = [...signatureParams.slice(1, close).matchAll(/"([^"]+)"/g)].map((item) => item[1]);

  const attributes = {};
  const rest = signatureParams.slice(close + 1);
  if (rest) {
    // The old pattern demanded the remainder be a run of `;key=value` and
    // rejected anything else; that strictness is kept, one segment at a time.
    if (!rest.startsWith(";")) return null;
    for (const item of rest.slice(1).split(";")) {
      const index = item.indexOf("=");
      if (index < 1) return null;
      const key = item.slice(0, index);
      if (key.includes("=")) return null;
      const rawValue = item.slice(index + 1);
      const quoted = rawValue.startsWith('"');
      if (quoted && !(rawValue.length >= 2 && rawValue.endsWith('"'))) return null;
      attributes[key] = quoted ? rawValue.slice(1, -1) : rawValue;
    }
  }

  return { label, signatureParams, components, attributes };
}

// Exported for tests/audiohook-signature-input.test.mjs, which asserts this
// stays linear. Nothing else should call it.
export const parseSignatureInputForTest = parseSignatureInput;

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
