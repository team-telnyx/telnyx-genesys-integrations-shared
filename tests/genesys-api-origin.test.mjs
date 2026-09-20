import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { assertGenesysApiUrl, genesysApiOrigin, genesysEnvironment } from "../lib/genesys/api-origin.mjs";

const env = { GC_ENVIRONMENT: "usw2.pure.cloud" };
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the configured Genesys API host is accepted", () => {
  assert.equal(genesysApiOrigin(env), "https://api.usw2.pure.cloud");
  assert.equal(
    assertGenesysApiUrl("https://api.usw2.pure.cloud/api/v2/downloads/abc123", env),
    "https://api.usw2.pure.cloud/api/v2/downloads/abc123"
  );
});

test("a host the caller chose is refused, however it is dressed up", () => {
  // Each of these reaches an attacker while looking plausible. A suffix check
  // would accept the first, a "contains" check most of the rest.
  const attacks = [
    "https://api.usw2.pure.cloud.attacker.test/steal",
    "https://attacker.test/api.usw2.pure.cloud",
    "https://attacker.test/?x=api.usw2.pure.cloud",
    "https://api.usw2.pure.cloud@attacker.test/steal",
    "https://api.usw2.pure.cloud:8443/steal",
    "http://api.usw2.pure.cloud/steal",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "//attacker.test/steal",
    "",
    null,
  ];
  for (const attack of attacks) {
    assert.throws(() => assertGenesysApiUrl(attack, env), String(attack));
  }
});

test("the environment itself cannot smuggle in another host", () => {
  for (const value of ["evil.test/../", "api.x.test:8443", "us er.test", "http://evil.test", "*.pure.cloud"]) {
    assert.throws(() => genesysEnvironment({ GC_ENVIRONMENT: value }), value);
  }
  // Unset falls back to the documented default rather than throwing.
  assert.equal(genesysEnvironment({}), "usw2.pure.cloud");
});

test("no route fetches a caller-supplied URL with the user's token attached", async () => {
  // The two routes that did. Both now validate before the credentialed fetch,
  // and the raw values must not reach fetch() again.
  const contacts = await source("app/api/genesys/contactlists/[id]/contacts/route.js");
  assert.match(contacts, /assertGenesysApiUrl\(url\)/);
  assert.match(contacts, /await fetch\(exportUrl,/);
  assert.doesNotMatch(contacts, /await fetch\(url,/);

  const campaign = await source("app/api/campaign/start/route.js");
  assert.match(campaign, /assertGenesysApiUrl\(contactListUri\)/);
  assert.match(campaign, /await fetch\(contactListUrl,/);
  assert.doesNotMatch(campaign, /await fetch\(contactListUri,/);
});
