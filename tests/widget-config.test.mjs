import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WIDGET_CONFIG,
  applyWidgetInfrastructure,
  assertPublishableWidgetConfig,
  isValidWidgetAllowedOrigin,
  isWidgetOriginAllowed,
  parseWidgetConfig,
  parseWidgetConfigIfCurrent,
  publicWidgetConfig,
} from "../lib/widgets/config.js";

test("embedding origin validation accepts complete origins and HTTPS wildcards only", () => {
  assert.equal(isValidWidgetAllowedOrigin("https://shop.example.com"), true);
  assert.equal(isValidWidgetAllowedOrigin("http://localhost:3000"), true);
  assert.equal(isValidWidgetAllowedOrigin("https://*.example.com"), true);
  assert.equal(isValidWidgetAllowedOrigin("https://shop.example.com/path"), false);
  assert.equal(isValidWidgetAllowedOrigin("https://"), false);
  assert.equal(isValidWidgetAllowedOrigin("ftp://shop.example.com"), false);
  assert.equal(isValidWidgetAllowedOrigin("http://*.example.com"), false);
});

test("default widget configuration is valid", () => {
  const config = parseWidgetConfig(DEFAULT_WIDGET_CONFIG);
  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.dimensions.panelPosition, "bottom-right");
  assert.equal(config.dimensions.launcherPosition, "bottom-right");
  assert.equal(config.components.handoff.queue.enabled, true);
  assert.equal(config.components.footer.utilityInputGap, 8);
  assert.equal(config.components.messages.typingIndicator.rotatingMessages, true);
  assert.equal(config.components.messages.typingIndicator.alignment, "left");
  assert.equal(config.components.messages.typingIndicator.spinnerIcon, "loader-circle");
  assert.equal(config.components.messages.agentTypingIndicator.enabled, true);
  assert.equal(config.components.messages.agentTypingIndicator.sendCustomerTyping, true);
  assert.equal(config.components.messages.agentTypingIndicator.alignment, "left");
  assert.equal(config.content.agentTypingMessage, "Konsultant pisze…");
  assert.equal(config.avatars.human.useGenesysProfilePicture, false);
  assert.equal(config.channels.voice.genesysSipUriManaged, true);
  assert.equal(config.channels.voice.genesysTrunkId, "");
  assert.equal(config.preview.activeDeviceId, "desktop-responsive");
  assert.equal(config.preview.orientation, "landscape");
  assert.equal(config.preview.backgrounds["desktop-responsive__landscape"].backgroundMode, "schematic");
});

test("panel and launcher placement are independent and legacy placement remains readable", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.dimensions.panelPosition = "bottom-left";
  config.dimensions.panelOffsetX = 36;
  config.dimensions.launcherPosition = "bottom-right";
  config.dimensions.launcherOffsetX = 18;
  const parsed = parseWidgetConfig(config);
  assert.equal(parsed.dimensions.panelPosition, "bottom-left");
  assert.equal(parsed.dimensions.panelOffsetX, 36);
  assert.equal(parsed.dimensions.launcherPosition, "bottom-right");
  assert.equal(parsed.dimensions.launcherOffsetX, 18);

  const legacy = structuredClone(DEFAULT_WIDGET_CONFIG);
  delete legacy.dimensions.panelPosition;
  delete legacy.dimensions.panelOffsetX;
  delete legacy.dimensions.panelOffsetY;
  delete legacy.dimensions.launcherPosition;
  delete legacy.dimensions.launcherOffsetX;
  delete legacy.dimensions.launcherOffsetY;
  legacy.dimensions.position = "bottom-left";
  legacy.dimensions.offsetX = 42;
  legacy.dimensions.offsetY = 30;
  const normalized = parseWidgetConfig(legacy);
  assert.equal(normalized.dimensions.panelPosition, "bottom-left");
  assert.equal(normalized.dimensions.panelOffsetX, 42);
  assert.equal(normalized.dimensions.launcherPosition, "bottom-left");
  assert.equal(normalized.dimensions.launcherOffsetY, 30);
});

test("optional presentation labels receive defaults within schema v2", () => {
  const previous = structuredClone(DEFAULT_WIDGET_CONFIG);
  delete previous.content.connectingMessage;
  delete previous.content.assistantTypingMessage;
  delete previous.content.unavailableMessage;
  delete previous.content.sendFailedMessage;
  delete previous.content.voiceReadyMessage;
  delete previous.content.voiceListeningMessage;
  delete previous.content.voiceThinkingMessage;
  delete previous.content.voiceSpeakingMessage;
  delete previous.channels.voice.region;
  delete previous.channels.voice.genesysTrunkId;
  delete previous.features.voiceTranscript;
  delete previous.components.handoff;
  delete previous.components.footer.utilityButtonGap;
  delete previous.components.footer.utilityInputGap;
  delete previous.components.footer.inputSendGap;
  delete previous.components.messages.typingIndicator;
  delete previous.components.messages.agentTypingIndicator;
  delete previous.content.agentTypingMessage;
  delete previous.content.handoffAssignedMessage;
  delete previous.avatars.human.useGenesysProfilePicture;
  delete previous.preview;
  const parsed = parseWidgetConfig(previous);
  assert.equal(parsed.content.connectingMessage, "Łączenie…");
  assert.match(parsed.content.unavailableMessage, /niedostępny/);
  assert.equal(parsed.channels.voice.region, "auto");
  assert.equal(parsed.channels.voice.genesysTrunkId, "");
  assert.equal(parsed.features.voiceTranscript, true);
  assert.equal(parsed.components.handoff.connected.enabled, true);
  assert.equal(parsed.components.footer.utilityButtonGap, 4);
  assert.equal(parsed.components.messages.typingIndicator.rotatingMessages, true);
  assert.equal(parsed.components.messages.typingIndicator.spinnerIcon, "loader-circle");
  assert.equal(parsed.components.messages.typingIndicator.alignment, "left");
  assert.equal(parsed.components.messages.agentTypingIndicator.enabled, true);
  assert.equal(parsed.components.messages.agentTypingIndicator.alignment, "left");
  assert.equal(parsed.content.agentTypingMessage, "Konsultant pisze…");
  assert.match(parsed.content.handoffAssignedMessage, /\{agent\}/);
  assert.equal(parsed.avatars.human.useGenesysProfilePicture, false);
  assert.equal(parsed.preview.backgrounds["desktop-responsive__landscape"].backgroundMode, "schematic");
});

test("at least one widget channel must remain enabled", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.messaging.enabled = false;
  config.channels.voice.enabled = false;
  assert.throws(() => parseWidgetConfig(config), /At least one channel/);
});

test("public widget configuration strips Genesys and messaging assistant identifiers", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.messaging.assistantId = "assistant-private-server-reference";
  config.channels.messaging.genesys.integrationId = "genesys-integration";
  const result = publicWidgetConfig(config);
  assert.equal(result.channels.messaging.assistantId, undefined);
  assert.equal(result.channels.messaging.genesys, undefined);
  assert.equal(result.channels.voice.genesysSipUri, undefined);
  assert.equal(result.channels.voice.genesysSipUriManaged, undefined);
  assert.equal(result.channels.voice.genesysTrunkId, undefined);
  assert.equal(result.channels.voice.region, "auto");
  assert.equal(result.preview, undefined);
});

test("preview accepts a private uploaded screenshot without exposing it publicly", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  const background = config.preview.backgrounds["desktop-responsive__landscape"];
  background.backgroundMode = "image";
  background.backgroundImageUrl = "data:image/webp;base64,UklGRg==";
  const parsed = parseWidgetConfig(config);
  assert.match(parsed.preview.backgrounds["desktop-responsive__landscape"].backgroundImageUrl, /^data:image\/webp/);
  assert.equal(publicWidgetConfig(parsed).preview, undefined);
});

test("preview accepts a widget-scoped persisted screenshot URL without exposing it publicly", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  const background = config.preview.backgrounds["desktop-responsive__landscape"];
  background.backgroundMode = "image";
  background.backgroundImageUrl = "/api/admin/widgets/2ae5c8cb-5713-4bce-8f31-c393525f5146/preview-background?variant=desktop-responsive__landscape&v=1723896000000";
  const parsed = parseWidgetConfig(config);
  assert.equal(
    parsed.preview.backgrounds["desktop-responsive__landscape"].backgroundImageUrl,
    background.backgroundImageUrl
  );
  assert.equal(publicWidgetConfig(parsed).preview, undefined);
});

test("preview backgrounds are isolated per device and orientation", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.preview.activeDeviceId = "iphone-16-pro";
  config.preview.orientation = "portrait";
  config.preview.backgrounds["iphone-16-pro__portrait"] = {
    backgroundMode: "image",
    backgroundImageUrl: "data:image/webp;base64,UklGRg==",
    backgroundFit: "contain",
    backgroundPosition: "center",
    overlayPercent: 12,
  };
  const parsed = parseWidgetConfig(config);
  assert.equal(parsed.preview.backgrounds["iphone-16-pro__portrait"].backgroundFit, "contain");
  assert.equal(parsed.preview.backgrounds["desktop-responsive__landscape"].backgroundMode, "schematic");
});

test("public voice configuration receives only the server-managed WebRTC caller number", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.voice.enabled = true;
  config.channels.voice.assistantId = "assistant-voice";
  config.channels.voice.genesysTrunkId = "trunk-widget-transfer";
  config.channels.voice.genesysSipUri = "sip:widget@genesys.example.eu";
  const result = publicWidgetConfig(config, { voiceCallerNumber: "+48221234567" });
  assert.equal(result.channels.voice.callerNumber, "+48221234567");
  assert.equal(result.channels.voice.genesysSipUri, undefined);
});

test("origin allowlist supports exact origins and wildcard subdomains", () => {
  const allowed = ["https://shop.example.com", "https://*.support.example.eu"];
  assert.equal(isWidgetOriginAllowed("https://shop.example.com", allowed), true);
  assert.equal(isWidgetOriginAllowed("https://pl.support.example.eu", allowed), true);
  assert.equal(isWidgetOriginAllowed("https://support.example.eu", allowed), false);
  assert.equal(isWidgetOriginAllowed("https://evil.example", allowed), false);
});

test("publishing requires runtime identifiers for every enabled channel", () => {
  assert.throws(
    () => assertPublishableWidgetConfig(DEFAULT_WIDGET_CONFIG),
    /Messaging assistant ID is required/
  );
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = ["https://www.example.eu"];
  config.channels.messaging.assistantId = "assistant-id";
  config.channels.messaging.genesys.integrationId = "integration-id";
  config.channels.messaging.genesys.queueId = "queue-id";
  assert.equal(assertPublishableWidgetConfig(config).schemaVersion, 2);
});

test("shared infrastructure hydrates the effective publish config without changing the draft", () => {
  const draft = structuredClone(DEFAULT_WIDGET_CONFIG);
  const effective = applyWidgetInfrastructure(draft, {
    integrationId: "integration-shared",
    queues: [
      { id: "queue-support", name: "Support" },
      { id: "queue-sales", name: "Sales" },
    ],
    defaultQueue: { id: "queue-sales", name: "Sales" },
  });
  assert.equal(draft.channels.messaging.genesys.integrationId, "");
  assert.equal(effective.channels.messaging.genesys.integrationId, "integration-shared");
  assert.deepEqual(effective.channels.messaging.genesys.queues, [
    { id: "queue-support", name: "Support" },
    { id: "queue-sales", name: "Sales" },
  ]);
  assert.equal(effective.channels.messaging.genesys.queueId, "queue-sales");
  assert.equal(effective.channels.messaging.genesys.queueName, "Sales");
});

test("publishing requires one assistant across enabled messaging and voice channels", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = ["https://www.example.eu"];
  config.channels.messaging.assistantId = "assistant-chat";
  config.channels.messaging.genesys.integrationId = "integration-id";
  config.channels.messaging.genesys.queueId = "queue-id";
  config.channels.voice.enabled = true;
  config.channels.voice.assistantId = "assistant-voice";
  config.channels.voice.genesysTrunkId = "trunk-widget-transfer";
  config.channels.voice.genesysSipUri = "sip:widget@genesys.example.eu";
  assert.throws(
    () => assertPublishableWidgetConfig(config),
    /Messaging and voice must use the same Telnyx AI assistant/
  );
  config.channels.voice.assistantId = config.channels.messaging.assistantId;
  assert.equal(assertPublishableWidgetConfig(config).schemaVersion, 2);
});

test("publishing voice requires an explicitly selected Genesys BYOC trunk", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = ["https://www.example.eu"];
  config.channels.messaging.enabled = false;
  config.channels.voice.enabled = true;
  config.channels.voice.assistantId = "assistant-voice";
  config.channels.voice.genesysSipUri = "sip:+11009999000@example.byoc.mypurecloud.com";
  assert.throws(() => assertPublishableWidgetConfig(config), /Genesys BYOC trunk is required/);
  config.channels.voice.genesysTrunkId = "trunk-widget-transfer";
  assert.equal(assertPublishableWidgetConfig(config).channels.voice.genesysTrunkId, "trunk-widget-transfer");
});

test("schema v1 configurations are migrated without losing routing, copy or appearance", () => {
  const config = {
    schemaVersion: 1,
    locale: "en-US",
    allowedOrigins: ["https://example.com"],
    channels: structuredClone(DEFAULT_WIDGET_CONFIG.channels),
    appearance: {
      position: "bottom-left", panelWidth: 480, panelHeight: 700, fabSize: 64,
      offsetX: 30, offsetY: 32, borderRadius: 24, primaryColor: "#123456",
      surfaceColor: "#ffffff", textColor: "#111111", userMessageColor: "#abcdef",
    },
    content: { ...structuredClone(DEFAULT_WIDGET_CONFIG.content), title: "Legacy custom title" },
    avatars: structuredClone(DEFAULT_WIDGET_CONFIG.avatars),
    features: { emoji: true, timestamps: false, attachmentsAfterHandoff: true, voiceTextInput: true, voiceTranscript: true },
    behavior: { persistSession: true, inactivityMinutes: 60, mobileFullscreen: true },
  };
  const migrated = parseWidgetConfigIfCurrent(config);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.content.title, "Legacy custom title");
  assert.equal(migrated.dimensions.panelPosition, "bottom-left");
  assert.equal(migrated.theme.colors.primary, "#123456");
  assert.equal(migrated.components.messages.showTimestamps, false);
  assert.equal(parseWidgetConfig(DEFAULT_WIDGET_CONFIG).schemaVersion, 2);
});

test("an obsolete config carrying schemaVersion 2 is ignored instead of breaking inventory", () => {
  const obsolete = {
    schemaVersion: 2,
    channels: { messaging: { enabled: true }, voice: { enabled: false } },
    behavior: { persistSession: true, inactivityMinutes: 60, mobileFullscreen: true },
  };
  assert.equal(parseWidgetConfigIfCurrent(obsolete), null);
  assert.throws(() => parseWidgetConfig(obsolete));
});

test("widget configuration preserves a deployment allowlist with many Genesys queues", () => {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.channels.messaging.genesys.queueId = "queue-1";
  config.channels.messaging.genesys.queueName = "Sales";
  config.channels.messaging.genesys.queues = [
    { id: "queue-1", name: "Sales" },
    { id: "queue-2", name: "Support" },
  ];
  const parsed = parseWidgetConfig(config);
  assert.deepEqual(parsed.channels.messaging.genesys.queues.map(({ id }) => id), [
    "queue-1",
    "queue-2",
  ]);
});
