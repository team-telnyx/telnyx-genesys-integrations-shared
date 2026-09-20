import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpaqueSessionToken,
  createWidgetBootstrapToken,
  hashSessionToken,
  verifyWidgetBootstrapToken,
} from "../lib/widgets/session-tokens.js";

const originalSecret = process.env.WIDGET_SESSION_SIGNING_SECRET;
process.env.WIDGET_SESSION_SIGNING_SECRET = "test-only-widget-session-secret-0123456789";

test.after(() => {
  if (originalSecret === undefined) delete process.env.WIDGET_SESSION_SIGNING_SECRET;
  else process.env.WIDGET_SESSION_SIGNING_SECRET = originalSecret;
});

test("widget bootstrap token is bound to widget, revision, origin and expiry", () => {
  const now = Date.UTC(2026, 7, 13, 10, 0, 0);
  const token = createWidgetBootstrapToken({
    publicId: "wgt_public",
    revisionId: "revision-1",
    origin: "https://shop.example.eu",
    now,
  });
  const claims = verifyWidgetBootstrapToken(token, { publicId: "wgt_public", now: now + 1000 });
  assert.equal(claims.rid, "revision-1");
  assert.equal(claims.org, "https://shop.example.eu");
  assert.throws(
    () => verifyWidgetBootstrapToken(token, { publicId: "wgt_other", now: now + 1000 }),
    /mismatched/
  );
  assert.throws(
    () => verifyWidgetBootstrapToken(token, { publicId: "wgt_public", now: now + 301_000 }),
    /Expired/
  );
});

test("tampered bootstrap tokens are rejected", () => {
  const token = createWidgetBootstrapToken({
    publicId: "wgt_public",
    revisionId: "revision-1",
    origin: "https://shop.example.eu",
  });
  assert.throws(
    () => verifyWidgetBootstrapToken(`${token}x`, { publicId: "wgt_public" }),
    /Invalid/
  );
});

test("opaque session tokens have a stable hash without storing the token itself", () => {
  const first = createOpaqueSessionToken();
  const second = createOpaqueSessionToken();
  assert.match(first, /^wss_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(hashSessionToken(first), hashSessionToken(first));
  assert.notEqual(hashSessionToken(first), hashSessionToken(second));
  assert.equal(hashSessionToken(first).includes(first), false);
});
