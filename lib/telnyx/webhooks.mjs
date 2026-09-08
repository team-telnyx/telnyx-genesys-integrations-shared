import { TelnyxWebhook } from "telnyx/lib/webhooks";

const MAX_TELNYX_WEBHOOK_BYTES = 1024 * 1024;

export class TelnyxWebhookConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelnyxWebhookConfigurationError";
    this.status = 503;
  }
}

export class TelnyxWebhookSignatureError extends Error {
  constructor(message = "Invalid Telnyx webhook signature", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "TelnyxWebhookSignatureError";
    this.status = 403;
  }
}

export class TelnyxWebhookPayloadError extends Error {
  constructor(message = "Invalid Telnyx webhook payload", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "TelnyxWebhookPayloadError";
    this.status = 400;
  }
}

export function normalizeTelnyxPublicKey(value) {
  const normalized = String(value || "").trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new TelnyxWebhookConfigurationError(
      "TELNYX_PUBLIC_KEY must be a non-empty single-line value"
    );
  }
  let decoded;
  try {
    decoded = Buffer.from(normalized, "base64");
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length !== 32 || decoded.toString("base64") !== normalized) {
    throw new TelnyxWebhookConfigurationError(
      "TELNYX_PUBLIC_KEY must be a canonical base64-encoded 32-byte Ed25519 public key"
    );
  }
  return normalized;
}

export async function verifyTelnyxWebhookSignature({
  payload,
  signature,
  timestamp,
  publicKey = process.env.TELNYX_PUBLIC_KEY,
}) {
  const key = normalizeTelnyxPublicKey(publicKey);
  try {
    const verifier = new TelnyxWebhook(key);
    await verifier.verify(String(payload ?? ""), {
      "telnyx-signature-ed25519": String(signature || ""),
      "telnyx-timestamp": String(timestamp || ""),
    });
  } catch (error) {
    throw new TelnyxWebhookSignatureError(undefined, error);
  }
  return true;
}

export async function verifyAndParseTelnyxWebhookRequest(
  request,
  { publicKey = process.env.TELNYX_PUBLIC_KEY } = {}
) {
  const key = normalizeTelnyxPublicKey(publicKey);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELNYX_WEBHOOK_BYTES) {
    throw new TelnyxWebhookPayloadError("Telnyx webhook payload is too large");
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_TELNYX_WEBHOOK_BYTES) {
    throw new TelnyxWebhookPayloadError("Telnyx webhook payload is too large");
  }
  await verifyTelnyxWebhookSignature({
    payload: rawBody,
    signature: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
    publicKey: key,
  });
  try {
    return { rawBody, event: JSON.parse(rawBody) };
  } catch (error) {
    throw new TelnyxWebhookPayloadError(undefined, error);
  }
}
