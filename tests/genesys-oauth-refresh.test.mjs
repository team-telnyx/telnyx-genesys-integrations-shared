import test from "node:test";
import assert from "node:assert/strict";

import { refreshGenesysTokens } from "../lib/genesys/oauth-refresh.mjs";
import { GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS } from "../lib/genesys/oauth-settings.mjs";

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("managed Genesys Code Authorization tokens are valid for 24 hours", () => {
  assert.equal(GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS, 86_400);
});

test("confidential Genesys clients refresh and rotate their OAuth tokens", async () => {
  let request;
  const tokenData = await refreshGenesysTokens("refresh-current", {
    clientId: "client-id",
    clientSecret: "client-secret",
    environment: "euw2.pure.cloud",
    async fetchImpl(url, options) {
      request = { url, options };
      return jsonResponse({
        access_token: "access-next",
        refresh_token: "refresh-next",
        expires_in: 86_400,
      });
    },
  });

  assert.equal(request.url, "https://login.euw2.pure.cloud/oauth/token");
  assert.equal(
    request.options.headers.Authorization,
    `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
  );
  assert.equal(request.options.body.get("grant_type"), "refresh_token");
  assert.equal(request.options.body.get("refresh_token"), "refresh-current");
  assert.equal(request.options.body.has("client_id"), false);
  assert.deepEqual(tokenData, {
    accessToken: "access-next",
    refreshToken: "refresh-next",
    accessTokenMaxAge: 86_400,
  });
});

test("public PKCE clients send their client ID during refresh", async () => {
  let request;
  await refreshGenesysTokens("refresh-public", {
    clientId: "public-client",
    clientSecret: "",
    async fetchImpl(url, options) {
      request = { url, options };
      return jsonResponse({ access_token: "access-next", expires_in: 3600 });
    },
  });

  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.body.get("client_id"), "public-client");
});

test("simultaneous refreshes for one browser session use one Genesys request", async () => {
  let calls = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const options = {
    clientId: "client-id",
    clientSecret: "client-secret",
    async fetchImpl() {
      calls += 1;
      await waiting;
      return jsonResponse({
        access_token: "access-next",
        refresh_token: "refresh-next",
        expires_in: 86_400,
      });
    },
  };

  const first = refreshGenesysTokens("refresh-shared", options);
  const second = refreshGenesysTokens("refresh-shared", options);
  release();

  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test("a rejected refresh token produces a reauthentication-safe error", async () => {
  await assert.rejects(
    refreshGenesysTokens("refresh-rejected", {
      clientId: "client-id",
      clientSecret: "client-secret",
      async fetchImpl() {
        return jsonResponse({ error: "invalid_grant" }, { status: 400 });
      },
    }),
    (error) => {
      assert.equal(error.message, "Genesys refresh token was rejected");
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_grant");
      assert.doesNotMatch(error.message, /refresh-rejected/);
      return true;
    }
  );
});
