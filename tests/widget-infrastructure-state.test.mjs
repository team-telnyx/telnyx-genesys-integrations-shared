import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_WIDGET_CONFIG } from "../lib/widgets/config.js";
import {
  createWidgetInfrastructureState,
  widgetInfrastructureSyncReason,
} from "../lib/widgets/infrastructure-state.js";

function fixture(overrides = {}) {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = ["https://customer.example.com"];
  config.channels.messaging.enabled = true;
  config.channels.messaging.assistantId = "assistant-chat";
  config.channels.messaging.genesys.integrationId = "dedicated-integration";
  config.channels.voice.enabled = false;
  return createWidgetInfrastructureState({
    widget: { id: "widget-1", name: "Customer widget", installationKey: "prod" },
    config,
    publicBaseUrl: "https://genesys.example.com",
    baseIntegrationId: "base-integration",
    messagingQueues: [{ id: "queue-b", name: "B" }, { id: "queue-a", name: "A" }],
    messagingDefaultQueueId: "queue-a",
    voiceQueues: [{ id: "voice-a", name: "Voice" }],
    voiceDefaultQueueId: "voice-a",
    openMessagingSecret: "open-messaging-secret",
    handoffApiKey: "handoff-secret",
    ...overrides,
  });
}

test("widget infrastructure fingerprint ignores UI-only and runtime-only changes", () => {
  const baselineConfig = structuredClone(DEFAULT_WIDGET_CONFIG);
  baselineConfig.allowedOrigins = ["https://customer.example.com"];
  baselineConfig.channels.messaging.enabled = true;
  baselineConfig.channels.messaging.assistantId = "assistant-chat";
  baselineConfig.channels.messaging.genesys.integrationId = "dedicated-integration";
  baselineConfig.channels.voice.enabled = false;
  const changed = structuredClone(baselineConfig);
  changed.theme.colors.primary = "#123456";
  changed.content.title = "A new title";
  changed.allowedOrigins = ["https://new.example.com"];
  changed.features.attachmentPolicy.maximumFileSizeMb = 99;
  changed.features.attachmentPolicy.showPreviewExamples = false;

  assert.equal(fixture({ config: changed }).fingerprint, fixture({ config: baselineConfig }).fingerprint);
});

test("widget infrastructure fingerprint changes for resources managed in Genesys or Telnyx", () => {
  const baseline = fixture();
  const assistantConfig = structuredClone(DEFAULT_WIDGET_CONFIG);
  assistantConfig.allowedOrigins = ["https://customer.example.com"];
  assistantConfig.channels.messaging.enabled = true;
  assistantConfig.channels.messaging.assistantId = "assistant-new";
  assistantConfig.channels.messaging.genesys.integrationId = "dedicated-integration";
  assistantConfig.channels.voice.enabled = false;

  assert.notEqual(fixture({ config: assistantConfig }).fingerprint, baseline.fingerprint);
  assert.notEqual(fixture({ messagingQueues: [{ id: "queue-c", name: "C" }] }).fingerprint, baseline.fingerprint);
  assert.notEqual(fixture({ baseIntegrationId: "another-base" }).fingerprint, baseline.fingerprint);
  assert.notEqual(fixture({ openMessagingSecret: "rotated-secret" }).fingerprint, baseline.fingerprint);
});

test("managed voice fingerprint ignores generated SIP URI but tracks trunk and transfer mode", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = ["https://customer.example.com"];
  config.channels.messaging.enabled = false;
  config.channels.voice.enabled = true;
  config.channels.voice.assistantId = "assistant-voice";
  config.channels.voice.genesysTrunkId = "trunk-a";
  config.channels.voice.genesysSipUri = "sip:+11009999001@first.example.com";
  config.channels.voice.genesysSipUriManaged = true;
  const first = fixture({ config });
  config.channels.voice.genesysSipUri = "sip:+11009999002@second.example.com";
  assert.equal(fixture({ config }).fingerprint, first.fingerprint);
  config.channels.voice.genesysTrunkId = "trunk-b";
  assert.notEqual(fixture({ config }).fingerprint, first.fingerprint);
  config.channels.voice.genesysTrunkId = "trunk-a";
  config.channels.voice.genesysSipUriManaged = false;
  assert.notEqual(fixture({ config }).fingerprint, first.fingerprint);
});

test("infrastructure synchronization is skipped only for a tracked matching publication", () => {
  const desired = fixture();
  const tracked = {
    published: { version: 1 },
    infrastructureFingerprint: desired.fingerprint,
    supportedContentProfileId: "profile-1",
    openMessagingIntegrationId: "integration-1",
  };
  assert.equal(widgetInfrastructureSyncReason(tracked, desired), null);
  assert.equal(widgetInfrastructureSyncReason({ ...tracked, infrastructureFingerprint: null }, desired), "untracked");
  assert.equal(widgetInfrastructureSyncReason(tracked, desired, { force: true }), "forced");
});
