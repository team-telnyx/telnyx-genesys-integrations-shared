import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("integration SDKs and security-sensitive framework packages stay on audited versions", async () => {
  const packageJson = JSON.parse(await source("package.json"));
  assert.equal(packageJson.dependencies["purecloud-platform-client-v2"], "^262.0.0");
  assert.equal(packageJson.dependencies["purecloud-flow-scripting-api-sdk-javascript"], "^0.68.5");
  assert.equal(packageJson.dependencies.telnyx, "^7.21.0");
  assert.equal(packageJson.dependencies.next, "16.3.5");
  assert.equal(packageJson.dependencies.react, "19.3.0");
  assert.equal(packageJson.dependencies["react-dom"], "19.3.0");
});

test("removed legacy packages do not return as direct dependencies", async () => {
  const packageJson = JSON.parse(await source("package.json"));
  for (const name of [
    "@emoji-mart/react",
    "@microlink/react-json-view",
    "bcryptjs",
    "date-fns",
    "nanoid",
    "next-auth",
    "zustand",
  ]) {
    assert.equal(packageJson.dependencies[name], undefined, `${name} should not be a direct dependency`);
  }
});

test("every Telnyx v7 client uses the object-form constructor", async () => {
  const files = [
    "app/api/number-lookup/route.js",
    "app/api/sms/send/route.js",
    "app/api/sms/status/route.js",
    "scripts/test-api-connections.mjs",
    "scripts/send-sms.mjs",
    "scripts/provision-telnyx-genesys-assistant.mjs",
  ];
  for (const file of files) {
    const contents = await source(file);
    assert.match(contents, /new Telnyx\(\{\s*apiKey/u, file);
    assert.doesNotMatch(contents, /new Telnyx\((?!\{)/u, file);
  }
});
