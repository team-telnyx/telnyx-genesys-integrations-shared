import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { z } from "zod";
import { DEFAULT_WIDGET_CONFIG, isWidgetOriginAllowed, publicWidgetConfig } from "../lib/widgets/config.js";
import { createWidgetBootstrapToken, createWidgetTestGrant, verifyWidgetBootstrapToken, verifyWidgetTestGrant } from "../lib/widgets/session-tokens.js";
import { parseWidgetTestContext, storedWidgetTestContext, WIDGET_TEST_DEFAULT_CONTEXT } from "../lib/widgets/test-page.js";

process.env.WIDGET_SESSION_SIGNING_SECRET = "test-only-widget-grant-signing-key-0123456789";
const origin = "https://studio.example.test";
const publicId = "wgt_example";
const revisionId = "revision-2";
const userId = "user-1";
const id = "11111111-1111-4111-8111-111111111111";
const grantInput = { publicId, revisionId, origin, userId };

test("test grants bind widget, published revision, origin, identity and expiry", () => {
  const now = 1_800_000_000_000;
  const token = createWidgetTestGrant({ ...grantInput, now });
  assert.equal(verifyWidgetTestGrant(token, { ...grantInput, now }).sub, userId);
  for (const mismatch of [{ publicId: "other" }, { revisionId: "other" }, { origin: "https://evil.test" }, { now: now + 43_200_000 }]) {
    assert.equal(verifyWidgetTestGrant(token, { ...grantInput, now, ...mismatch }), null);
  }
  for (const invalid of ["", `${token}x`, `${token}.extra`, "e30.invalid"]) {
    assert.equal(verifyWidgetTestGrant(invalid, { ...grantInput, now }), null);
  }
  const bootstrap = createWidgetBootstrapToken({ ...grantInput, now });
  assert.equal(verifyWidgetTestGrant(bootstrap, { ...grantInput, now }), null);
  assert.throws(() => verifyWidgetBootstrapToken(token, { publicId, now }));
});

test("test context accepts scalar values and preserves an intentionally empty context", () => {
  assert.deepEqual(parseWidgetTestContext('{"customer.segment":"vip","count":2,"yes":true,"empty":null}').context,
    { "customer.segment": "vip", count: 2, yes: true, empty: null });
  assert.deepEqual(parseWidgetTestContext("").context, {});
  assert.equal(storedWidgetTestContext({ getItem: () => "" }), "");
  assert.equal(storedWidgetTestContext({ getItem: () => null }), WIDGET_TEST_DEFAULT_CONTEXT);
  assert.equal(storedWidgetTestContext({ getItem: () => { throw new Error("Storage blocked"); } }), WIDGET_TEST_DEFAULT_CONTEXT);
});

test("test context rejects nested data, unsafe keys and values outside session limits", () => {
  for (const source of ['{', 'null', '[]', '{"nested":{}}', '{"array":[]}', '{"__proto__":"x"}',
    JSON.stringify({ text: "x".repeat(1001) }), JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i, true])))]) {
    assert.ok(parseWidgetTestContext(source).error, source);
  }
});

// Run real route bodies with only their external dependencies replaced. This
// checks authorization ordering, tenant lookup and token handling together.
async function route(file, names, dependencies) {
  const source = (await readFile(new URL(file, import.meta.url), "utf8"))
    .replace(/^import [\s\S]*?;\n/gm, "").replace(/export /g, "");
  return vm.runInNewContext(`${source}\n({${names.join(",")}})`, {
    URL, Response, console, process, structuredClone, NextResponse: Response, ...dependencies,
  });
}

test("test grant endpoint requires same-origin admin access and scopes the widget to the user's organization", async () => {
  let originDenied = false;
  let authDenied = false;
  let widget = { id, publicId, name: "Example", enabled: true, published: { id: revisionId, version: 2 } };
  const calls = [];
  const actor = { userId, organizationId: "org-1" };
  const { POST } = await route("../app/api/admin/widgets/[id]/test-grant/route.js", ["POST"], {
    z, createWidgetTestGrant,
    requireSameOrigin: async () => originDenied ? Response.json({}, { status: 403 }) : null,
    requireWidgetAdmin: async () => authDenied ? { error: Response.json({}, { status: 401 }) } : { actor },
    getWidget: async (...args) => { calls.push(args); return widget; },
    recordWidgetTestOpened: async (entry) => { calls.push(entry); },
  });
  const request = new Request(`${origin}/api/admin/widgets/${id}/test-grant`, { method: "POST", headers: { origin } });
  const params = { params: Promise.resolve({ id }) };
  originDenied = true;
  assert.equal((await POST(request, params)).status, 403);
  originDenied = false; authDenied = true;
  assert.equal((await POST(request, params)).status, 401);
  assert.equal(calls.length, 0);
  authDenied = false;
  assert.equal((await POST(request, { params: { id: "invalid" } })).status, 400);
  const response = await POST(request, params);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(verifyWidgetTestGrant(body.grant, grantInput).sub, userId);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify([id, actor.organizationId]));
  assert.equal(calls[1].actor.userId, userId);
  widget = { ...widget, enabled: false };
  assert.equal((await POST(request, params)).status, 409);
  widget = { ...widget, enabled: true, published: null };
  assert.equal((await POST(request, params)).status, 409);
  widget = null;
  assert.equal((await POST(request, params)).status, 404);
});

test("public bootstrap honors valid test grants without changing the widget allowlist", async () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = ["https://customer.example.test"];
  config.channels.voice.enabled = false;
  config.callbacks.enabled = false;
  const widget = { public_id: publicId, revision_id: revisionId, version: 2, name: "Example", config };
  const { GET } = await route("../app/api/widgets/[publicId]/bootstrap/route.js", ["GET"], {
    getPublishedWidget: async () => widget, widgetOrganizationId: async () => "org-1",
    widgetIconSvgMarkup: () => "<svg/>", isWidgetOriginAllowed, publicWidgetConfig,
    createWidgetBootstrapToken, verifyWidgetTestGrant,
  });
  const request = (query = "", caller = origin) => new Request(`https://api.example.test/api/widgets/${publicId}/bootstrap${query}`, { headers: { origin: caller } });
  const params = { params: { publicId } };
  assert.equal((await GET(request(), params)).status, 403);
  const grant = createWidgetTestGrant(grantInput);
  const response = await GET(request(`?grant=${grant}`), params);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const body = await response.json();
  assert.equal(verifyWidgetBootstrapToken(body.widget.bootstrapToken, { publicId }).org, `gix-test:${origin}`);
  assert.deepEqual(config.allowedOrigins, ["https://customer.example.test"]);
  assert.equal((await GET(request(`?grant=${grant}`, "https://evil.test"), params)).status, 403);
  assert.equal((await GET(request("?grant=invalid", config.allowedOrigins[0]), params)).status, 403);
  assert.equal((await GET(request("?grant=", config.allowedOrigins[0]), params)).status, 403);
  assert.equal((await GET(request(`?grant=${createWidgetTestGrant({ ...grantInput, revisionId: "old" })}`), params)).status, 403);
  const normal = await GET(request("", config.allowedOrigins[0]), params);
  assert.equal(normal.status, 200);
  assert.equal(verifyWidgetBootstrapToken((await normal.json()).widget.bootstrapToken, { publicId }).org, config.allowedOrigins[0]);
});
