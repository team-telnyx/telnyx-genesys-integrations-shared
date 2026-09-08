import { timingSafeEqual } from "node:crypto";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request) {
  const value = String(request.headers.get("authorization") || "").trim();
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

export function configuredGenesysHandoffTokens(environment = process.env) {
  return [...new Set([
    environment.GENESYS_HANDOFF_API_KEY,
    environment.GC_AUDIO_HANDOFF_API_KEY,
    environment.WIDGET_HANDOFF_API_KEY,
  ].map((value) => String(value || "").trim()).filter((value) => value.length >= 32))];
}

export function authorizeGenesysHandoffRequest(request, environment = process.env) {
  const configured = configuredGenesysHandoffTokens(environment);
  if (!configured.length) {
    return { ok: false, status: 500, error: "Handoff authentication is not configured" };
  }
  const presented = String(
    request.headers.get("telnyx-ai-api-key") || bearerToken(request) || ""
  ).trim();
  if (!presented || !configured.some((token) => safeEqual(token, presented))) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}
