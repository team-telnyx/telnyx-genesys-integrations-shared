import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BOOTSTRAP_TTL_SECONDS = 5 * 60;

function signingSecret() {
  const value = String(process.env.WIDGET_SESSION_SIGNING_SECRET || "").trim();
  if (value.length < 32) {
    throw new Error("WIDGET_SESSION_SIGNING_SECRET must contain at least 32 characters");
  }
  return value;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function signature(value) {
  return createHmac("sha256", signingSecret()).update(value).digest("base64url");
}

export function createWidgetBootstrapToken({ publicId, revisionId, origin, now = Date.now() }) {
  const payload = encode(
    JSON.stringify({
      typ: "widget-bootstrap",
      wid: publicId,
      rid: revisionId,
      org: origin,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + BOOTSTRAP_TTL_SECONDS,
    })
  );
  return `${payload}.${signature(payload)}`;
}

export function verifyWidgetBootstrapToken(token, { publicId, now = Date.now() }) {
  const [payload, suppliedSignature, extra] = String(token || "").split(".");
  if (!payload || !suppliedSignature || extra) throw new Error("Invalid widget bootstrap token");

  const expected = signature(payload);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid widget bootstrap token");
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid widget bootstrap token");
  }
  const current = Math.floor(now / 1000);
  if (
    claims.typ !== "widget-bootstrap" ||
    claims.wid !== publicId ||
    typeof claims.rid !== "string" ||
    typeof claims.org !== "string" ||
    !Number.isInteger(claims.exp) ||
    claims.exp < current
  ) {
    throw new Error("Expired or mismatched widget bootstrap token");
  }
  return claims;
}

export function createOpaqueSessionToken() {
  return `wss_${randomBytes(32).toString("base64url")}`;
}

const TEST_GRANT_TTL_SECONDS = 12 * 60 * 60;

function testGrantSignature(value) {
  return createHmac("sha256", signingSecret()).update(`genesys-widget-test-v1:${value}`).digest("base64url");
}

// Only the authenticated admin endpoint issues these grants. The public loader
// carries no login cookie; the grant identifies one published widget and origin.
export function createWidgetTestGrant({ publicId, revisionId, origin, userId, now = Date.now() }) {
  const payload = encode(JSON.stringify({
    typ: "widget-test-grant", wid: publicId, rid: revisionId, org: origin,
    sub: userId, exp: Math.floor(now / 1000) + TEST_GRANT_TTL_SECONDS,
  }));
  return `${payload}.${testGrantSignature(payload)}`;
}

export function verifyWidgetTestGrant(token, { publicId, revisionId, origin, now = Date.now() }) {
  const [payload, supplied, extra] = String(token || "").split(".");
  if (!payload || !supplied || extra) return null;
  const expected = Buffer.from(testGrantSignature(payload));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!claims || claims.typ !== "widget-test-grant" || claims.wid !== publicId ||
    claims.rid !== revisionId || claims.org !== origin || typeof claims.sub !== "string" || !claims.sub ||
    !Number.isInteger(claims.exp) || claims.exp <= Math.floor(now / 1000)) return null;
  return claims;
}

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function bearerToken(request) {
  const authorization = String(request.headers.get("authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
