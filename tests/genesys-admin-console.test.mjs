import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADMIN_COMPONENT_CATALOG,
  ADMIN_SHARED_TTS_WARNING,
  adminComponentPlanSummary,
  normalizeAdminComponentConfig,
} from "../lib/genesys/admin-components.mjs";
import {
  buildAudioDeploymentInventory,
  buildTtsDeploymentInventory,
  buildWebChatInfrastructureInventory,
  buildWidgetDeploymentInventory,
  listAllGenesysDids,
  loadAudioAgentExperienceInventory,
  loadAudioArchitectFlowInventory,
} from "../lib/genesys/admin-inventory.mjs";
import { managedNotes } from "../lib/genesys/tts-connector-manager.mjs";
import { getTtsConnectorProfile } from "../lib/genesys/tts-connector-profiles.mjs";
import {
  assertSharedTtsPlanFresh,
  assignTtsOperationSteps,
  sharedTtsInventoryFingerprint,
} from "../lib/genesys/admin-deployment-runner.mjs";
import {
  ADMIN_TTS_SAMPLE_MODEL,
  defaultAdminTtsSampleLanguage,
  generateAdminTtsSampleText,
  loadAdminTtsPreviewCatalog,
  synthesizeAdminTtsPreview,
} from "../lib/genesys/admin-tts-preview.mjs";
import {
  ADMIN_CONSOLE_OAUTH_SCOPES,
  ensureAdminConsoleOauthClient,
  provisionGenesysAdminConsole,
} from "../lib/genesys/admin-console-installer.mjs";
import { isAllowedMutationOrigin } from "../lib/genesys/admin-origin.mjs";
import {
  ADMIN_ASSISTANT_RECOMMENDED_MODEL,
  generateDefaultAudioAssistantContent,
} from "../lib/genesys/admin-assistant-generator.mjs";
import {
  ADMIN_CUSTOM_TOOL_TYPES,
  normalizeAdminCustomTool,
} from "../lib/genesys/admin-tool-catalog.mjs";
import {
  adminDashboardAssistantIsManaged,
  adminDashboardModuleState,
  adminDashboardResourceStatus,
} from "../lib/genesys/admin-dashboard.mjs";
import {
  ADMIN_HANDOFF_POLICY_CONTEXTS,
  applyAdminAudioRoutingProfile,
  applyAdminCallbackCampaignProfile,
  applyAdminWidgetChannelProfiles,
  mergeAdminInventoryAssistant,
  normalizeAdminAudioRoutingProfile,
  normalizeAdminCallbackCampaignProfile,
  normalizeAdminHandoffPolicy,
  normalizeAdminWidgetChannelProfile,
} from "../lib/genesys/admin-desired-state.mjs";
import {
  decodeSecretsMasterKey,
  decryptSecretValue,
  encryptSecretValue,
  generateSecretsMasterKey,
  MANAGED_RUNTIME_SECRET_NAMES,
  partitionManagedRuntimeValues,
} from "../lib/genesys/encrypted-secret-store.mjs";
import { removeInstallerEnvironmentValues } from "../lib/genesys/installer-environment.mjs";
import nextConfig from "../next.config.mjs";

test("admin console exposes one catalog for every retained Genesys installer", () => {
  assert.deepEqual(Object.keys(ADMIN_COMPONENT_CATALOG).sort(), ["audio", "callbacks", "tts", "widget"]);
  for (const component of Object.values(ADMIN_COMPONENT_CATALOG)) {
    assert.ok(component.steps.length >= 4);
  }
  assert.match(ADMIN_COMPONENT_CATALOG.audio.steps[0], /managed Audio Connector deployment/);
  assert.doesNotMatch(ADMIN_COMPONENT_CATALOG.audio.steps.join("\n"), /CECA32/);
});

test("admin wizard normalizes TTS, Audio, and Widget desired state", () => {
  const tts = normalizeAdminComponentConfig("tts", {
      profiles: "naturalhd-pcm, rime-pcm\nnaturalhd-pcm",
      testFlowProfiles: ["rime-pcm", "not-selected"],
      credentialMode: "create",
    });
  assert.deepEqual(tts.profiles, ["naturalhd-pcm", "rime-pcm"]);
  assert.deepEqual(tts.testFlowProfiles, ["rime-pcm", "not-selected"]);
  assert.deepEqual(
    normalizeAdminComponentConfig("audio", {
      applicationName: "Support AI",
      deploymentId: "ceca32",
      queueIds: ["queue-1"],
      defaultQueueId: "queue-1",
      widgetGroupIds: ["group-1"],
      routes: [{
        dnis: "+48123456789",
        assistantId: "assistant-1",
        takeover: true,
        takeoverOwner: { id: "person-1", name: "Jane Admin", type: "USER" },
      }],
    }).routes,
    [{
      dnis: "+48123456789",
      assistantId: "assistant-1",
      takeover: true,
      takeoverOwner: { id: "person-1", name: "Jane Admin", type: "USER" },
    }]
  );
  assert.deepEqual(
    normalizeAdminComponentConfig("widget", {
      queueIds: ["queue-1", "queue-2"],
      defaultQueueId: "queue-2",
      groupIds: ["ignored-legacy-group"],
      allowedOrigins: "https://ignored.example.com",
    }),
    {
      applicationName: "Telnyx Integrations",
      deploymentId: "WEBCHAT",
      queueIds: ["queue-1", "queue-2"],
      defaultQueueId: "queue-2",
    }
  );
});

test("new assistants are merged into cached inventory before routing validation", () => {
  const inventory = mergeAdminInventoryAssistant({
    genesysDids: [{ id: "did-1", dnis: "+48123456789" }],
    telnyxAssistants: [
      { id: "assistant-z", name: "Zulu", audioConnector: true, versions: [{ id: "main" }] },
      { id: "assistant-new", name: "Old name", audioConnector: false, versions: [] },
    ],
  }, {
    id: "assistant-new",
    name: "Alpha",
    created_at: "2026-08-19T08:00:00.000Z",
  });
  assert.deepEqual(inventory.genesysDids, [{ id: "did-1", dnis: "+48123456789" }]);
  assert.deepEqual(inventory.telnyxAssistants.map(({ id }) => id), ["assistant-new", "assistant-z"]);
  assert.deepEqual(inventory.telnyxAssistants[0], {
    id: "assistant-new",
    name: "Alpha",
    audioConnector: false,
    versions: [{ id: "main", name: "Main / current", createdAt: "2026-08-19T08:00:00.000Z" }],
  });
  assert.deepEqual(normalizeAdminAudioRoutingProfile({
    routes: [{ dnis: "+48123456789", assistantId: "assistant-new" }],
  }, {
    availableAssistants: inventory.telnyxAssistants,
    availableDids: inventory.genesysDids,
  }), {
    routes: [{
      dnis: "+48123456789",
      assistantId: "assistant-new",
      assistantName: "Alpha",
      takeover: false,
    }],
  });
});

test("central handoff policies validate one inventory-backed default per channel context", () => {
  assert.deepEqual(ADMIN_HANDOFF_POLICY_CONTEXTS, [
    "audio_inbound",
    "callback_outbound",
    "web_messaging",
    "web_voice",
  ]);
  assert.deepEqual(normalizeAdminHandoffPolicy({
    context: "web_voice",
    queueIds: ["queue-2", "queue-1", "queue-2"],
    defaultQueueId: "queue-1",
  }, [
    { id: "queue-1", name: "Customer Care" },
    { id: "queue-2", name: "Sales" },
  ]), {
    context: "web_voice",
    queueIds: ["queue-2", "queue-1"],
    defaultQueueId: "queue-1",
    queues: [
      { id: "queue-2", name: "Sales" },
      { id: "queue-1", name: "Customer Care" },
    ],
  });
  assert.throws(() => normalizeAdminHandoffPolicy({
    context: "audio_inbound",
    queueIds: ["queue-1"],
    defaultQueueId: "",
  }, [{ id: "queue-1", name: "Customer Care" }]), /Select a default Genesys queue/);
  assert.throws(() => normalizeAdminHandoffPolicy({
    context: "web_messaging",
    queueIds: ["missing"],
    defaultQueueId: "missing",
  }, [{ id: "queue-1", name: "Customer Care" }]), /not available in the current inventory/);
});

test("shared Web Calls profile validates trunk, caller identity and media region", () => {
  const inventory = {
    availableTrunks: [{ id: "trunk-1", name: "Web BYOC", enabled: true, compatible: true }],
    availableDids: [{ dnis: "+14155550101" }],
  };
  assert.deepEqual(normalizeAdminWidgetChannelProfile({
    channel: "voice",
    config: { genesysTrunkId: "trunk-1", region: "eu", callerNumber: "+14155550101" },
  }, inventory), {
    channel: "voice",
    config: {
      genesysTrunkId: "trunk-1",
      region: "eu",
      callerNumber: "+14155550101",
      keepAssistantOnCall: false,
    },
  });
  assert.throws(() => normalizeAdminWidgetChannelProfile({
    channel: "voice",
    config: { genesysTrunkId: "trunk-1", region: "eu", callerNumber: "+14155550999" },
  }, inventory), /\+14155550999 is not available/);
  assert.throws(() => normalizeAdminWidgetChannelProfile({
    channel: "voice",
    config: { genesysTrunkId: "trunk-1", region: "eu", callerNumber: "4155550101" },
  }, inventory), /E.164/);
  // Profiles stored before Web Calls owned the caller identity stay saveable.
  assert.equal(normalizeAdminWidgetChannelProfile({
    channel: "voice",
    config: { genesysTrunkId: "trunk-1", region: "eu" },
  }, inventory).config.callerNumber, "");
});

test("the WebRTC caller identity is desired state on Web Calls instead of an environment variable", async () => {
  const [console_, route, store, bootstrap] = await Promise.all([
    readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/channel-profiles/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-console-store.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widgets/[publicId]/bootstrap/route.js", import.meta.url), "utf8"),
  ]);
  // The same Genesys DID picker Inbound Calls and Callbacks already use.
  assert.match(console_, /const callerItems = \(inventory\.genesysDids \|\| \[\]\)\.map\(\(entry\) => \(\{ value: entry\.dnis, label: entry\.dnis, secondary: didSecondary\(entry\) \}\)\);[\s\S]*?canSave/);
  assert.match(console_, /ariaLabel="Select Web Calls WebRTC caller ID"/);
  assert.match(console_, /draft\.region && draft\.callerNumber/);
  assert.match(route, /callerNumber: z\.string\(\)\.trim\(\)\.regex\(/);
  assert.match(route, /availableDids: inventory\.genesysDids/);
  assert.match(store, /export async function getAdminWebCallerNumber/);
  assert.match(bootstrap, /await getAdminWebCallerNumber\(organizationId\)/);
});

test("central Audio routing validates inventory assignments and replaces legacy deployment routes", () => {
  const availableAssistants = [
    { id: "assistant-a", name: "Support" },
    { id: "assistant-b", name: "Sales" },
  ];
  const availableDids = [
    { dnis: "+14155550101" },
    { dnis: "+14155550102" },
  ];
  const normalized = normalizeAdminAudioRoutingProfile({
    routes: [{
      dnis: "+14155550101",
      assistantId: "assistant-a",
      takeover: true,
      takeoverOwner: { id: "ivr-1", name: "Legacy route", type: "INBOUND_CALL_ROUTE" },
    }],
  }, { availableAssistants, availableDids });
  assert.deepEqual(normalized.routes, [{
    dnis: "+14155550101",
    assistantId: "assistant-a",
    assistantName: "Support",
    takeover: true,
    takeoverOwner: { id: "ivr-1", name: "Legacy route", type: "INBOUND_CALL_ROUTE" },
  }]);
  const applied = applyAdminAudioRoutingProfile({
    routes: [{ dnis: "+19999999999", assistantId: "legacy" }],
    createDefaultAssistant: true,
    assistantName: "Legacy draft",
  }, { id: "routing-1", source: "desired", routes: normalized.routes });
  assert.deepEqual(applied.routes, normalized.routes);
  assert.equal(applied.createDefaultAssistant, false);
  assert.equal(applied.assistantName, "");
  assert.throws(() => normalizeAdminAudioRoutingProfile({
    routes: [{ dnis: "+14155550101", assistantId: "__managed_default__" }],
  }, { availableAssistants, availableDids }), /not available/);
  assert.throws(() => normalizeAdminAudioRoutingProfile({
    routes: [
      { dnis: "+14155550101", assistantId: "assistant-a" },
      { dnis: "+14155550101", assistantId: "assistant-b" },
    ],
  }, { availableAssistants, availableDids }), /assigned more than once/);
});

test("custom Assistant Tools normalize the four safe admin-managed tool types", () => {
  assert.deepEqual(ADMIN_CUSTOM_TOOL_TYPES.map(({ id }) => id), [
    "webhook", "transfer", "hangup", "update_dynamic_variables",
  ]);
  const webhook = normalizeAdminCustomTool({
    kind: "webhook",
    displayName: "Customer lookup",
    config: {
      functionName: "lookup_customer",
      description: "Look up one customer record.",
      url: "https://api.example.com/customers",
      method: "post",
      bodySchema: {
        type: "object",
        properties: { customer_id: { type: "string" } },
        required: ["customer_id"],
      },
    },
  });
  assert.equal(webhook.definition.type, "webhook");
  assert.equal(webhook.definition.webhook.method, "POST");
  assert.equal(webhook.definition.webhook.name, "lookup_customer");
  const transfer = normalizeAdminCustomTool({
    kind: "transfer",
    displayName: "Transfer to support",
    config: { from: "{{telnyx_end_user_target}}", to: "sip:support@example.com", targetName: "Support" },
  });
  assert.equal(transfer.definition.transfer.targets[0].to, "sip:support@example.com");
  const hangup = normalizeAdminCustomTool({
    kind: "hangup",
    displayName: "Finish call",
    config: { description: "End the call after a farewell." },
  });
  assert.equal(hangup.definition.type, "hangup");
  const variables = normalizeAdminCustomTool({
    kind: "update_dynamic_variables",
    displayName: "Update context",
    config: {
      functionName: "update_context",
      description: "Update approved customer context.",
      variables: [{ name: "customer_tier", type: "string", description: "Customer tier." }],
    },
  });
  assert.equal(variables.definition.update_dynamic_variables.updatable_variables[0].name, "customer_tier");
  assert.throws(() => normalizeAdminCustomTool({
    kind: "webhook",
    displayName: "Unsafe webhook",
    config: { functionName: "unsafe", description: "Unsafe URL.", url: "http://example.com", bodySchema: { type: "object" } },
  }), /must use HTTPS/);
  assert.throws(() => normalizeAdminCustomTool({
    kind: "update_dynamic_variables",
    displayName: "Duplicate variables",
    config: {
      functionName: "update_context",
      description: "Update context.",
      variables: [
        { name: "tier", type: "string", description: "First." },
        { name: "tier", type: "string", description: "Second." },
      ],
    },
  }), /must be unique/);
});

test("publishing uses the widget assistant for both channels and applies shared Web Calls transport", () => {
  const draft = {
    channels: {
      messaging: { enabled: true, assistantId: "legacy-messaging" },
      voice: {
        enabled: true,
        assistantId: "legacy-voice",
        assistantVersionId: "legacy",
        genesysTrunkId: "legacy-trunk",
        genesysSipUri: "sip:custom@example.com",
        genesysSipUriManaged: false,
        region: "us-east",
      },
    },
  };
  const effective = applyAdminWidgetChannelProfiles(draft, [
    { id: "profile-m", source: "desired", channel: "messaging", assistantId: "assistant-1", config: {} },
    { id: "profile-v", source: "desired", channel: "voice", config: { genesysTrunkId: "trunk-1", region: "eu" } },
  ]);
  assert.equal(effective.channels.messaging.assistantId, "legacy-messaging");
  assert.deepEqual(effective.channels.voice, {
    enabled: true,
    assistantId: "legacy-messaging",
    assistantVersionId: "main",
    genesysTrunkId: "trunk-1",
    genesysSipUri: "",
    genesysSipUriManaged: true,
    // Publishing carries the Web Calls choice of transfer vs invite onto the widget.
    keepAssistantOnCall: false,
    region: "eu",
  });
  assert.equal(draft.channels.voice.genesysSipUri, "sip:custom@example.com");

  const managedDestination = applyAdminWidgetChannelProfiles({
    channels: {
      messaging: { enabled: true, assistantId: "assistant-1" },
      voice: {
        enabled: true,
        assistantId: "assistant-1",
        genesysSipUri: "sip:+15551234567@customer.byoc.example.com",
        genesysSipUriManaged: true,
      },
    },
  }, [{ id: "profile-v", source: "desired", channel: "voice", config: {
    genesysTrunkId: "trunk-1",
    region: "us-west",
  } }]);
  assert.equal(
    managedDestination.channels.voice.genesysSipUri,
    "sip:+15551234567@customer.byoc.example.com"
  );

  const voiceOnly = applyAdminWidgetChannelProfiles({
    channels: {
      messaging: { enabled: false, assistantId: "stale-disabled-assistant" },
      voice: { enabled: true, assistantId: "voice-assistant", assistantVersionId: "voice-version" },
    },
  }, [{ id: "profile-v", source: "desired", channel: "voice", config: { genesysTrunkId: "trunk-1", region: "eu" } }]);
  assert.equal(voiceOnly.channels.voice.assistantId, "voice-assistant");
  assert.equal(voiceOnly.channels.voice.assistantVersionId, "voice-version");
});

test("callback campaign profile validates inventory references and owns every deployment setting", () => {
  const inventory = {
    availableAssistants: [{ id: "assistant-1", name: "Callback Assistant" }],
    availableDids: [{ dnis: "+48123456789" }],
    availableSites: [{ id: "site-1", name: "Warsaw" }],
    availableWrapupCodes: [{ id: "wrapup-1", name: "Callback complete" }],
  };
  const normalized = normalizeAdminCallbackCampaignProfile({
    assistantId: "assistant-1",
    callerAddress: "+48123456789",
    callerName: "Customer Care",
    siteId: "site-1",
    wrapupCodeId: "wrapup-1",
  }, inventory);
  assert.equal(normalized.callerName, "Customer Care");
  assert.throws(() => normalizeAdminCallbackCampaignProfile({
    ...normalized,
    siteId: "missing",
  }, inventory), /Site missing is not available/);

  const effective = applyAdminCallbackCampaignProfile({
    assistantId: "browser-assistant",
    callerAddress: "+19999999999",
    createAssistant: true,
  }, {
    id: "profile-1",
    source: "desired",
    ...normalized,
    queueIds: ["queue-1", "queue-2"],
    defaultQueueId: "queue-2",
  });
  assert.deepEqual({
    assistantId: effective.assistantId,
    callerAddress: effective.callerAddress,
    siteId: effective.siteId,
    wrapupCodeId: effective.wrapupCodeId,
    queueIds: effective.queueIds,
    defaultQueueId: effective.defaultQueueId,
    createAssistant: effective.createAssistant,
  }, {
    assistantId: "assistant-1",
    callerAddress: "+48123456789",
    siteId: "site-1",
    wrapupCodeId: "wrapup-1",
    queueIds: ["queue-1", "queue-2"],
    defaultQueueId: "queue-2",
    createAssistant: false,
  });
});

test("admin wizard rejects incomplete deployment scope before live planning", () => {
  assert.throws(
    () => normalizeAdminComponentConfig("audio", { applicationName: "Audio" }),
    /queue/
  );
  assert.throws(
    () => normalizeAdminComponentConfig("audio", {
      deploymentId: "CECA32",
      queueIds: ["queue-1"],
      defaultQueueId: "queue-1",
      routes: [{ dnis: "+48123456789", assistantId: "assistant-1" }],
    }),
    /Agent Experience access/
  );
  assert.throws(
    () => normalizeAdminComponentConfig("widget", {
      queueIds: ["q"],
      defaultQueueId: "outside-allowlist",
    }),
    /must be selected in the global allowlist/
  );
});

test("first Audio deployment requires generated default-assistant content", () => {
  assert.throws(() => normalizeAdminComponentConfig("audio", {
    applicationName: "Telnyx Integrations",
    deploymentId: "CECA32",
    queueIds: ["queue-1"],
    defaultQueueId: "queue-1",
    widgetGroupIds: ["group-1"],
    routes: [{ dnis: "+48123456789", assistantId: "assistant-1" }],
    createDefaultAssistant: true,
    assistantUseCase: "English product support for a software company",
  }), /instructions/);
  assert.throws(() => normalizeAdminComponentConfig("audio", {
    applicationName: "Changed name",
    deploymentId: "CECA32",
    queueIds: ["queue-1"],
    defaultQueueId: "queue-1",
    widgetGroupIds: ["group-1"],
    routes: [
      { dnis: "+48123456789", assistantId: "__managed_default__" },
      { dnis: "+48987654321", assistantId: "__managed_default__" },
    ],
    createDefaultAssistant: true,
    assistantUseCase: "English product support for a software company",
    assistantInstructions: "Help the caller and offer a human handoff.",
    assistantGreeting: "Hello, how can I help?",
  }), /Generate.*with AI/);
  const generated = normalizeAdminComponentConfig("audio", {
    applicationName: "Changed name",
    deploymentId: "CECA32",
    queueIds: ["queue-1"],
    defaultQueueId: "queue-1",
    widgetGroupIds: ["group-1"],
    routes: [
      { dnis: "+48123456789", assistantId: "__managed_default__" },
      { dnis: "+48987654321", assistantId: "__managed_default__" },
    ],
    createDefaultAssistant: true,
    assistantName: "Product Support Assistant",
    assistantUseCase: "English product support for a software company",
    assistantInstructions: "Help the caller and offer a human handoff.",
    assistantGreeting: "Hello, how can I help?",
    assistantContentGenerated: true,
  });
  assert.equal(generated.applicationName, "Telnyx Integrations");
  assert.equal(generated.assistantName, "Product Support Assistant");
  assert.equal(generated.assistantContentGenerated, true);
  assert.deepEqual(generated.routes, [
    { dnis: "+48123456789", assistantId: "__managed_default__" },
    { dnis: "+48987654321", assistantId: "__managed_default__" },
  ]);
});

test("default Audio assistant generator uses the recommended Telnyx model and structured English content", async () => {
  let request;
  const generated = await generateDefaultAudioAssistantContent({
    description: "English product support for a software company",
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          name: "Product Support Guide",
          instructions: "Help callers identify their issue, provide concise troubleshooting, confirm resolution, and offer a human handoff whenever the request needs account access or the caller asks for an agent.",
          greeting: "Hello, how can I help with your product today?",
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(request.body.model, ADMIN_ASSISTANT_RECOMMENDED_MODEL);
  assert.equal(request.body.enable_thinking, false);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.match(request.body.messages[0].content, /string fields name, instructions and greeting/);
  assert.match(request.url, /chat\/completions$/);
  assert.equal(generated.language, "en");
  assert.equal(generated.name, "Product Support Guide");
  assert.match(generated.instructions, /human handoff/);
});

test("admin deployment summary contains only reviewable remote resources", () => {
  const summary = adminComponentPlanSummary("audio", {
    organization: { id: "org-1", name: "Example" },
    resources: { flowName: "Audio A", widgetName: "Audio A", handoffScriptName: "Audio A" },
    audioConnector: { name: "Audio A" },
    callRoute: { name: "Audio A", operation: "CREATE" },
    telnyxHandoffTool: { action: "CREATE" },
    architect: { routes: [{ dnis: "+48123456789", assistantId: "assistant-1", assistantName: "Assistant A" }] },
  });
  assert.equal(summary.target.id, "org-1");
  assert.equal(summary.resources.length, 7);
  assert.deepEqual(summary.resources.map((resource) => resource.action), ["CREATE", "ATTACH", "ENSURE", "ENSURE", "CREATE", "ENSURE", "ENSURE"]);
});

test("Audio reassignment is explicit in the review summary", () => {
  const summary = adminComponentPlanSummary("audio", {
    organization: { id: "org-1", name: "Example" },
    resources: { flowName: "Telnyx Integrations", widgetName: "Telnyx Integrations" },
    audioConnector: { name: "Telnyx Integrations" },
    callRoute: {
      name: "Telnyx Integrations",
      operation: "UPDATE",
      takeovers: [{ dnis: "+48123123010", routeName: "Telnyx Call Route" }],
    },
    telnyxHandoffTool: { action: "UPDATE" },
    architect: { routes: [{ dnis: "+48123123010", assistantId: "assistant-1", assistantName: "Assistant A" }] },
  });
  assert.deepEqual(summary.resources.find((resource) => resource.action === "REASSIGN"), {
    action: "REASSIGN",
    type: "Genesys DID",
    name: "+48123123010 · Telnyx Call Route → Telnyx Integrations",
  });
});

test("Audio review summary contains only resources changed by the desired-state diff", () => {
  const summary = adminComponentPlanSummary("audio", {
    organization: { id: "org-1", name: "Example" },
    resources: { flowName: "Telnyx Integrations", widgetName: "Telnyx Integrations" },
    audioConnector: { name: "Telnyx Integrations", operation: "update-managed" },
    callRoute: {
      name: "Telnyx Integrations",
      operation: "UPDATE",
      takeovers: [],
      ownerTakeovers: [{
        dnis: "+48123123020",
        ownerName: "Jane Admin",
        ownerType: "USER",
      }],
    },
    telnyxHandoffTool: { action: "UPDATE" },
    changes: {
      isCreate: false,
      handoffToolChanged: false,
      audioConnectorChanged: false,
      architectFlowChanged: true,
      callRouteChanged: true,
      interactionWidgetChanged: false,
      addedAssistants: [{ id: "assistant-2", name: "New assistant" }],
      removedAssistants: [],
    },
  });
  assert.deepEqual(summary.resources, [
    { action: "ATTACH", type: "Telnyx AI Assistant", name: "New assistant · assistant-2" },
    { action: "UPDATE", type: "Genesys Architect flow", name: "Telnyx Integrations" },
    { action: "REASSIGN", type: "Genesys DID", name: "+48123123020 · Jane Admin (USER) → Telnyx Integrations" },
    { action: "UPDATE", type: "Genesys inbound call route", name: "Telnyx Integrations" },
  ]);
});

test("TTS plan summary includes Architect flows only for selected providers", () => {
  const summary = adminComponentPlanSummary("tts", {
    organization: { id: "org-1", name: "Example" },
    operations: [
      { action: "CREATE", profileId: "naturalhd-pcm" },
      { action: "CREATE", profileId: "rime-pcm" },
    ],
  }, { testFlowProfiles: ["rime-pcm"] });
  assert.equal(summary.resources.filter((entry) => entry.type.includes("test flow")).length, 1);
  assert.equal(summary.resources.at(-1).name, "rime-pcm");
  assert.deepEqual(summary.warnings, [ADMIN_SHARED_TTS_WARNING]);
});

test("shared TTS plans require a fresh organization-scoped inventory snapshot", () => {
  const now = Date.parse("2026-08-18T20:00:00.000Z");
  assert.doesNotThrow(() => assertSharedTtsPlanFresh({
    createdAt: "2026-08-18T19:55:00.000Z",
    scopeType: "organization",
    organization: { id: "org-1" },
  }, now));
  assert.throws(() => assertSharedTtsPlanFresh({
    createdAt: "2026-08-18T18:00:00.000Z",
    scopeType: "organization",
    organization: { id: "org-1" },
  }, now), /shared TTS plan is stale/);
  assert.throws(() => assertSharedTtsPlanFresh({
    createdAt: "2026-08-18T19:55:00.000Z",
    scopeType: "installation",
    organization: { id: "org-1" },
  }, now), /organization scope/);
});

test("shared TTS inventory fingerprint covers every connector and managed flow", () => {
  const live = {
    deployments: [
      { integrationId: "connector-b", profileId: "b", name: "B", managed: true, observedSnapshotHash: "hash-b" },
      { integrationId: "connector-a", profileId: "a", name: "A", managed: false, observedSnapshotHash: "hash-a" },
    ],
    flows: [
      { id: "flow-b", profileId: "b", integrationId: "connector-b", name: "B Flow", description: "b" },
      { id: "flow-a", profileId: "a", integrationId: "connector-a", name: "A Flow", description: "a" },
    ],
  };
  const fingerprint = sharedTtsInventoryFingerprint(live);
  assert.equal(
    fingerprint,
    sharedTtsInventoryFingerprint({
      deployments: [...live.deployments].reverse(),
      flows: [...live.flows].reverse(),
    })
  );
  assert.notEqual(
    fingerprint,
    sharedTtsInventoryFingerprint({
      ...live,
      deployments: live.deployments.map((entry) =>
        entry.integrationId === "connector-a" ? { ...entry, observedSnapshotHash: "changed" } : entry
      ),
    })
  );
  const rawInventory = [{
    integration: {
      id: "unrecognized-connector",
      name: "External TTS connector",
      integrationType: { id: "genesys-tts-connector" },
      reportedState: { code: "ACTIVE" },
    },
    config: { version: 1, properties: { endpoint: "https://one.example" } },
  }];
  assert.notEqual(
    sharedTtsInventoryFingerprint(live, rawInventory),
    sharedTtsInventoryFingerprint(live, [{
      ...rawInventory[0],
      config: { version: 2, properties: { endpoint: "https://two.example" } },
    }])
  );
});

test("admin OAuth provisioning reuses a confirmed adoption target", async () => {
  const updates = [];
  const oauthApi = {
    async getOauthClient(id) {
      assert.equal(id, "oauth-existing");
      return {
        id,
        name: "Telnyx Integrations Web Admin",
        authorizedGrantType: "CODE",
        registeredRedirectUri: [],
        scope: [],
      };
    },
    async putOauthClient(id, body) {
      updates.push({ id, body });
      return { id, ...body };
    },
    async postOauthClients() {
      assert.fail("confirmed OAuth adoption must not create a duplicate client");
    },
  };
  const result = await ensureAdminConsoleOauthClient({
    context: { oauthApi },
    baseUrl: "https://integrations.example.com",
    clientId: "oauth-existing",
    clientSecret: "existing-confidential-secret",
    name: "Telnyx Integrations Web Admin",
  });
  assert.equal(result.id, "oauth-existing");
  assert.equal(result.secret, "existing-confidential-secret");
  assert.equal(result.created, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].body.accessTokenValiditySeconds, 86_400);
});

test("admin OAuth adoption requires the existing confidential client secret before mutations", async () => {
  await assert.rejects(
    provisionGenesysAdminConsole({
      context: {},
      baseUrl: "https://integrations.example.com",
      adminUserIds: ["user-1"],
      adoptOauthClientId: "oauth-existing",
    }),
    /OAuth client secret is required before it can be adopted/
  );
});

test("interactive bootstrap collects the secret for collision-only OAuth adoption", async () => {
  const source = await readFile(
    new URL("../scripts/manage-genesys-deploy.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /oauthAdoptionCandidates\.length === 1 && !present\("GC_CLIENT_SECRET"\)/);
  assert.match(source, /Existing Genesys Code Authorization client secret required to adopt/);
  assert.match(source, /oauthClientSecret: process\.env\.GC_CLIENT_SECRET/);
  assert.match(source, /secret[\s\S]*\? `\$\{name\} value`[\s\S]*: `\$\{name\}=\$\{JSON\.stringify\(current\)\}`/);
  assert.match(source, /Use the existing configured \$\{existingValueLabel\}\?/);
});

test("managed TTS inventory is explicitly classified as organization-shared", async () => {
  const profile = getTtsConnectorProfile("naturalhd-pcm");
  const notes = managedNotes(profile, "credential-1");
  const inventory = await buildTtsDeploymentInventory({
    inventory: [{
      integration: {
        id: "integration-1",
        name: profile.integrationName,
        integrationType: { id: "genesys-tts-connector" },
        notes,
        reportedState: { code: "ACTIVE" },
      },
      config: {
        notes,
        credentials: { basicAuth: { id: "credential-1" } },
      },
    }],
    architectApi: {
      getFlows: async () => ({ entities: [] }),
    },
  });
  assert.equal(inventory.deployments.length, 1);
  assert.equal(inventory.deployments[0].scope, "genesys_organization");
  assert.equal(inventory.deployments[0].ownership, "shared_managed");
});

test("TTS desired-state operations expose validation and resource status per provider", () => {
  const steps = assignTtsOperationSteps([
    {
      profileId: "naturalhd-pcm",
      profileName: "NaturalHD",
      connectorAction: "CREATE",
      flowAction: "CREATE",
    },
    {
      profileId: "rime-pcm",
      profileName: "Rime",
      connectorAction: "DELETE",
      flowAction: "RETAIN",
    },
  ]);
  assert.deepEqual(steps.map((step) => step.kind), [
    "inventory-validate",
    "provider-validate",
    "provider-validate",
    "connector-create",
    "connector-delete",
    "flow-create",
    "flow-retain",
    "inventory-verify",
  ]);
  assert.deepEqual(steps.map((step) => step.ordinal), steps.map((_, index) => index));
});

test("TTS preview catalog defaults to English and exposes expressive capabilities", async () => {
  const catalog = await loadAdminTtsPreviewCatalog("xai-pcm", {
    apiKey: "test-key",
    async fetchImpl() {
      throw new Error("Static xAI catalog should not make a voice request");
    },
  });
  assert.equal(catalog.voices.length, 5);
  assert.equal(defaultAdminTtsSampleLanguage(catalog.languages), "en-US");
  assert.equal(catalog.expressiveMode.supported, true);
  assert.ok(catalog.expressiveMode.tags.includes("[pause]"));
});

test("TTS sample text uses the recommended Telnyx model and provider-specific tags", async () => {
  let request;
  const sample = await generateAdminTtsSampleText({
    profileId: "xai-pcm",
    language: "en-US",
    useExpressiveMode: true,
    apiKey: "test-key",
    async fetchImpl(url, options) {
      request = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
      return Response.json({
        choices: [{ message: { content: "<emphasis>Hello, world.</emphasis> [pause] What a wonderful day!" } }],
      });
    },
  });
  assert.equal(request.url, "https://api.telnyx.com/v2/ai/openai/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer test-key");
  assert.equal(request.body.model, ADMIN_TTS_SAMPLE_MODEL);
  assert.equal(request.body.enable_thinking, false);
  assert.match(request.body.messages[1].content, /\[pause\]/);
  assert.match(sample.text, /<emphasis>/);
});

test("TTS audio preview validates the voice and wraps connector PCM as browser WAV", async () => {
  let synthesisBody;
  const audio = await synthesizeAdminTtsPreview({
    profileId: "xai-pcm",
    voiceId: "XAI.eve",
    language: "en-US",
    text: "Hello from the voice preview.",
    useExpressiveMode: false,
    apiKey: "test-key",
    async fetchImpl(url, options) {
      assert.equal(String(url), "https://api.telnyx.com/v2/text-to-speech/speech");
      synthesisBody = JSON.parse(options.body);
      return new Response(Buffer.alloc(320), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    },
  });
  assert.equal(synthesisBody.voice, "XAI.eve");
  assert.equal(synthesisBody.language, "en-US");
  assert.equal(synthesisBody.voice_settings.language, "en");
  assert.equal(audio.contentType, "audio/wav");
  assert.equal(audio.buffer.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(audio.buffer.length, 364);
});

test("TTS audio preview rejects voices outside the selected provider catalog", async () => {
  await assert.rejects(
    synthesizeAdminTtsPreview({
      profileId: "xai-pcm",
      voiceId: "XAI.unknown",
      language: "en-US",
      text: "Hello.",
      apiKey: "test-key",
      async fetchImpl() {
        throw new Error("Synthesis must not run for an invalid voice");
      },
    }),
    /Select a voice available/
  );
});

test("admin inventory exposes managed deployments by name while retaining immutable IDs", () => {
  const [audio] = buildAudioDeploymentInventory({
    integrations: [{ id: "integration-1", name: "Support Audio" }],
    manifests: [{
      deployment: { id: "A1B2C3", applicationName: "Support Audio" },
      queues: [{ id: "queue-1" }],
      groups: [{ id: "group-1" }],
      architect: { dnis: ["+48123456789"] },
      resources: { audioConnectorIntegrationId: "integration-1" },
    }],
  });
  assert.equal(audio.name, "Support Audio");
  assert.equal(audio.config.deploymentId, "A1B2C3");
  assert.deepEqual(audio.config.queueIds, ["queue-1"]);
  assert.equal(audio.connector.id, "integration-1");
  assert.equal(audio.connector.state, "UNKNOWN");
  assert.equal(audio.resources.audioConnectorIntegrationId, "integration-1");

  const [widget] = buildWidgetDeploymentInventory({
    widgets: [{
      managedDeploymentId: "D4E5F6",
      name: "Support Widget [D4E5F6]",
      published: {
        config: {
          allowedOrigins: ["https://example.com"],
          channels: {
            messaging: {
              assistantId: "assistant-1",
              genesys: { queues: [{ id: "queue-1", name: "Support" }] },
            },
            voice: { enabled: false },
          },
        },
      },
    }],
    manifests: [{
      deployment: { id: "D4E5F6", applicationName: "Support Widget" },
      access: { groups: [{ id: "group-1" }] },
      messaging: {
        routingFlow: { id: "flow-1", name: "Support flow", managed: true },
        assistant: { id: "assistant-1", managed: true },
      },
      voice: { sipDestination: { trunk: { id: "trunk-1" } } },
    }],
    messageFlows: [{ id: "flow-1", name: "Support flow" }],
    assistants: [{ id: "assistant-1", name: "Support assistant" }],
  });
  assert.equal(widget.config.messageFlowId, "flow-1");
  assert.equal(widget.config.messagingAssistantId, "assistant-1");
  assert.equal(widget.config.messageFlowManaged, true);
  assert.equal(widget.config.messagingAssistantManaged, true);
  assert.equal(widget.config.genesysTrunkId, "trunk-1");
  assert.equal(widget.resources.messageFlowName, "Support flow");
  assert.equal(widget.resources.messagingAssistantName, "Support assistant");
});

test("Web Calls inventory includes published widgets without a legacy managed deployment ID", () => {
  const inventory = buildWidgetDeploymentInventory({
    widgets: [{
      id: "widget-1",
      publicId: "wgt_public",
      managedDeploymentId: null,
      name: "Production Web Calls",
      enabled: true,
      publishedRevisionId: "revision-2",
      published: {
        id: "revision-2",
        version: 2,
        config: {
          channels: {
            messaging: { enabled: false },
            voice: {
              enabled: true,
              assistantId: "assistant-1",
              assistantVersionId: "main",
              genesysSipUri: "sip:+10000000001@example.byoc.mypurecloud.com",
              genesysTrunkId: "trunk-1",
              region: "eu",
            },
          },
        },
      },
      draft: {
        config: {
          channels: { voice: { enabled: false } },
        },
      },
    }, {
      id: "widget-draft-only",
      name: "Unpublished draft",
      published: null,
      draft: { config: { channels: { voice: { enabled: true } } } },
    }],
    assistants: [{ id: "assistant-1", name: "Production Assistant" }],
  });

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].id, "widget-1");
  assert.equal(inventory[0].managedDeploymentId, null);
  assert.equal(inventory[0].publishedRevisionId, "revision-2");
  assert.equal(inventory[0].publishedVersion, 2);
  assert.equal(inventory[0].config.voiceEnabled, true);
  assert.equal(inventory[0].config.voiceAssistantId, "assistant-1");
  assert.equal(inventory[0].config.genesysSipUri, "sip:+10000000001@example.byoc.mypurecloud.com");
});

test("Audio inventory exposes live Agent Experience widget and published handoff script health", async () => {
  const manifests = [{
    deployment: { id: "A1B2C3", name: "Support Audio" },
    publicBaseUrl: "https://integration.example.com",
    queues: [{ id: "queue-1", name: "Support" }],
    groups: [{ id: "group-1", name: "Support Agents" }],
    resourceNames: { widgetName: "Support Audio", handoffScriptName: "Support Audio" },
    resources: { audioConnectorIntegrationId: "integration-1", widgetId: "widget-1", scriptId: "script-1" },
  }];
  const agentExperienceInventory = await loadAudioAgentExperienceInventory({
    manifests,
    groups: [{ id: "group-1", name: "Support Agents" }],
    queues: [{ id: "queue-1", name: "Support" }],
    integrationsApi: {
      async getIntegration(id) {
        assert.equal(id, "widget-1");
        return {
          id,
          name: "Support Audio",
          integrationType: { id: "embedded-client-app-interaction-widget" },
          intendedState: "ENABLED",
          reportedState: { code: "ACTIVE" },
        };
      },
      async getIntegrationConfigCurrent(id) {
        assert.equal(id, "widget-1");
        return { properties: {
          url: "https://integration.example.com/genesys/ai-conversation-widget?conversationId={{gcConversationId}}",
          communicationTypeFilter: "call",
          groups: ["group-1"],
          queueIdFilterList: ["queue-1"],
        } };
      },
    },
    scriptsApi: {
      async getScript(id) {
        assert.equal(id, "script-1");
        return { id, name: "Support Audio" };
      },
      async getScriptsPublished() {
        return { entities: [{ id: "script-1", name: "Support Audio", versionId: "version-1" }] };
      },
    },
  });
  assert.equal(agentExperienceInventory.A1B2C3.status, "healthy");
  assert.equal(agentExperienceInventory.A1B2C3.widget.reportedState, "ACTIVE");
  assert.equal(agentExperienceInventory.A1B2C3.widget.groups[0].name, "Support Agents");
  assert.equal(agentExperienceInventory.A1B2C3.script.published, true);

  const [deployment] = buildAudioDeploymentInventory({
    integrations: [{ id: "integration-1", name: "Support Audio" }],
    manifests,
    agentExperienceInventory,
  });
  assert.equal(deployment.agentExperience.status, "healthy");
  assert.deepEqual(deployment.config.widgetGroupIds, ["group-1"]);
});

test("audio inventory describes the managed Architect flow and its flow and call-route references", async () => {
  const manifests = [{
    deployment: { id: "A1B2C3", name: "Support Audio" },
    resources: { audioConnectorIntegrationId: "integration-1", flowId: "flow-audio" },
    resourceNames: { flowName: "Support Audio" },
  }];
  const flowInventory = await loadAudioArchitectFlowInventory({
    manifests,
    architectApi: {
      async getFlow(id) {
        assert.equal(id, "flow-audio");
        return {
          id,
          name: "Support Audio",
          type: "INBOUNDCALL",
          active: true,
          publishedVersion: { commitVersion: "7" },
        };
      },
      async getArchitectDependencytrackingObject(id, options) {
        assert.equal(id, "flow-audio");
        assert.equal(options.objectType, "INBOUNDCALLFLOW");
        return { id, type: "INBOUNDCALLFLOW" };
      },
      async getArchitectDependencytrackingConsumingresources(id, objectType) {
        assert.equal(id, "flow-audio");
        assert.equal(objectType, "INBOUNDCALLFLOW");
        return {
          entities: [
            { id: "parent-flow", name: "Main IVR", type: "INBOUNDCALLFLOW", version: "3" },
            { id: "route-1", name: "Main inbound route", type: "IVRCONFIGURATION" },
          ],
        };
      },
      async getArchitectIvrs() {
        return {
          entities: [{
            id: "route-1",
            name: "Main inbound route",
            dnis: ["+48123456789"],
            openHoursFlow: { id: "flow-audio", name: "Support Audio" },
          }],
        };
      },
    },
  });
  assert.equal(flowInventory["flow-audio"].version, "7");
  assert.equal(flowInventory["flow-audio"].published, true);
  assert.equal(flowInventory["flow-audio"].references.complete, true);
  assert.deepEqual(flowInventory["flow-audio"].references.flows[0], {
    id: "parent-flow",
    name: "Main IVR",
    type: "INBOUNDCALLFLOW",
    version: "3",
  });
  assert.equal(flowInventory["flow-audio"].references.flows.length, 1);
  assert.deepEqual(flowInventory["flow-audio"].references.callRoutes[0], {
    id: "route-1",
    name: "Main inbound route",
    schedule: "Open hours",
    dnis: ["+48123456789"],
  });

  const [deployment] = buildAudioDeploymentInventory({
    integrations: [{ id: "integration-1", name: "Support Audio" }],
    manifests,
    flowInventory,
  });
  assert.equal(deployment.architectFlow.name, "Support Audio");
  assert.equal(deployment.architectFlow.references.callRoutes.length, 1);
});

test("Audio inventory includes assigned and currently unused Genesys DID numbers", async () => {
  const dids = await listAllGenesysDids({
    async getTelephonyProvidersEdgesDidpoolsDids(type, options) {
      assert.equal(type, "ASSIGNED_AND_UNASSIGNED");
      assert.equal(options.pageSize, 100);
      return {
        entities: [
          {
            id: "did-used",
            number: "+48123123010",
            assigned: true,
            ownerType: "IVR_CONFIG",
            owner: { id: "ivr-1", name: "Main inbound route" },
          },
          { id: "did-free", number: "+48123123020", assigned: false },
        ],
      };
    },
  }, [{ dnis: "+48123123010", routes: [{ id: "ivr-1", name: "Main inbound route" }] }]);
  assert.deepEqual(dids.map(({ dnis, used }) => ({ dnis, used })), [
    { dnis: "+48123123010", used: true },
    { dnis: "+48123123020", used: false },
  ]);
  assert.equal(dids[0].assignee.name, "Main inbound route");
  assert.equal(dids[1].assignee, null);
});

test("Web Chat inventory reports live infrastructure health and desired-state drift", () => {
  const manifest = {
    updatedAt: "2026-08-18T12:00:00.000Z",
    publicBaseUrl: "https://admin.example.com",
    access: {
      group: { id: "group-1", name: "Telnyx Integrations Administrators" },
      role: { id: "role-1", name: "Telnyx Integrations Administrator" },
    },
    messaging: {
      routingFlow: { id: "flow-1", name: "Telnyx Integrations - Message Routing" },
      recipientId: "recipient-1",
      queues: [{ id: "queue-1", name: "Support" }],
      defaultQueue: { id: "queue-1", name: "Support" },
      allowedOrigins: ["https://admin.example.com", "https://shop.example.com"],
    },
    resources: {
      openMessagingIntegrationId: "open-messaging-1",
      telnyxHandoffToolId: "tool-1",
    },
  };
  const common = {
    manifest,
    messageFlows: [{
      id: "flow-1",
      name: "Telnyx Integrations - Message Routing",
      publishedVersion: { id: "version-2", version: 2 },
    }],
    openMessagingIntegrations: [{
      id: "open-messaging-1",
      name: "Telnyx AI Widget Messaging",
      createStatus: "ACTIVE",
      outboundNotificationWebhookUrl: "https://admin.example.com/api/genesys/open-messaging/outbound/open-messaging-1",
    }],
    recipient: {
      id: "recipient-1",
      name: "Telnyx AI Widget Messaging",
      flow: { id: "flow-1", name: "Telnyx Integrations - Message Routing" },
    },
    managedTools: [{
      remoteToolId: "tool-1",
      displayName: "Genesys Handoff",
      status: "healthy",
    }],
  };

  const healthy = buildWebChatInfrastructureInventory({
    ...common,
    desiredProfile: {
      source: "desired",
      queueIds: ["queue-1"],
      defaultQueueId: "queue-1",
    },
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.flow.published, true);
  assert.equal(healthy.recipient.flowId, "flow-1");
  assert.equal(healthy.queues.status, "healthy");
  assert.deepEqual(healthy.allowedOrigins, ["https://admin.example.com", "https://shop.example.com"]);

  const drifted = buildWebChatInfrastructureInventory({
    ...common,
    desiredProfile: {
      source: "desired",
      queueIds: ["queue-1", "queue-2"],
      defaultQueueId: "queue-2",
    },
  });
  assert.equal(drifted.status, "drifted");
  assert.equal(drifted.queues.status, "drifted");

  const missing = buildWebChatInfrastructureInventory({
    ...common,
    messageFlows: [],
    desiredProfile: {
      source: "desired",
      queueIds: ["queue-1"],
      defaultQueueId: "queue-1",
    },
  });
  assert.equal(missing.status, "missing");
  assert.equal(missing.flow.status, "missing");
});

test("admin UI uses named resources and direct per-voice TTS previews", async () => {
  const source = await readFile(
    new URL("../components/admin/AdminConsole.jsx", import.meta.url),
    "utf8"
  );
  const inventoryRoute = await readFile(
    new URL("../app/api/admin/inventory/route.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /Default Web Chat profile/);
  assert.match(source, /Web Chat routing/);
  assert.match(source, /Managed infrastructure/);
  assert.match(source, /Recipient routing/);
  assert.match(source, /No configuration changes/);
  assert.match(source, /Danger Zone · Delete integration/);
  assert.match(source, /\/api\/admin\/danger-zone/);
  assert.match(source, /infrastructure\.access\?\.role/);
  assert.match(source, /Assistant Tools/);
  assert.match(source, /Queue Policies/);
  assert.match(source, /Channel infrastructure[\s\S]{0,500}Inbound Calls[\s\S]{0,200}Web Calls[\s\S]{0,200}Callback Campaigns[\s\S]{0,200}Web Chat/);
  assert.match(source, /<h2 className="text-xl font-semibold">Inbound Calls<\/h2>/);
  assert.match(source, /<h2 className="text-xl font-semibold">Web Calls<\/h2>/);
  assert.match(source, /<h2 className="text-xl font-semibold">Web Chat<\/h2>/);
  assert.match(source, /grid items-start gap-4 rounded-xl border p-4 lg:grid-cols-2/);
  assert.match(source, /className="grid self-start gap-1.5"><Label>Queue visibility/);
  assert.doesNotMatch(source, /label="Genesys access groups"/);
  assert.match(source, /TTS providers/);
  assert.match(source, /Shared organization settings/);
  assert.match(source, /Shared active/);
  assert.match(source, /Live Genesys[\s\S]*canonical desired-state starting point/);
  assert.match(source, /TtsProviderListSkeleton/);
  assert.match(source, /aria-label="Loading TTS providers"/);
  assert.match(source, /Array\.from\(\{ length: 11 \}/);
  assert.match(source, /const \[ttsPreviews, setTtsPreviews\] = useState\(\{\}\)/);
  assert.match(source, /const \[selectedProfileId, setSelectedProfileId\]/);
  assert.match(source, /<Loader2 className="size-3 animate-spin" \/> Verifying…/);
  assert.match(source, /onSelect=\{selectComponent\}/);
  assert.doesNotMatch(source, /onSelect=\{\(id\) => \{[\s\S]{0,250}refreshInventory/);
  assert.match(source, /connectors used/);
  assert.match(source, /inventory\.audioCapacity/);
  assert.match(source, /Observed Audio routing/);
  assert.match(
    source,
    /value=\{inventory\.installation\?\.installationName \|\| "Telnyx Integrations"\} aria-label="Audio Connector deployment name"/
  );
  assert.match(source, /Not currently used/);
  assert.match(source, /Central desired state for Genesys DID assignments/);
  assert.match(source, /Genesys DIDs \(\$\{dnisItems\.length\}\)/);
  assert.match(source, /Telnyx AI assistant \(\$\{assistantItems\.length\}\)/);
  assert.match(source, /Create new assistants in AI Assistants before assigning/);
  assert.match(source, /Save desired routing/);
  assert.match(source, /\/api\/admin\/ai\/audio-routing/);
  assert.match(source, /inventory\.audioRoutingProfile/);
  assert.doesNotMatch(source, /function DefaultAudioAssistantFields/);
  assert.doesNotMatch(source, /function DefaultAssistantDnisField/);
  assert.match(source, /assistantId: targetAssistantId/);
  assert.match(source, /SearchableMultiCombobox/);
  assert.match(source, /groupedByAssistantId/);
  assert.match(source, /aria-label={`Edit DNIS assignments for \$\{assistantLabel\}`}/);
  assert.match(source, /aria-label={`Save DNIS assignments for \$\{assistantLabel\}`}/);
  assert.match(source, /hasPendingConfigurationEdit/);
  assert.match(source, /Confirm or cancel the edited DNIS row before building the plan/);
  assert.match(source, /onPendingEditChange\?\.\(true\)/);
  assert.match(source, /onPendingEditChange\?\.\(false\)/);
  assert.match(source, /routesWithTakeover/);
  assert.match(source, /Reassign Genesys DID\?/);
  assert.match(source, /did\.assignee\.id !== managedCallRouteId/);
  assert.match(source, /current Genesys assignee or inbound call route/);
  assert.match(source, /Confirm reassignment/);
  assert.match(source, /takeover: true/);
  assert.match(source, /routes\.filter\(\(entry\) => entry\.assistantId !== group\.assistantId\)/);
  assert.match(source, /assistantContentGenerated/);
  assert.match(source, /Use \$\{entry\.name\} as default queue/);
  assert.doesNotMatch(source, /Enable this component with the toggle above to show its configuration/);
  assert.match(source, /Call route:/);
  assert.match(source, /CardFooter className="min-h-\[76px\] shrink-0 border-t/);
  assert.match(source, /whitespace-pre-wrap break-words text-xs text-muted-foreground/);
  assert.match(source, /selected === "widget" && <WidgetAdmin embedded inventory=\{inventory\} onPublished=\{\(\) => refreshInventory\(\)\} \/>/);
  assert.match(source, /Inbound routing profile/);
  assert.doesNotMatch(source, /Default inbound routing profile/);
  assert.match(source, /const publishedVoiceWidgets = \(inventory\.widgetDeployments \|\| \[\]\)\.filter/);
  assert.match(source, /deployment\.config\?\.voiceEnabled === true/);
  assert.match(source, /Published Web Calls widgets/);
  assert.match(source, /No published Web Calls widgets yet/);
  assert.doesNotMatch(source, /Messaging only/);
  assert.doesNotMatch(source, /No managed widget deployments/);
  assert.match(source, /"min-h-0 flex-1 overflow-hidden p-0"/);
  assert.match(source, /"min-h-0 flex-1 overflow-y-auto p-5 sm:p-6 lg:p-8"/);
  assert.match(source, /selected === "widget" \|\| selected === "ai" \|\| selected === "tts"/);
  assert.match(source, /grid h-full min-h-0 overflow-hidden bg-background lg:grid-cols-\[360px_minmax\(0,1fr\)\]/);
  assert.match(source, /className="bg-foreground text-background hover:bg-foreground\/90"[^>]*>.*Edit configuration/);
  assert.match(source, /className="bg-foreground text-background hover:bg-foreground\/90"[\s\S]{0,250}>Close/);
  assert.match(source, /Deployment in progress…/);
  assert.doesNotMatch(source, /function Stepper/);
  assert.doesNotMatch(source, /Review plan/);
  assert.match(inventoryRoute, /getIntegrationsType\(AUDIO_CONNECTOR_TYPE\)/);
  assert.match(inventoryRoute, /audioCapacity:\s*\{/);
  assert.match(inventoryRoute, /used: audioIntegrations\.length/);
  assert.match(source, /TTS connector/);
  assert.match(source, /Architect test flow/);
  assert.match(source, /Shared active/);
  assert.match(source, /Shared organization settings/);
  assert.match(source, /Voice testing/);
  assert.match(source, /label="Model"/);
  assert.match(source, /All models/);
  assert.match(source, /voiceModel/);
  assert.match(source, /label="Language"[\s\S]{0,800}label="Model"[\s\S]{0,800}label="Voice"/);
  assert.match(source, /label="Language"/);
  assert.match(source, /label="Voice"/);
  assert.match(source, /SearchableCombobox/);
  assert.match(source, /Filter languages…/);
  assert.match(source, /Filter voices…/);
  assert.match(source, /new Intl\.Locale\(language\)\.maximize\(\)\.region/);
  assert.match(source, /Test phrase/);
  assert.match(source, /Use expressive mode/);
  assert.match(source, /Generated with/);
  assert.match(source, /\/api\/admin\/tts\/providers\/\$\{encodeURIComponent\(id\)\}\/sample-text/);
  assert.match(source, /\/api\/admin\/tts\/providers\/\$\{encodeURIComponent\(id\)\}\/preview/);
  assert.doesNotMatch(source, /test-call/);
  assert.match(source, /ttsConfigChanged/);
  assert.doesNotMatch(source, /Genesys credential is managed automatically/);
  assert.doesNotMatch(source, /Review destroy plan/);
  assert.match(source, /refreshInventory/);
  assert.match(source, /\/api\/admin\/inventory\?refresh=\$\{Date\.now\(\)\}/);
  assert.match(source, /Inventory refreshed/);
  assert.match(source, /telnyx_green_transparent\.png/);
  assert.doesNotMatch(source, /max-h-\[32rem\]/);
  assert.doesNotMatch(source, /<Switch checked=\{current\?\.enabled === true\}/);
  assert.doesNotMatch(source, /Disable AI Audio Connector\?/);
  assert.match(source, /New Audio Connector/);
  assert.match(source, /Creation readiness/);
  assert.match(source, /"Deploy Audio Connector"/);
  assert.match(source, /Managed Audio Connector/);
  assert.match(source, /Connector runtime/);
  assert.match(source, /Agent Experience/);
  assert.match(source, /Routing dependencies/);
  assert.match(source, /Select Agent Experience access groups/);
  assert.match(source, /Transcript/);
  assert.match(source, /Dynamic variables/);
  assert.match(source, /Queue visibility/);
  assert.match(source, /AudioHook WebSocket endpoint/);
  assert.match(source, /What the Audio Connector deployment creates/);
  assert.match(inventoryRoute, /loadAudioAgentExperienceInventory/);
  assert.doesNotMatch(source, /Existing inbound message flow ID/);
  assert.doesNotMatch(source, /Credential strategy/);
  assert.doesNotMatch(source, /function Toggle\(/);
  assert.doesNotMatch(source, /<select\b|<textarea\b|type="checkbox"/);
});

test("admin DNIS multi-combobox uses searchable checkbox selection", async () => {
  const source = await readFile(
    new URL("../components/ui/searchable-multi-combobox.jsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /<Checkbox/);
  assert.match(source, /selected\.has\(itemValue\)/);
  assert.match(source, /onValueChange\(selected\.has\(itemValue\)/);
  assert.match(source, /CommandInput/);
  assert.match(source, /resetListScroll/);
  assert.match(source, /\[open, query, resetListScroll\]/);
  assert.match(source, /strictFilter/);
  assert.match(source, /String\(candidate\)\.toLocaleLowerCase\(\)\.includes\(needle\)/);
  assert.doesNotMatch(source, /\[items, open, query, resetListScroll\]/);
});

test("admin console uses the Demo Portal section rail and single configuration card", async () => {
  const source = await readFile(
    new URL("../components/admin/AdminConsole.jsx", import.meta.url),
    "utf8"
  );
  const rail = await readFile(
    new URL("../components/ui/section-rail.jsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /SectionRail/);
  assert.match(source, /SECTION_RAIL_WIDTH/);
  assert.match(source, /md:grid-cols-\[var\(--section-rail-width\)_minmax\(0,1fr\)\]/);
  assert.match(source, /flex min-h-0 min-w-0 flex-col overflow-hidden rounded-\[1\.25rem\]/);
  assert.doesNotMatch(source, /ComponentTile/);
  assert.equal((source.match(/<SectionRail/g) || []).length, 1);
  assert.match(rail, /export const SECTION_RAIL_WIDTH = "100px"/);
  assert.match(rail, /rounded-\[1\.25rem\]/);
  assert.match(rail, /bg-foreground text-background shadow-sm/);
  assert.match(rail, /max-w-full text-wrap break-words text-\[10px\]/);
  assert.match(source, /<GenesysThemeToggle defaultTheme="light" variant="toolbar"/);
  assert.match(source, /aria-label="Reload embedded admin app"/);
  assert.match(source, /onClick=\{\(\) => window\.location\.reload\(\)\}/);
  assert.match(source, /className="size-8 bg-background p-0 \[&_svg\]:size-3\.5"/);
  assert.match(source, /<SearchableMultiCombobox strictFilter/);
});

test("disabling an admin component atomically clears pending plans", async () => {
  const [route, store] = await Promise.all([
    readFile(new URL("../app/api/admin/components/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-console-store.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(route, /disableAdminComponentAndDiscardPlans/);
  assert.match(route, /body\.enabled === false && body\.discardPlans === true/);
  assert.match(store, /status='running'/);
  assert.match(store, /DELETE FROM integration_deployment_runs[\s\S]*status='planned'/);
  assert.match(store, /ON DELETE CASCADE|discardedPlanCount/);
});

test("admin UI can plan and apply a global public application URL change", async () => {
  const [source, inventoryRoute, planRoute, runner, schema] = await Promise.all([
    readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/inventory/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/public-origin/plan/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-deployment-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(source, /id: "settings", name: "Settings"/);
  assert.match(source, /<SettingsPanel inventory=\{inventory\}/);
  assert.match(source, /<Globe2 \/> Change public URL<\/Button>/);
  assert.match(source, /Public application URL/);
  assert.match(source, /Validate & build plan/);
  assert.match(source, /const configurationValidationLoading = Boolean\(deploymentComponent\) && inventoryLoading/);
  assert.match(source, /Validating configuration…/);
  assert.match(source, /Accept & update all/);
  assert.match(source, /\/api\/admin\/public-origin\/plan/);
  assert.match(inventoryRoute, /publicBaseUrl: process\.env\.GC_PUBLIC_BASE_URL/);
  assert.match(planRoute, /prepareAdminPublicOriginChange/);
  assert.match(planRoute, /component: "settings"/);
  assert.match(runner, /checkTunnelHealth\(publicBaseUrl/);
  assert.match(runner, /updateManagedPublicOrigin\(\{/);
  assert.match(runner, /Managed deployment inventory changed after plan review/);
  assert.match(schema, /integration_deployment_runs[\s\S]*'settings'/);
});

test("genesys:deploy remains the only public Genesys CLI and Web Admin owns component configuration", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(packageJson.scripts["genesys:deploy"], "node scripts/manage-genesys-deploy.mjs");
  assert.equal(packageJson.scripts["genesys:tts"], undefined);
  assert.equal(packageJson.scripts["genesys:audio"], undefined);
  assert.equal(packageJson.scripts["genesys:audio:tunnel"], undefined);
  assert.equal(packageJson.scripts["genesys:widget"], undefined);
  const deploySource = await readFile(
    new URL("../scripts/manage-genesys-deploy.mjs", import.meta.url),
    "utf8"
  );
  assert.match(deploySource, /saveEncryptedRuntimeSecrets/);
  assert.match(deploySource, /deleteInstallerEnvironmentValues/);
  assert.ok(ADMIN_CONSOLE_OAUTH_SCOPES.includes("conversations"));
});

test("admin console schema persists UI state and separates desired configuration from observed resources", async () => {
  const schema = await readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8");
  assert.match(schema, /SCHEMA_BASELINE_VERSION = 100/);
  assert.match(schema, /name: "integration_schema_baseline"/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_user_preferences/);
  assert.match(schema, /PRIMARY KEY \(genesys_organization_id, genesys_user_id\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_deployment_profiles/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_deployment_steps/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_runtime_secrets/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_inventory_snapshots/);
  assert.doesNotMatch(schema, /genesys_admin_/);
  assert.doesNotMatch(schema, /DROP TABLE/);
  assert.equal((schema.match(/name: "integration_schema_baseline"/g) || []).length, 1);
  assert.match(schema, /desired_definition JSONB NOT NULL/);
  assert.match(schema, /integration_ai_tool_remote_id_idx/);
  assert.match(schema, /CHECK \(theme IN \('light', 'dark', 'system'\)\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_configuration_aggregates/);
  assert.match(schema, /name: "configuration_aggregate_kind_constraint"/);
  const kindConstraintMigration = schema.match(
    /name: "configuration_aggregate_kind_constraint",[\s\S]*?DROP CONSTRAINT IF EXISTS integration_configuration_aggregates_kind_check;[\s\S]*?CHECK \(kind IN \(([\s\S]*?)\)\);/
  );
  assert.ok(kindConstraintMigration, "the aggregate kind repair migration must replace the old check");
  assert.deepEqual(
    [...kindConstraintMigration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
    [
      "audio_connector",
      "audio_routing",
      "messaging_profile",
      "voice_profile",
      "callback_campaign",
      "assistant",
      "tool_bundle",
      "queue_policy",
      "tts",
      "agent_experience",
      "insight_profile",
    ]
  );
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_handoff_policies/);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS integration_handoff_policy_one_default_idx/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_ai_tool_assignments/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_widget_channel_profiles/);
  assert.match(schema, /web_chat_assistant_moves_to_widget_revision/);
  assert.match(schema, /DELETE FROM integration_widget_channel_profiles[\s\S]*WHERE channel='messaging'/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_managed_resources/);
  assert.match(schema, /desired_hash TEXT/);
  assert.match(schema, /observed_hash TEXT/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_resource_dependencies/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_inventory_sync_runs/);
  assert.match(schema, /organization_scoped_shared_tts/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS scope_type/);
  assert.match(schema, /WHERE kind='tts' AND scope_type <> 'organization'/);
});

test("admin dashboard derives drift and module deployment state from desired and observed snapshots", () => {
  assert.equal(adminDashboardResourceStatus({ status: "healthy" }), "healthy");
  assert.equal(adminDashboardResourceStatus({ status: "healthy", desired_hash: "same", observed_hash: "same" }), "healthy");
  assert.equal(adminDashboardResourceStatus({ status: "healthy", desired_hash: "wanted", observed_hash: "actual" }), "drifted");
  assert.equal(adminDashboardResourceStatus({ status: "healthy", desired_hash: "wanted", observed_hash: null }), "unknown");
  assert.equal(adminDashboardResourceStatus({ status: "missing", desired_hash: "wanted", observed_hash: "wanted" }), "missing");

  const deployable = { configurationOnly: false };
  const configurationOnly = { id: "queues", configurationOnly: true, expectedObjects: 1 };
  const shared = { id: "tts", scopeType: "organization" };
  assert.equal(adminDashboardModuleState(deployable, [], []), "not_configured");
  assert.equal(adminDashboardModuleState(deployable, [{ id: "a" }], []), "deployment_required");
  assert.equal(adminDashboardModuleState(configurationOnly, [{ id: "a", desiredConfig: {} }], []), "configuration_required");
  assert.equal(adminDashboardModuleState(configurationOnly, [{ id: "a", desiredConfig: { queueIds: ["q1"], defaultQueueId: "q1" } }], []), "configured");
  assert.equal(adminDashboardModuleState(deployable, [{ id: "a" }], [{ status: "healthy" }]), "deployed");
  assert.equal(adminDashboardModuleState(deployable, [{ id: "a" }], [{ status: "healthy" }, { status: "drifted" }]), "drifted");
  assert.equal(adminDashboardModuleState(deployable, [{ id: "a" }], [{ status: "updating" }]), "reconciling");
  assert.equal(adminDashboardModuleState(shared, [], []), "not_configured");
  assert.equal(adminDashboardModuleState(shared, [], [{ status: "healthy" }]), "shared");
  assert.equal(adminDashboardModuleState(shared, [], [{ status: "healthy" }, { status: "drifted" }]), "drifted");
});

test("admin dashboard only treats integration-linked assistants as managed", () => {
  assert.equal(adminDashboardAssistantIsManaged({}), false);
  assert.equal(adminDashboardAssistantIsManaged({ has_dnis_route: true }), true);
  assert.equal(adminDashboardAssistantIsManaged({ has_active_tool_assignment: true }), true);
  assert.equal(adminDashboardAssistantIsManaged({ ownership: "managed" }), false);
});

test("admin dashboard API and live inventory expose a read-only desired-versus-observed overview", async () => {
  const [dashboardRoute, dashboardStore, inventoryRoute, consoleSource] = await Promise.all([
    readFile(new URL("../app/api/admin/dashboard/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-dashboard.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/inventory/route.js", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(dashboardRoute, /requireWidgetAdmin/);
  assert.match(dashboardRoute, /getAdminDashboardOverview/);
  assert.doesNotMatch(dashboardRoute, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.match(dashboardStore, /integration_configuration_aggregates/);
  assert.match(dashboardStore, /integration_managed_resources/);
  assert.match(dashboardStore, /integration_resource_dependencies/);
  assert.match(dashboardStore, /integration_inventory_sync_runs/);
  assert.match(dashboardStore, /integration_audio_dnis_routes/);
  assert.match(dashboardStore, /integration_ai_tool_assignments/);
  assert.match(dashboardStore, /assistantCounts/);
  assert.match(dashboardStore, /scope_type/);
  assert.match(dashboardStore, /scopeType: "organization"/);
  assert.match(dashboardStore, /sharedResources/);
  assert.match(dashboardStore, /sharedCounts/);
  assert.match(dashboardStore, /status <> 'retired'/);
  assert.match(dashboardStore, /metadata->>'source'='inventory_sync'/);
  assert.match(dashboardStore, /audioManifests/);
  assert.match(dashboardStore, /widgetInfrastructureManifest/);
  assert.match(dashboardStore, /aggregateKinds: \["agent_experience"\]/);
  assert.match(dashboardStore, /Deployment manifests are recovery artifacts, not the resource registry/);
  assert.match(dashboardStore, /UPDATE integration_managed_resources resource/);
  assert.doesNotMatch(dashboardStore, /ensureQueuePolicy\("audio_inbound"/);
  const manifestSync = dashboardStore.slice(
    dashboardStore.indexOf("for (const manifest of audioManifests)"),
    dashboardStore.indexOf("const uniqueAggregateIds")
  );
  assert.match(manifestSync, /refreshTrackedResource/);
  assert.doesNotMatch(manifestSync, /saveResource\(/);
  assert.doesNotMatch(manifestSync, /ensureAggregate\(/);
  assert.match(dashboardStore, /"invokes_connector"/);
  assert.match(dashboardStore, /"routes_to_assistant"/);
  assert.match(inventoryRoute, /startAdminInventorySync/);
  assert.match(inventoryRoute, /syncAdminDashboardObservedInventory/);
  assert.match(inventoryRoute, /widgetInfrastructureManifest/);
  assert.match(inventoryRoute, /syncAdminManagedToolsToDesiredState/);
  assert.doesNotMatch(inventoryRoute, /audioInventoryComplete/);
  assert.match(inventoryRoute, /finishAdminInventorySync/);
  assert.match(consoleSource, /Configuration coverage/);
  assert.match(consoleSource, /Latest inventory synchronization/);
  assert.match(consoleSource, /All assistants/);
  assert.match(consoleSource, /Shared resources/);
  assert.match(consoleSource, /Shared connectors/);
  assert.match(consoleSource, /Shared · Healthy/);
  assert.doesNotMatch(consoleSource, /Managed resource inventory/);
  assert.match(consoleSource, /Drift detected/);
  assert.doesNotMatch(consoleSource, /Read-only identifiers, health and downstream dependencies/);
});

test("desired-state APIs validate writes, feed deployment plans, and keep tool assignments deployment-owned", async () => {
  const [store, queueRoute, profileRoute, audioRoutingRoute, callbackProfileRoute, assistantRoute, toolRoute, planRoute, consoleStore] = await Promise.all([
    readFile(new URL("../lib/genesys/admin-desired-state.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/queue-policies/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/channel-profiles/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/audio-routing/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/callback-profile/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/assistants/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/tools/[id]/assignments/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/components/[component]/plan/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-console-store.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(store, /integration_configuration_aggregates/);
  assert.match(store, /integration_handoff_policy_queues/);
  assert.match(store, /resolveAdminComponentDesiredState/);
  assert.match(store, /ADMIN_HANDOFF_POLICY_CONTEXT_BY_COMPONENT/);
  assert.match(store, /messaging: "messaging_profile"/);
  assert.match(store, /voice: "voice_profile"/);
  assert.match(store, /registerAdminCallbackCampaignObservedResources/);
  assert.match(store, /registerAdminAudioObservedResources/);
  assert.match(store, /invokes_connector/);
  assert.match(store, /routes_to_flow/);
  assert.match(store, /uses_contact_list/);
  assert.match(store, /routes_to_assistant/);
  assert.doesNotMatch(store, /integration_deployment_profiles\.config \|\| EXCLUDED\.config/);
  assert.match(store, /status='missing'/);
  assert.match(store, /status='healthy'/);
  assert.match(queueRoute, /requireSameOrigin\(request\)/);
  assert.match(queueRoute, /getAdminInventoryCache/);
  assert.match(profileRoute, /saveAdminWidgetChannelProfiles/);
  assert.match(profileRoute, /requireSameOrigin\(request\)/);
  assert.match(audioRoutingRoute, /saveAdminAudioRoutingProfile/);
  assert.match(audioRoutingRoute, /getAdminInventoryCache/);
  assert.match(audioRoutingRoute, /requireSameOrigin\(request\)/);
  assert.match(callbackProfileRoute, /saveAdminCallbackCampaignProfile/);
  assert.match(callbackProfileRoute, /getAdminInventoryCache/);
  assert.match(assistantRoute, /requireSameOrigin\(request\)/);
  assert.match(assistantRoute, /telnyx\.ai\.assistants\.create/);
  assert.match(assistantRoute, /registerAdminManagedAssistant/);
  assert.match(assistantRoute, /inventoryAssistant/);
  assert.match(store, /integration_inventory_snapshots/);
  assert.match(store, /FOR UPDATE/);
  assert.match(store, /mergeAdminInventoryAssistant/);
  assert.match(assistantRoute, /telnyx\.ai\.assistants\.delete\(createdAssistant\.id\)/);
  assert.match(toolRoute, /owned by deployment rules and cannot be changed manually/);
  assert.match(toolRoute, /export async function GET/);
  assert.match(toolRoute, /status: 405/);
  assert.doesNotMatch(toolRoute, /replaceAdminManagedToolAssignments/);
  assert.match(planRoute, /resolveAdminComponentDesiredState/);
  assert.ok(planRoute.indexOf("resolveAdminComponentDesiredState") < planRoute.indexOf("prepareAdminDeployment(component, desiredConfig)"));
  assert.doesNotMatch(planRoute, /Enable the component before creating a deployment plan|body\.enabled/);
  assert.match(consoleStore, /component='audio' AND status='succeeded'/);
  assert.match(consoleStore, /plan->>'operation' AS operation/);
  assert.match(consoleStore, /JOIN LATERAL/);
  assert.doesNotMatch(consoleStore, /r\.config=c\.config/);
});

test("Web Chat infrastructure registers the Open Messaging recipient as integration metadata", async () => {
  const source = await readFile(new URL("../scripts/manage-genesys-widget.mjs", import.meta.url), "utf8");
  assert.match(source, /logicalKey: "widget_open_messaging", metadata: \{ recipientId \}/);
  assert.doesNotMatch(source, /resourceType: "open_messaging_recipient"/);
  assert.doesNotMatch(source, /relationship: "belongs_to_integration"/);
});

test("managed Telnyx tool registry covers shared and deployment tools while Admin APIs remain read-only", async () => {
  const [registry, runner, widget, createRoute, updateRoute, consoleSource] = await Promise.all([
    readFile(new URL("../lib/genesys/admin-managed-tools.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-deployment-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/manage-genesys-widget.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/tools/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/tools/[id]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(registry, /ADMIN_SHARED_HANDOFF_TOOL_KEY = "genesys_human_handoff"/);
  assert.match(registry, /ADMIN_SHARED_HANGUP_TOOL_KEY = "hangup"/);
  assert.match(registry, /ADMIN_SIP_TRANSFER_TOOL_KEY = "genesys_sip_transfer"/);
  assert.match(registry, /ADMIN_VOICE_QUEUE_TOOL_KEY = "genesys_voice_queue_selector"/);
  assert.match(registry, /previous\.remoteToolId !== remoteToolId/);
  assert.match(registry, /assistantToolIds\(assistant\)\.filter/);
  assert.match(registry, /"assistant_missing"/);
  assert.match(registry, /createAdminCustomTool/);
  assert.match(registry, /updateAdminCustomTool/);
  assert.match(registry, /integration_ai_tool_definitions/);
  assert.match(registry, /integration_ai_tool_assignments/);
  assert.match(registry, /relationship='uses_tool'/);
  assert.match(createRoute, /cannot be created manually/);
  assert.match(createRoute, /status: 405/);
  assert.match(createRoute, /requireSameOrigin\(request\)/);
  assert.match(updateRoute, /cannot be edited manually/);
  assert.match(consoleSource, /Managed assistant tools/);
  assert.match(consoleSource, /Managed insights/);
  assert.match(consoleSource, /Managed instruction inserts/);
  assert.match(consoleSource, /Attachments are derived from channel deployments and cannot be changed manually/);
  assert.doesNotMatch(consoleSource, /id: "tools", label: "Assistant Tools"/);
  assert.match(runner, /registerAdminManagedTelnyxTool/);
  assert.match(widget, /logicalKey: ADMIN_SIP_TRANSFER_TOOL_KEY/);
  assert.match(widget, /logicalKey: ADMIN_VOICE_QUEUE_TOOL_KEY/);
});

test("admin bootstrap returns cached inventory and the local TTS provider catalog", async () => {
  const route = await readFile(
    new URL("../app/api/admin/components/route.js", import.meta.url),
    "utf8"
  );
  const store = await readFile(
    new URL("../lib/genesys/admin-console-store.mjs", import.meta.url),
    "utf8"
  );
  assert.match(route, /getAdminInventoryCache/);
  assert.match(route, /verifiedTtsConnectorProfiles/);
  assert.match(route, /source: cachedInventory \? "cache" : "bootstrap"/);
  assert.match(store, /INSERT INTO integration_inventory_snapshots/);
  assert.match(store, /ON CONFLICT \(genesys_organization_id\)/);
});

test("runtime secrets use authenticated AES-256-GCM encryption", () => {
  const key = decodeSecretsMasterKey(generateSecretsMasterKey());
  const encrypted = encryptSecretValue("TELNYX_API_KEY", "KEY-sensitive-value", key);
  assert.notEqual(encrypted.ciphertext.toString("utf8"), "KEY-sensitive-value");
  assert.equal(
    decryptSecretValue("TELNYX_API_KEY", encrypted, key),
    "KEY-sensitive-value"
  );
  assert.throws(
    () => decryptSecretValue("GC_CLIENT_SECRET", encrypted, key),
    /authenticate|Unsupported state/i
  );
});

test("encrypted store only accepts allowlisted runtime configuration", () => {
  assert.ok(MANAGED_RUNTIME_SECRET_NAMES.includes("GC_CLIENT_CRED_CLIENT_SECRET"));
  assert.ok(MANAGED_RUNTIME_SECRET_NAMES.includes("WIDGET_SESSION_SIGNING_SECRET"));
  assert.ok(MANAGED_RUNTIME_SECRET_NAMES.includes("TELNYX_PUBLIC_KEY"));
  assert.deepEqual(
    partitionManagedRuntimeValues({ TELNYX_API_KEY: "secret", PORT: "3000" }),
    {
      managed: { TELNYX_API_KEY: "secret" },
      plaintext: { PORT: "3000" },
    }
  );
});

test("legacy plaintext migration removes only managed values from .env", () => {
  const migrated = removeInstallerEnvironmentValues(
    "DATABASE_URL=postgres://db\nTELNYX_API_KEY=secret\nPORT=3000\nGC_CLIENT_SECRET=secret\n",
    MANAGED_RUNTIME_SECRET_NAMES
  );
  assert.match(migrated, /^DATABASE_URL=postgres:\/\/db$/m);
  assert.match(migrated, /^PORT=3000$/m);
  assert.doesNotMatch(migrated, /TELNYX_API_KEY|GC_CLIENT_SECRET/);
});

test("admin console can be framed by every supported Genesys Cloud regional domain", async () => {
  const routes = await nextConfig.headers();
  const adminRoute = routes.find((route) => route.source === "/genesys/widget-admin");
  const csp = adminRoute?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
  assert.match(csp, /frame-ancestors/);
  assert.match(csp, /https:\/\/\*\.pure\.cloud/);
  assert.match(csp, /https:\/\/\*\.mypurecloud\.com/);
  assert.match(csp, /https:\/\/\*\.mypurecloud\.ie/);
});

test("admin mutations accept the configured public origin behind a reverse proxy", () => {
  const request = new Request("http://app:3000/api/admin/components", {
    method: "PATCH",
    headers: {
      host: "app:3000",
      origin: "https://tunnel.example.com",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(
    isAllowedMutationOrigin(request, "https://tunnel.example.com"),
    true
  );
  assert.equal(
    isAllowedMutationOrigin(request, "https://another.example.com"),
    false
  );
});

test("admin mutations still accept a direct same-origin request and reject another site", () => {
  const sameOrigin = new Request("http://127.0.0.1:3000/api/admin/components", {
    method: "PATCH",
    headers: { origin: "http://127.0.0.1:3000" },
  });
  const crossOrigin = new Request("http://127.0.0.1:3000/api/admin/components", {
    method: "PATCH",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(isAllowedMutationOrigin(sameOrigin, ""), true);
  assert.equal(isAllowedMutationOrigin(crossOrigin, ""), false);
});

test("the Web Calls trunk picker shows each trunk's transport protocol", async () => {
  const [console_, combobox, inventoryRoute] = await Promise.all([
    readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ui/searchable-combobox.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/inventory/route.js", import.meta.url), "utf8"),
  ]);
  assert.match(inventoryRoute, /transport: trunk\.transport/);
  assert.match(console_, /badge: trunk\.transport \? trunk\.transport\.toUpperCase\(\) : null/);
  assert.match(combobox, /item\.badge && <Badge/);
  // The protocol has to be searchable, not just decorative.
  assert.match(combobox, /keywords=\{\[item\.label, item\.secondary, item\.badge/);
});

test("Web Calls reports which published widgets still run the previous routing", async () => {
  const { webCallDeploymentDrift, webCallDeploymentsNeedingRepublish } =
    await import("../lib/genesys/web-calls-drift.mjs");

  const trunks = [
    { id: "t-tls", name: "BYOC", fqdn: "telnyx.byoc.usw2.pure.cloud", transport: "tls" },
    { id: "t-udp", name: "Legacy", fqdn: "legacy.byoc.usw2.pure.cloud", transport: "udp" },
  ];
  const voiceProfile = {
    config: { genesysTrunkId: "t-tls", region: "eu" },
  };
  const published = {
    id: "widget-1",
    name: "Demo",
    config: {
      voiceEnabled: true,
      genesysSipUri: "sip:+11009999002@telnyx.byoc.usw2.pure.cloud",
      genesysTrunkId: "t-tls",
      voiceAssistantId: "assistant-1",
      voiceAssistantVersionId: "main",
      voiceRegion: "eu",
    },
  };

  // Same trunk, but it now terminates over TLS, so the URI gains ;secure=srtp.
  const drift = webCallDeploymentDrift(published, { voiceProfile, trunks });
  assert.equal(drift.needsRepublish, true);
  assert.deepEqual(drift.reasons.map(({ label }) => label), ["SIP URI"]);
  assert.equal(drift.expectedSipUri, "sip:+11009999002@telnyx.byoc.usw2.pure.cloud;secure=srtp");
  assert.equal(drift.trunkTransport, "tls");

  // Once republished there is nothing to report.
  const current = structuredClone(published);
  current.config.genesysSipUri = drift.expectedSipUri;
  assert.equal(webCallDeploymentDrift(current, { voiceProfile, trunks }).needsRepublish, false);

  // Switching trunk changes host and transport together.
  const movedTrunk = webCallDeploymentDrift(current, {
    voiceProfile: { ...voiceProfile, config: { ...voiceProfile.config, genesysTrunkId: "t-udp" } },
    trunks,
  });
  assert.deepEqual(movedTrunk.reasons.map(({ label }) => label), ["SIP URI", "Trunk"]);
  assert.equal(movedTrunk.expectedSipUri, "sip:+11009999002@legacy.byoc.usw2.pure.cloud");

  // Switching the handoff mode changes which Telnyx tools the assistant carries,
  // so it needs a republish even though no SIP URI moves.
  const inviteMode = webCallDeploymentDrift(current, {
    voiceProfile: { ...voiceProfile, config: { ...voiceProfile.config, keepAssistantOnCall: true } },
    trunks,
  });
  assert.deepEqual(inviteMode.reasons, [
    { label: "Handoff", from: "SIP Transfer", to: "Invite + Skip Turn" },
  ]);

  // A messaging-only widget has no voice routing to drift.
  assert.equal(
    webCallDeploymentDrift({ config: { voiceEnabled: false } }, { voiceProfile, trunks }).needsRepublish,
    false
  );
  assert.equal(
    webCallDeploymentsNeedingRepublish([published, { config: { voiceEnabled: false } }], { voiceProfile, trunks }).length,
    1
  );
});

test("the Web Calls page offers republishing instead of sending the user elsewhere", async () => {
  const console_ = await readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8");
  assert.match(console_, /const republishWidget = async \(widgetId\) =>/);
  assert.match(console_, /\/api\/admin\/widgets\/\$\{encodeURIComponent\(widgetId\)\}\/publish/);
  assert.match(console_, /JSON\.stringify\(\{ forceInfrastructure: true \}\)/);
  assert.match(console_, /Republish all \(\{driftedDeployments\.length\}\)/);
  assert.match(console_, /Needs republish/);
  // The hint must not still claim saving is the end of the process.
  assert.doesNotMatch(console_, /it does not deploy or modify Genesys resources/);
  assert.match(console_, /published widgets keep their current routing until each one is republished below/);
});
