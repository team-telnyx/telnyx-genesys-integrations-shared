import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeInstallerEnvironmentFile,
} from "../lib/genesys/installer-environment.mjs";
import {
  verifyGenesysPlatformAccess,
  verifyTelnyxPlatformAccess,
} from "../lib/genesys/platform-preflight.mjs";

function genesysSdk({ loginError, organizationError } = {}) {
  const logger = {
    logLevelEnum: { level: { LNone: "none" } },
    logger: { transports: [], close() {} },
    setLogger() { this.logger = { transports: [] }; },
  };
  const config = {
    logger,
    setConfigPath(value) { this.configPath = value; },
    setGateway(value) { this.gateway = value; },
  };
  const apiClient = {
    config,
    authData: {},
    setEnvironment(value) { this.environment = value; },
    async loginClientCredentialsGrant(clientId, clientSecret) {
      assert.equal(clientId, "client-id");
      assert.equal(clientSecret, "client-secret");
      if (loginError) throw loginError;
      this.authData.accessToken = "access-token";
      return { accessToken: "access-token" };
    },
  };
  return {
    PureCloudRegionHosts: { usWest2: "usw2.pure.cloud" },
    ApiClient: { instance: apiClient },
    OrganizationApi: class {
      async getOrganizationsMe() {
        if (organizationError) throw organizationError;
        return { id: "org-1", name: "Example Organization" };
      }
    },
  };
}

test("Genesys preflight verifies a real client-credentials grant and organization read", async () => {
  const result = await verifyGenesysPlatformAccess({
    environment: "https://usw2.pure.cloud/",
    clientId: "client-id",
    clientSecret: "client-secret",
    sdk: genesysSdk(),
  });
  assert.deepEqual(result, {
    environment: "usw2.pure.cloud",
    organization: { id: "org-1", name: "Example Organization" },
  });
});

test("Genesys preflight reports rejected credentials without exposing their values", async () => {
  const rejected = new Error("request rejected");
  rejected.response = { status: 401 };
  await assert.rejects(
    verifyGenesysPlatformAccess({
      environment: "usw2.pure.cloud",
      clientId: "client-id",
      clientSecret: "client-secret",
      sdk: genesysSdk({ loginError: rejected }),
    }),
    (error) => {
      assert.match(error.message, /rejected.*HTTP 401/);
      assert.doesNotMatch(error.message, /client-secret|client-id/);
      return true;
    }
  );
});

test("Genesys preflight explains that a Code Authorization client cannot be used for the client-credentials grant", async () => {
  const rejected = new Error("Request failed with status code 400");
  rejected.response = { status: 400 };
  await assert.rejects(
    verifyGenesysPlatformAccess({
      environment: "usw2.pure.cloud",
      clientId: "client-id",
      clientSecret: "client-secret",
      sdk: genesysSdk({ loginError: rejected }),
    }),
    (error) => {
      assert.match(error.message, /Client Credentials OAuth grant \(HTTP 400\)/);
      assert.match(error.message, /grant type is CLIENT-CREDENTIALS/);
      assert.match(error.message, /Code Authorization OAuth client cannot be used/);
      assert.doesNotMatch(error.message, /client-secret|client-id/);
      return true;
    }
  );
});

test("Genesys preflight distinguishes missing organization permission from invalid credentials", async () => {
  const forbidden = new Error("forbidden");
  forbidden.response = { status: 403 };
  await assert.rejects(
    verifyGenesysPlatformAccess({
      environment: "usw2.pure.cloud",
      clientId: "client-id",
      clientSecret: "client-secret",
      sdk: genesysSdk({ organizationError: forbidden }),
    }),
    (error) => {
      assert.match(error.message, /authenticated.*cannot read the organization.*HTTP 403/);
      assert.doesNotMatch(error.message, /client-secret|client-id/);
      return true;
    }
  );
});

test("Telnyx preflight uses direct allowlisted REST endpoints for each capability", async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(String(url));
    assert.equal(options.headers.Authorization, "Bearer test-key");
    return { ok: true, status: 200 };
  };
  await verifyTelnyxPlatformAccess({ apiKey: "test-key", capability: "tts", fetchImpl });
  assert.deepEqual(urls, [
    "https://api.telnyx.com/v2/balance",
    "https://api.telnyx.com/v2/text-to-speech/voices?provider=telnyx",
  ]);

  urls.length = 0;
  await verifyTelnyxPlatformAccess({ apiKey: "test-key", capability: "audio", fetchImpl });
  assert.deepEqual(urls, [
    "https://api.telnyx.com/v2/balance",
    "https://api.telnyx.com/v2/ai/assistants?page%5Bsize%5D=1",
  ]);

  urls.length = 0;
  await verifyTelnyxPlatformAccess({ apiKey: "test-key", capability: "widget", fetchImpl });
  assert.deepEqual(urls, [
    "https://api.telnyx.com/v2/balance",
    "https://api.telnyx.com/v2/ai/assistants?page%5Bsize%5D=1",
  ]);
});

test("Telnyx preflight reports invalid keys without echoing them", async () => {
  await assert.rejects(
    verifyTelnyxPlatformAccess({
      apiKey: "private-invalid-key",
      capability: "tts",
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    (error) => {
      assert.match(error.message, /rejected.*HTTP 403/);
      assert.doesNotMatch(error.message, /private-invalid-key/);
      return true;
    }
  );
});

test("installer environment replacement requires an explicit retry allowlist", () => {
  const source = "GC_CLIENT_CRED_CLIENT_SECRET=old-secret\n";
  assert.throws(
    () => mergeInstallerEnvironmentFile(source, {
      GC_CLIENT_CRED_CLIENT_SECRET: "new-secret",
    }, { allowedNames: ["GC_CLIENT_CRED_CLIENT_SECRET"] }),
    /Refusing to overwrite/
  );
  const updated = mergeInstallerEnvironmentFile(source, {
    GC_CLIENT_CRED_CLIENT_SECRET: "new-secret",
  }, {
    allowedNames: ["GC_CLIENT_CRED_CLIENT_SECRET"],
    replaceNames: ["GC_CLIENT_CRED_CLIENT_SECRET"],
  });
  assert.match(updated, /^GC_CLIENT_CRED_CLIENT_SECRET=new-secret$/m);
});
