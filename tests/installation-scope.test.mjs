import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_INSTALLATION_NAME,
  installationResourceNames,
  installationScope,
  normalizeInstallationKey,
  normalizeInstallationName,
  suggestedInstallationName,
} from "../lib/genesys/installation-scope.mjs";

test("the default installation uses one exact name in every administrative container", () => {
  const names = installationResourceNames({});
  assert.equal(installationScope({}).legacy, true);
  assert.equal(names.adminClientApplication, "Telnyx Integrations");
  assert.equal(names.adminRole, "Telnyx Integrations");
  assert.equal(names.adminGroup, "Telnyx Integrations");
  assert.equal(names.widgetOpenMessaging, "Telnyx Integrations");
  assert.equal(names.widgetHandoffTool, "Telnyx Integrations");
  assert.equal(names.audioInteractionWidget, "Telnyx Integrations");
});

test("a production namespace uses the exact installation name across resource types", () => {
  const scope = installationScope({
    GC_INSTALLATION_KEY: "prod",
    GC_INSTALLATION_NAME: "Telnyx Integrations PROD",
  });
  const names = installationResourceNames(scope);
  assert.equal(scope.legacy, false);
  assert.equal(names.adminClientApplication, "Telnyx Integrations PROD");
  assert.equal(names.adminRole, "Telnyx Integrations PROD");
  assert.equal(names.adminGroup, "Telnyx Integrations PROD");
  assert.equal(names.widgetMessageFlow, "Telnyx Integrations PROD");
  assert.equal(names.widgetOpenMessaging, "Telnyx Integrations PROD");
  assert.equal(names.widgetHandoffTool, "Telnyx Integrations PROD");
  assert.equal(names.sharedHangupTool, "Telnyx Integrations PROD");
  assert.equal(names.audioHandoffScript, "Telnyx Integrations PROD");
  assert.equal(names.audioInteractionWidget, "Telnyx Integrations PROD");
  assert.equal(names.callbacks, "Telnyx Integrations PROD");
});

test("installation identifiers are validated and names can be suggested", () => {
  assert.equal(normalizeInstallationKey(" PROD ", { required: true }), "prod");
  assert.equal(normalizeInstallationName(" Telnyx   Integrations PROD "), "Telnyx Integrations PROD");
  assert.equal(suggestedInstallationName("prod"), "Telnyx Integrations PROD");
  assert.equal(suggestedInstallationName("legacy"), DEFAULT_INSTALLATION_NAME);
  assert.throws(() => normalizeInstallationKey("Prod Env", { required: true }), /GC_INSTALLATION_KEY/);
  assert.throws(() => normalizeInstallationName("x", { required: true }), /GC_INSTALLATION_NAME/);
});
