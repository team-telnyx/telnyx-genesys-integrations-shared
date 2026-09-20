import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { analyzeInstallationCollisions } from "../lib/genesys/installation-collisions.mjs";
import { installationResourceNames } from "../lib/genesys/installation-scope.mjs";

const names = installationResourceNames({
  GC_INSTALLATION_KEY: "prod",
  GC_INSTALLATION_NAME: "Telnyx Integrations PROD",
});

test("collision scan separates another installation from exact target conflicts", () => {
  const result = analyzeInstallationCollisions({
    names,
    baseUrl: "https://genesys.example.com",
    inventory: {
      groups: [
        { id: "dev-group", name: "Telnyx Integrations" },
        { id: "prod-group", name: "Telnyx Integrations PROD" },
      ],
      roles: [{ id: "prod-role", name: "Telnyx Integrations PROD" }],
      clientApplications: [{
        id: "dev-app",
        name: "Telnyx Integrations",
        config: { properties: { url: "https://dev.example/genesys/widget-admin" } },
      }],
      telnyxTools: [{ id: "prod-tool", display_name: "Telnyx Integrations PROD" }],
    },
  });
  assert.deepEqual(
    result.collisions.map(({ type, id }) => [type, id]),
    [
      ["Genesys group", "prod-group"],
      ["Genesys role", "prod-role"],
      ["Telnyx tool", "prod-tool"],
    ]
  );
  assert.deepEqual(result.related.map(({ id }) => id).sort(), ["dev-app", "dev-group"]);
});

test("resources bound to this origin or configured IDs are not collisions", () => {
  const result = analyzeInstallationCollisions({
    names,
    baseUrl: "https://genesys.example.com",
    ownedIds: ["prod-role"],
    inventory: {
      roles: [{ id: "prod-role", name: names.adminRole }],
      clientApplications: [{
        id: "prod-app",
        name: names.adminClientApplication,
        config: { properties: { url: "https://genesys.example.com/genesys/widget-admin" } },
      }],
    },
  });
  assert.equal(result.collisions.length, 0);
  assert.deepEqual(result.owned.map(({ id }) => id).sort(), ["prod-app", "prod-role"]);
});

test("a configured ID from another namespace is never treated as owned", () => {
  const result = analyzeInstallationCollisions({
    names,
    ownedIds: ["dev-role"],
    inventory: {
      roles: [{ id: "dev-role", name: "Telnyx Integrations" }],
    },
  });
  assert.equal(result.owned.length, 0);
  assert.deepEqual(result.related.map(({ id }) => id), ["dev-role"]);
});

test("Architect collision discovery is not restricted to the default installation namespace", () => {
  const source = readFileSync(
    new URL("../lib/genesys/installation-collisions.mjs", import.meta.url),
    "utf8"
  );
  const flowListing = source.match(/async function listArchitectFlows[\s\S]*?async function listGenesysIntegrations/)?.[0];
  assert.ok(flowListing);
  assert.doesNotMatch(flowListing, /nameOrDescription\s*:\s*"Telnyx Integrations"/);
});
