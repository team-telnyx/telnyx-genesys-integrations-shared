import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseDotenv } from "dotenv";
import {
  assistantInstructions,
  ensureIntegrationSecret,
  findAssistantByExactName,
  GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS,
  hangupToolDefinition,
  handoffSecretIdentifier,
  handoffToolDefinition,
  handoffToolFunctionName,
  MANAGED_ASSISTANT_TAGS,
  prepareGenesysAudioAssistantInstructions,
  selectedQueueNames,
  TELNYX_PRODUCT_ASSISTANT_GREETING,
} from "../scripts/provision-telnyx-genesys-assistant.mjs";
import {
  assistantRouteExpression,
  groupAssistantRoutes,
  normalizeAssistantRoutes,
} from "../scripts/provision-genesys-audio-connector-flow.mjs";
import {
  assertAudioInstallationPlanSnapshot,
  audioInstallationOperations,
  audioInstallationStepLabels,
  bootstrapMissingAudioSecrets,
  clearManagedPublicBaseUrl,
  createAudioInstallationPlan,
  ensureAudioConnectorDeployment,
  generateAudioSecrets,
  inspectManagedAudioDeployment,
  listAudioConnectorIntegrations,
  listGenesysGroups,
  listGenesysQueues,
  managedQuickTunnelEnvironmentWriteOptions,
  managedHandoffScriptNeedsReconcile,
  managedInteractionWidgetNeedsReconcile,
  mergeEnvironmentFile,
  missingAudioSecretNames,
  normalizeInstallerConfigurationValue,
  resolveAudioConnectorDeploymentTarget,
  syncManagedDeploymentUrls,
  destroyManagedAudioDeployment,
} from "../scripts/manage-genesys-audio.mjs";
import {
  ensureGenesysAiInteractionWidget,
  ensureWidgetOauthRedirectUri,
  INTERACTION_WIDGET_COMMUNICATION_TYPES,
  oauthRedirectUrisForBaseUrl,
  renderGenesysAiHandoffScript,
  selectedGroups,
} from "../scripts/provision-genesys-ai-agent-experience.mjs";
import {
  AudioHookPcmPacketizer,
  GENESYS_AUDIOHOOK_L16_MEDIA,
  GENESYS_AUDIOHOOK_MEDIA,
  decodeAudioHookAudio,
  encodeAudioHookAudio,
  preferredAudioHookMediaFormat,
  requireAudioHookAssistantId,
  selectAudioHookMedia,
} from "../lib/genesys/audiohook-protocol.js";
import { RealtimeAudioPacer } from "../lib/genesys/realtime-audio-pacer.js";
import { verifyGenesysAudioHookRequest } from "../lib/genesys/audiohook-auth.js";
import {
  handleAudioConnectorSession,
  normalizeAudioConnectorHandoffRequest,
} from "../lib/genesys/audio-connector-handler.js";
import {
  ensureAudioCallRoute,
  resolveAudioCallRoute,
} from "../lib/genesys/audio-call-route.mjs";
import {
  assertTelnyxTelephoneTargetNormalization,
  TELNYX_DYNAMIC_VARIABLE_INPUT_PREFIX,
  buildTelnyxSessionUpdate,
  normalizeGenesysTelephoneTarget,
} from "../lib/genesys/telnyx-session-update.js";
import {
  createGenesysAudioConnectorLogger,
  genesysAudioConnectorDebugEnabled,
  isAudioConnectorMediaEvent,
  summarizeAudioConnectorJson,
} from "../lib/genesys/audio-connector-logger.js";
import {
  collectGenesysConversationAttributes,
  normalizeGenesysWidgetChannel,
  parseTelnyxWidgetValue,
  sipHeaderValue,
} from "../lib/genesys/ai-conversation-widget.js";
import {
  GENESYS_HANDOFF_TOOL_FUNCTION_NAME,
  isGenesysHandoffToolFunctionName,
} from "../lib/genesys/handoff-tool-name.js";
import {
  GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES,
  GENESYS_AUDIO_PLACEHOLDER_DNIS,
  genesysAudioDnisManualAction,
  genesysAudioDnisValues,
} from "../lib/genesys/audio-connector-flow-config.mjs";
import {
  genesysAudioDeploymentName,
  genesysAudioConnectorBaseUri,
  publicGenesysBaseUrl,
} from "../lib/genesys/audio-connector-config.mjs";
import {
  GENESYS_AUDIO_WEBSOCKET_PATH,
  attachGenesysAudioConnector,
  isGenesysAudioWebSocketPath,
  missingGenesysAudioRuntimeVariables,
} from "../lib/genesys/audio-connector-server.mjs";
import {
  checkTunnelHealth,
  getQuickTunnelStatus,
  isCloudflareQuickTunnelUrl,
  managedQuickTunnelCanBeReused,
  parseCloudflareQuickTunnelUrl,
  processIsRunning,
  quickTunnelPaths,
  readQuickTunnelState,
  startCloudflareQuickTunnel,
  stopCloudflareQuickTunnel,
} from "../lib/genesys/cloudflare-quick-tunnel.mjs";

// A Quick Tunnel health probe is identified by its host, not by a substring of
// the URL: "trycloudflare.com" appears in https://evil.test/?x=trycloudflare.com
// too, and a mock that answers differently for it would be testing the wrong
// thing. Mirrors the anchored check in lib/genesys/cloudflare-quick-tunnel.mjs.
function isQuickTunnelHost(url) {
  try {
    return /^[a-z0-9-]+\.trycloudflare\.com$/i.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("new Audio Connector planning resolves installation-scoped resource names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-audio-new-plan-"));
  try {
    await assert.rejects(
      createAudioInstallationPlan({
        queues: [{ id: "queue-1", name: "Support" }],
        groups: [],
        integrations: [],
      }, {
        applicationName: "Telnyx Integrations",
        deploymentId: "CECA32",
        queueIds: ["queue-1"],
        defaultQueueId: "queue-1",
        widgetGroupIds: [],
        assistantRoutes: [{ dnis: "+48123456789", assistantId: "assistant-1" }],
        defaultAssistant: { enabled: false },
        options: { "state-dir": directory },
      }),
      /Select at least one Genesys group for Agent Experience access/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Audio Connector debug logging is opt-in and identifies media events", () => {
  assert.equal(genesysAudioConnectorDebugEnabled({}), false);
  assert.equal(
    genesysAudioConnectorDebugEnabled({ GC_AUDIO_CONNECTOR_DEBUG: "false" }),
    false
  );
  for (const value of ["true", "TRUE", "1", "yes", "on"]) {
    assert.equal(
      genesysAudioConnectorDebugEnabled({ GC_AUDIO_CONNECTOR_DEBUG: value }),
      true
    );
  }

  const entries = [];
  const logger = {
    info(...values) { entries.push(values); },
  };
  let lazyMessageEvaluated = false;
  const disabledLogger = createGenesysAudioConnectorLogger({
    environment: {},
    logger,
  });
  disabledLogger.info("hidden");
  disabledLogger.wire("Genesys -> Telnyx", () => {
    lazyMessageEvaluated = true;
    return "hidden";
  });
  assert.deepEqual(entries, []);
  assert.equal(lazyMessageEvaluated, false);

  assert.equal(
    isAudioConnectorMediaEvent({ type: "input_audio_buffer.append" }),
    true
  );
  assert.equal(
    isAudioConnectorMediaEvent({ type: "response.output_audio.delta" }),
    true
  );
  assert.equal(isAudioConnectorMediaEvent({ type: "response.done" }), false);

  createGenesysAudioConnectorLogger({
    environment: { GC_AUDIO_CONNECTOR_DEBUG: "true" },
    logger,
  }).wire("Genesys -> Telnyx", "visible");
  assert.deepEqual(entries, [[
    "[genesys-audio-connector]",
    "Genesys -> Telnyx:",
    "visible",
  ]]);

  const summary = summarizeAudioConnectorJson({
    type: "input_audio_buffer.append",
    audio: Buffer.alloc(320).toString("base64"),
  });
  assert.doesNotMatch(summary, /AAAA/);
  assert.match(summary, /base64 audio: 320 bytes/);

  const openSummary = summarizeAudioConnectorJson({
    type: "open",
    parameters: {
      inputVariables: {
        assistantId: "assistant-secret-context",
        telnyxVar_customer_name: "Ada Lovelace",
      },
    },
  });
  assert.match(openSummary, /assistantId/);
  assert.match(openSummary, /telnyxVar_customer_name/);
  assert.doesNotMatch(openSummary, /assistant-secret-context|Ada Lovelace/);
  assert.match(openSummary, /<redacted>/);
});

test("selected Genesys queues are unique, required, and preserved exactly", () => {
  assert.deepEqual(selectedQueueNames('["Tier 1 Support","Sales EMEA","Tier 1 Support"]'), [
    "Tier 1 Support",
    "Sales EMEA",
  ]);
  assert.throws(() => selectedQueueNames("[]"), /Select at least one Genesys queue/);
});

test("Audio deployments use the installation name without exposing the technical ID", () => {
  assert.equal(
    genesysAudioDeploymentName("Customer Assistant", "a1b2c3"),
    "Customer Assistant"
  );
  assert.throws(() => genesysAudioDeploymentName("Customer Assistant", "short"), /6 hexadecimal/);
});

test("Audio deployment planning never adopts an unrelated connector and enforces capacity", () => {
  const unrelated = { id: "existing", name: "Audio Connector" };
  assert.deepEqual(
    resolveAudioConnectorDeploymentTarget([unrelated], "Customer Assistant (A1B2C3)"),
    { integration: null, created: true }
  );
  const managed = { id: "managed", name: "Customer Assistant (A1B2C3)" };
  assert.deepEqual(
    resolveAudioConnectorDeploymentTarget([unrelated, managed], managed.name),
    { integration: managed, created: false }
  );
  assert.throws(
    () => resolveAudioConnectorDeploymentTarget(
      Array.from({ length: 5 }, (_, index) => ({ id: String(index), name: `Existing ${index}` })),
      "Customer Assistant (A1B2C3)"
    ),
    /capacity is full \(5\/5\)/
  );
});

test("Audio plan snapshots detect a shared Telnyx handoff tool created, deleted, or replaced after review", async () => {
  const telnyxWithTools = (tools) => ({
    ai: {
      tools: {
        list() {
          return (async function* listTools() {
            for (const tool of tools) yield tool;
          })();
        },
      },
    },
  });
  const existing = { id: "tool-1", display_name: "Telnyx Integrations" };
  const createdByWebChat = {
    id: "tool-chat-1",
    display_name: "Web Chat shared handoff",
    tool_definition: {
      type: "webhook",
      webhook: { name: "request_genesys_human_handoff" },
    },
  };
  const legacyAudioToolWithSharedDisplayName = {
    id: "tool-audio-legacy",
    display_name: "Telnyx Integrations",
    tool_definition: {
      type: "webhook",
      webhook: { name: "request_genesys_human_handoff_a1b2c3" },
    },
  };
  const duplicateSharedTool = {
    id: "tool-shared-duplicate",
    display_name: "Telnyx Integrations",
    tool_definition: {
      type: "webhook",
      webhook: { name: "request_genesys_human_handoff" },
    },
  };

  await assert.rejects(
    assertAudioInstallationPlanSnapshot({
      schemaVersion: 10,
      telnyxHandoffTool: { action: "CREATE", id: null },
    }, { telnyx: telnyxWithTools([duplicateSharedTool, createdByWebChat]) }),
    /created after plan review/
  );

  await assert.doesNotReject(() => assertAudioInstallationPlanSnapshot({
    schemaVersion: 10,
    telnyxHandoffTool: { action: "CREATE", id: null },
  }, { telnyx: telnyxWithTools([]) }));
  await assert.doesNotReject(() => assertAudioInstallationPlanSnapshot({
    schemaVersion: 10,
    telnyxHandoffTool: { action: "UPDATE", id: "tool-1" },
  }, { telnyx: telnyxWithTools([existing]) }));
  await assert.rejects(
    assertAudioInstallationPlanSnapshot({
      schemaVersion: 10,
      telnyxHandoffTool: { action: "UPDATE", id: "tool-1" },
    }, { telnyx: telnyxWithTools([]) }),
    /deleted after plan review/
  );
  await assert.rejects(
    assertAudioInstallationPlanSnapshot({
      schemaVersion: 10,
      telnyxHandoffTool: { action: "CREATE", id: null },
    }, { telnyx: telnyxWithTools([existing]) }),
    /created after plan review/
  );
  await assert.doesNotReject(() => assertAudioInstallationPlanSnapshot({
    schemaVersion: 10,
    telnyxHandoffTool: { action: "UPDATE", id: "tool-chat-1" },
  }, {
    telnyx: telnyxWithTools([
      legacyAudioToolWithSharedDisplayName,
      duplicateSharedTool,
      createdByWebChat,
    ]),
  }));
  await assert.doesNotReject(() => assertAudioInstallationPlanSnapshot({
    schemaVersion: 10,
    telnyxHandoffTool: { action: "UPDATE", id: "tool-chat-1" },
  }, {
    telnyx: {
      ai: {
        tools: {
          async retrieve(id) {
            assert.equal(id, "tool-chat-1");
            return {
              id,
              display_name: "Renamed by an administrator",
              tool_definition: {
                type: "webhook",
                webhook: { name: "also_renamed_by_an_administrator" },
              },
            };
          },
          async *list() {
            yield duplicateSharedTool;
            yield createdByWebChat;
          },
        },
      },
    },
  }));
  await assert.rejects(
    assertAudioInstallationPlanSnapshot({
      schemaVersion: 10,
      telnyxHandoffTool: { action: "CREATE", id: null },
    }, { telnyx: telnyxWithTools([createdByWebChat]) }),
    /created after plan review/
  );
});

test("managed Audio call route assigns selected DNIS values to the published flow", async () => {
  let createdBody;
  const result = await ensureAudioCallRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [] }; },
      async postArchitectIvrs(body) {
        createdBody = body;
        return { id: "route-1", ...body };
      },
    },
    name: "Telnyx Integrations",
    dnis: ["+16195550140", "+16195550141"],
    flow: { id: "flow-1", name: "Telnyx Integrations" },
    deploymentId: "CECA32",
  });
  assert.equal(result.created, true);
  assert.deepEqual(createdBody.dnis, ["+16195550140", "+16195550141"]);
  assert.deepEqual(createdBody.openHoursFlow, { id: "flow-1", name: "Telnyx Integrations" });
  assert.match(createdBody.description, /Managed by genesys:audio; deployment CECA32/);
  assert.throws(() => resolveAudioCallRoute({
    ivrs: [{ id: "other-route", name: "Existing route", dnis: ["+16195550140"] }],
    name: "Telnyx Integrations",
    dnis: ["+16195550140"],
    deploymentId: "CECA32",
  }), /already assigned to call route Existing route/);

  let updatedBody;
  const updated = await ensureAudioCallRoute({
    architectApi: {
      async getArchitectIvrs() {
        return {
          entities: [{
            id: "route-1",
            name: "Telnyx Integrations",
            description: "Managed by genesys:audio; deployment CECA32",
            dnis: ["+16195550140"],
          }],
        };
      },
      async putArchitectIvr(id, body) {
        assert.equal(id, "route-1");
        updatedBody = body;
        return { id, ...body };
      },
    },
    ivrId: "route-1",
    name: "Telnyx Integrations",
    dnis: ["+16195550141"],
    flow: { id: "flow-1", name: "Telnyx Integrations" },
    deploymentId: "CECA32",
  });
  assert.equal(updated.created, false);
  assert.deepEqual(updatedBody.dnis, ["+16195550141"]);
  assert.deepEqual(updatedBody.openHoursFlow, { id: "flow-1", name: "Telnyx Integrations" });
});

test("managed Audio call route reassigns an explicitly approved DID from its previous route", async () => {
  const source = {
    id: "source-route",
    name: "Telnyx Call Route",
    description: "Existing customer route",
    dnis: ["+48123123010", "+48123123011"],
    openHoursFlow: { id: "old-flow", name: "Old flow" },
  };
  const managed = {
    id: "managed-route",
    name: "Telnyx Integrations",
    description: "Managed by genesys:audio; deployment CECA32",
    dnis: ["+16195550140"],
  };
  const takeovers = resolveAudioCallRoute({
    ivrs: [source, managed],
    ivrId: managed.id,
    name: managed.name,
    dnis: ["+48123123010"],
    deploymentId: "CECA32",
    takeoverDnis: ["+48123123010"],
  }).takeovers;
  const updates = [];
  const result = await ensureAudioCallRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [source, managed] }; },
      async putArchitectIvr(id, body) {
        updates.push({ id, body });
        return { id, ...body };
      },
    },
    ivrId: managed.id,
    name: managed.name,
    dnis: ["+48123123010"],
    flow: { id: "flow-1", name: "Telnyx Integrations" },
    deploymentId: "CECA32",
    takeovers,
  });

  assert.deepEqual(updates.map(({ id }) => id), ["source-route", "managed-route"]);
  assert.deepEqual(updates[0].body.dnis, ["+48123123011"]);
  assert.deepEqual(updates[0].body.openHoursFlow, { id: "old-flow", name: "Old flow" });
  assert.deepEqual(updates[1].body.dnis, ["+48123123010"]);
  assert.deepEqual(result.takeovers, takeovers);
});

test("managed Audio call route rejects a takeover when DID ownership changed after review", async () => {
  const source = { id: "source-route", name: "Current route", dnis: ["+48123123010", "+48123123012"] };
  await assert.rejects(ensureAudioCallRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [source] }; },
    },
    name: "Telnyx Integrations",
    dnis: ["+48123123010"],
    flow: { id: "flow-1", name: "Telnyx Integrations" },
    deploymentId: "CECA32",
    takeovers: [{
      dnis: "+48123123010",
      routeId: "source-route",
      routeName: "Current route",
      routeDnis: ["+48123123010"],
    }],
  }), /ownership changed after plan review/);
});

test("managed Audio call route validates a directly assigned Person before claiming the DID", async () => {
  let createdBody;
  const userPatches = [];
  const ownerTakeovers = [{
    dnis: "+48123123020",
    didId: "did-1",
    ownerId: "person-1",
    ownerName: "Jane Admin",
    ownerType: "USER",
  }];
  const result = await ensureAudioCallRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [] }; },
      async postArchitectIvrs(body) {
        createdBody = body;
        return { id: "managed-route", ...body };
      },
    },
    telephonyApi: {
      async getTelephonyProvidersEdgesDidpoolsDids() {
        return {
          entities: [{
            id: "did-1",
            number: "+48123123020",
            assigned: true,
            ownerType: "USER",
            owner: { id: "person-1", name: "Jane Admin" },
          }],
        };
      },
    },
    usersApi: {
      async getUser(id) {
        assert.equal(id, "person-1");
        return {
          id,
          version: 7,
          addresses: [
            { address: "+48123123020", mediaType: "PHONE", type: "WORK" },
            { address: "+48111222333", mediaType: "PHONE", type: "WORK2" },
          ],
          primaryContactInfo: [{ address: "+48123123020", mediaType: "PHONE", type: "WORK" }],
        };
      },
      async patchUser(id, body) {
        userPatches.push({ id, body });
        return { id, version: body.version + 1, ...body };
      },
    },
    name: "Telnyx Integrations",
    dnis: ["+48123123020"],
    flow: { id: "flow-1", name: "Telnyx Integrations" },
    deploymentId: "CECA32",
    ownerTakeovers,
  });
  assert.deepEqual(createdBody.dnis, ["+48123123020"]);
  assert.deepEqual(result.ownerTakeovers, ownerTakeovers);
  assert.deepEqual(userPatches[0].body.addresses, [
    { address: "+48111222333", mediaType: "PHONE", type: "WORK2" },
  ]);
  assert.deepEqual(userPatches[0].body.primaryContactInfo, []);

  await assert.rejects(ensureAudioCallRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [] }; },
    },
    telephonyApi: {
      async getTelephonyProvidersEdgesDidpoolsDids() {
        return {
          entities: [{
            id: "did-1",
            number: "+48123123020",
            assigned: true,
            ownerType: "QUEUE",
            owner: { id: "queue-2", name: "Sales" },
          }],
        };
      },
    },
    name: "Telnyx Integrations",
    dnis: ["+48123123020"],
    flow: { id: "flow-1", name: "Telnyx Integrations" },
    deploymentId: "CECA32",
    ownerTakeovers,
  }), /ownership changed after plan review/);
});

test("managed Audio call route restores the source route if target reassignment fails", async () => {
  const source = {
    id: "source-route",
    name: "Telnyx Call Route",
    description: "Existing customer route",
    dnis: ["+48123123010", "+48123123011"],
  };
  const managed = {
    id: "managed-route",
    name: "Telnyx Integrations",
    description: "Managed by genesys:audio; deployment CECA32",
    dnis: ["+16195550140"],
  };
  const takeovers = resolveAudioCallRoute({
    ivrs: [source, managed],
    ivrId: managed.id,
    name: managed.name,
    dnis: ["+48123123010"],
    deploymentId: "CECA32",
    takeoverDnis: ["+48123123010"],
  }).takeovers;
  const updates = [];
  await assert.rejects(ensureAudioCallRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [source, managed] }; },
      async putArchitectIvr(id, body) {
        updates.push({ id, body });
        if (id === managed.id) throw new Error("target update failed");
        return { id, ...body };
      },
    },
    ivrId: managed.id,
    name: managed.name,
    dnis: ["+48123123010"],
    flow: { id: "flow-1", name: "Telnyx Integrations" },
    deploymentId: "CECA32",
    takeovers,
  }), /target update failed/);
  assert.deepEqual(updates.map(({ id }) => id), ["source-route", "managed-route", "source-route"]);
  assert.deepEqual(updates[2].body.dnis, source.dnis);
});

test("Audio deployment apply creates a dedicated connector and never patches an unrelated one", async () => {
  const calls = [];
  const created = await ensureAudioConnectorDeployment(
    {
      async getIntegrations() {
        return { entities: [{ id: "unrelated", name: "Audio Connector" }] };
      },
      async postIntegrations(request) {
        calls.push(request);
        return {
          id: "managed",
          name: request.body.name,
          integrationType: { id: "audio-connector" },
        };
      },
    },
    "Telnyx Integrations"
  );
  assert.equal(created.created, true);
  assert.equal(created.integration.id, "managed");
  assert.deepEqual(calls, [{
    body: {
      name: "Telnyx Integrations",
      integrationType: { id: "audio-connector" },
    },
  }]);
});

test("Audio apply limits an Agent access groups change to the interaction widget", () => {
  const plan = {
    audioConnector: { operation: "update-managed" },
    changes: {
      isCreate: false,
      handoffToolChanged: false,
      audioConnectorChanged: false,
      architectFlowChanged: false,
      callRouteChanged: false,
      interactionWidgetChanged: true,
      handoffScriptChanged: false,
      addedAssistants: [],
      removedAssistants: [],
    },
  };
  assert.deepEqual(audioInstallationOperations(plan), {
    managedAssistant: false,
    assistants: false,
    interactionWidget: true,
    handoffScript: false,
    audioConnector: false,
    architectFlow: false,
    callRoute: false,
  });
  assert.deepEqual(audioInstallationStepLabels(plan), [
    "Validate the managed Audio Connector deployment and live resource snapshot",
    "Update Genesys Agent Experience interaction widget",
    "Persist the managed Audio Connector manifest",
  ]);
});

test("Audio planning repairs a missing or unpublished managed handoff script", async () => {
  const deployment = { resources: { scriptId: "script-1" } };
  const scriptsApi = {
    async getScript() { return { id: "script-1", name: "Managed handoff" }; },
    async getScriptsPublished() { return { entities: [] }; },
  };
  assert.equal(
    await managedHandoffScriptNeedsReconcile({ scriptsApi }, deployment, "Managed handoff"),
    true
  );
  scriptsApi.getScriptsPublished = async () => ({
    entities: [{ id: "script-1", name: "Managed handoff" }],
  });
  assert.equal(
    await managedHandoffScriptNeedsReconcile({ scriptsApi }, deployment, "Managed handoff"),
    false
  );
  scriptsApi.getScript = async () => null;
  assert.equal(
    await managedHandoffScriptNeedsReconcile({ scriptsApi }, deployment, "Managed handoff"),
    true
  );
});

test("Audio planning detects live Agent Experience widget drift", async () => {
  const deployment = { resources: { widgetId: "widget-1" } };
  const widget = {
    id: "widget-1",
    name: "Managed Widget",
    integrationType: { id: "embedded-client-app-interaction-widget" },
    intendedState: "ENABLED",
  };
  const properties = {
    url: "https://widgets.example.com/genesys/ai-conversation-widget?conversationId={{gcConversationId}}",
    groups: ["group-1"],
    queueIdFilterList: ["queue-1"],
  };
  const context = {
    integrationsApi: {
      async getIntegration() { return widget; },
      async getIntegrationConfigCurrent() { return { properties }; },
    },
  };
  const expected = {
    expectedName: "Managed Widget",
    baseUrl: "https://widgets.example.com",
    groupIds: ["group-1"],
    queueIds: ["queue-1"],
  };

  assert.equal(
    await managedInteractionWidgetNeedsReconcile(context, deployment, expected),
    false
  );
  properties.groups.push("unexpected-group");
  assert.equal(
    await managedInteractionWidgetNeedsReconcile(context, deployment, expected),
    true
  );
  properties.groups.pop();
  widget.intendedState = "DISABLED";
  assert.equal(
    await managedInteractionWidgetNeedsReconcile(context, deployment, expected),
    true
  );
});

test("Audio apply derives only the dependencies required by queue and routing changes", () => {
  const queuePlan = {
    audioConnector: { operation: "update-managed" },
    changes: {
      queuePolicyChanged: true,
      handoffToolChanged: true,
      interactionWidgetChanged: true,
      addedAssistants: [],
      removedAssistants: [],
    },
  };
  assert.deepEqual(audioInstallationOperations(queuePlan), {
    managedAssistant: false,
    assistants: true,
    interactionWidget: true,
    handoffScript: false,
    audioConnector: false,
    architectFlow: false,
    callRoute: false,
  });
  const routePlan = {
    audioConnector: { operation: "update-managed" },
    changes: {
      architectFlowChanged: true,
      callRouteChanged: false,
      addedAssistants: [],
      removedAssistants: [],
    },
  };
  assert.deepEqual(audioInstallationOperations(routePlan), {
    managedAssistant: false,
    assistants: false,
    interactionWidget: false,
    handoffScript: false,
    audioConnector: false,
    architectFlow: true,
    callRoute: false,
  });
});

test("OAuth redirect rotation preserves custom callbacks and replaces stale Quick Tunnels", () => {
  assert.deepEqual(
    oauthRedirectUrisForBaseUrl(
      [
        "http://localhost:3000/api/auth/callback",
        "https://old-demo.trycloudflare.com/api/auth/callback",
        "https://integrations.example.com/api/auth/callback",
      ],
      "https://new-demo.trycloudflare.com"
    ),
    [
      "http://localhost:3000/api/auth/callback",
      "https://integrations.example.com/api/auth/callback",
      "https://new-demo.trycloudflare.com/api/auth/callback",
    ]
  );
});

test("widget OAuth provisioning updates the Code Authorization client without losing scopes", async () => {
  let update;
  const result = await ensureWidgetOauthRedirectUri(
    {
      async getOauthClient() {
        return {
          name: "Widget OAuth",
          authorizedGrantType: "CODE",
          registeredRedirectUri: ["https://old-demo.trycloudflare.com/api/auth/callback"],
          scope: ["conversations", "users"],
          accessTokenValiditySeconds: 3600,
        };
      },
      async putOauthClient(clientId, body) {
        update = { clientId, body };
        return body;
      },
    },
    "oauth-client-id",
    "https://new-demo.trycloudflare.com"
  );
  assert.equal(result.updated, true);
  assert.equal(update.clientId, "oauth-client-id");
  assert.equal(update.body.accessTokenValiditySeconds, 86_400);
  assert.deepEqual(update.body.scope, ["conversations", "users"]);
  assert.deepEqual(update.body.registeredRedirectUri, [
    "https://new-demo.trycloudflare.com/api/auth/callback",
  ]);
});

test("widget OAuth provisioning adds required scopes to an existing client", async () => {
  let update;
  const result = await ensureWidgetOauthRedirectUri(
    {
      async getOauthClient() {
        return {
          name: "Admin OAuth",
          authorizedGrantType: "CODE",
          registeredRedirectUri: ["https://integrations.example.com/api/auth/callback"],
          scope: ["users", "organization:readonly"],
          accessTokenValiditySeconds: 3600,
        };
      },
      async putOauthClient(clientId, body) {
        update = { clientId, body };
        return body;
      },
    },
    "oauth-client-id",
    "https://integrations.example.com",
    { requiredScopes: ["users", "authorization:readonly"] }
  );
  assert.equal(result.updated, true);
  assert.equal(update.clientId, "oauth-client-id");
  assert.equal(update.body.accessTokenValiditySeconds, 86_400);
  assert.deepEqual(update.body.scope, [
    "users",
    "organization:readonly",
    "authorization:readonly",
  ]);
  assert.deepEqual(update.body.registeredRedirectUri, [
    "https://integrations.example.com/api/auth/callback",
  ]);
});

test("public URL rotation synchronizes every managed remote resource and manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-audio-deployment-sync-"));
  const filePath = path.join(directory, "A1B2C3.json");
  const calls = [];
  const deployment = {
    schemaVersion: 1,
    filePath,
    deployment: { id: "A1B2C3", name: "Customer Assistant (A1B2C3)" },
    queues: [{ id: "queue-1", name: "Support" }],
    groups: [{ id: "group-1", name: "Agents" }],
    resources: {
      assistantId: "assistant-old",
      toolId: "tool-old",
      hangupToolId: "hangup-old",
      audioConnectorIntegrationId: "connector-1",
      widgetId: "widget-old",
    },
  };
  try {
    await writeFile(filePath, JSON.stringify(deployment));
    const results = await syncManagedDeploymentUrls({
      deployments: [deployment],
      baseUrl: "https://new-demo.trycloudflare.com",
      async provisioner(script, environment, args) {
        calls.push({ script, environment, args });
        if (script.includes("telnyx")) {
          return {
            assistants: [{ id: "assistant-old" }],
            tool: { id: "tool-new", displayName: "Genesys Handoff", functionName: "request_genesys_human_handoff" },
          };
        }
        if (script.includes("agent-experience")) return { widget: { id: "widget-new" } };
        return { audioConnectorIntegration: { id: "connector-1" } };
      },
    });
    assert.equal(calls.length, 3);
    assert.ok(calls[1].args.includes("--widget-only"));
    assert.ok(calls[2].args.includes("--configure-only"));
    assert.equal(results[0].publicBaseUrl, "https://new-demo.trycloudflare.com");
    const saved = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(saved.publicBaseUrl, "https://new-demo.trycloudflare.com");
    assert.equal(saved.resourceNames.publicBaseUrl, "https://new-demo.trycloudflare.com");
    assert.equal(saved.resources.assistantId, "assistant-old");
    assert.equal(saved.resources.toolId, "tool-new");
    assert.equal(saved.resources.hangupToolId, "hangup-old");
    assert.equal(saved.resources.widgetId, "widget-new");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function managedDeploymentFixture(filePath) {
  return {
    schemaVersion: 1,
    filePath,
    deployment: {
      id: "A1B2C3",
      applicationName: "Telnyx Integrations",
      name: "Telnyx Integrations",
    },
    environment: "usw2.pure.cloud",
    organization: { id: "org-1", name: "Example" },
    publicBaseUrl: "https://integrations.example.com",
    queues: [{ id: "queue-1", name: "Support" }],
    groups: [{ id: "group-1", name: "Agents" }],
    architect: { dnis: ["+15550001001", "+15550001002", "+15550001003"] },
    resourceNames: {
      publicBaseUrl: "https://integrations.example.com",
      callRouteName: "Telnyx Integrations",
      flowName: "Telnyx Integrations",
      widgetName: "Telnyx Integrations",
      handoffScriptName: "Telnyx Integrations",
      toolDisplayName: "Telnyx Integrations",
    },
    resources: {
      assistantId: "assistant-1",
      toolId: "tool-1",
      toolDisplayName: "Telnyx Integrations",
      hangupToolId: "hangup-tool-1",
      audioConnectorIntegrationId: "connector-1",
      widgetId: "widget-1",
      flowId: "flow-1",
      callRouteId: "call-route-1",
      scriptId: "script-1",
    },
  };
}

function managedDeploymentClients({ connectorName = "Telnyx Integrations" } = {}) {
  const deleted = [];
  const disabled = new Set();
  const context = {
    environment: "usw2.pure.cloud",
    organization: { id: "org-1", name: "Example" },
    integrationsApi: {
      async getIntegration(id) {
        if (id === "connector-1") {
          return {
            id,
            name: connectorName,
            integrationType: { id: "audio-connector" },
            intendedState: disabled.has(id) ? "DISABLED" : "ENABLED",
            reportedState: { code: disabled.has(id) ? "INACTIVE" : "ACTIVE" },
          };
        }
        return {
          id,
          name: "Telnyx Integrations",
          integrationType: { id: "embedded-client-app-interaction-widget" },
          intendedState: disabled.has(id) ? "DISABLED" : "ENABLED",
          reportedState: { code: disabled.has(id) ? "INACTIVE" : "ACTIVE" },
        };
      },
      async patchIntegration(id, { body }) {
        if (body.intendedState === "DISABLED") disabled.add(id);
        deleted.push(`disable:${id}`);
      },
      async getIntegrationConfigCurrent(id) {
        if (id === "connector-1") {
          return {
            properties: { baseUri: "wss://integrations.example.com/api/genesys/audio-connector/ws" },
            credentials: { audioHook: { id: "credential-1", type: { name: "audioHook" } } },
          };
        }
        return { properties: { url: "https://integrations.example.com/widget" } };
      },
      async deleteIntegration(id) { deleted.push(`integration:${id}`); },
      async deleteIntegrationsCredential(id) { deleted.push(`credential:${id}`); },
    },
    architectApi: {
      async getFlow(id) { return { id, name: "Telnyx Integrations" }; },
      async getArchitectIvr(id) { return { id, name: "Telnyx Integrations" }; },
      async deleteArchitectIvr(id) { deleted.push(`call-route:${id}`); },
      async deleteFlow(id) { deleted.push(`flow:${id}`); },
    },
    scriptsApi: {
      async getScript(id) { return { id, name: "Telnyx Integrations" }; },
    },
  };
  const telnyx = {
    ai: {
      assistants: {
        async retrieve(id) { return { id, name: "Telnyx Integrations" }; },
        async delete(id) { deleted.push(`assistant:${id}`); },
      },
      tools: {
        async retrieve(id) {
          if (id === "hangup-tool-1") {
            return {
              id,
              display_name: "Telnyx Integrations",
              type: "hangup",
              tool_definition: { description: "End the voice call." },
            };
          }
          return {
            id,
            display_name: "Telnyx Integrations",
            webhook: { url: "https://integrations.example.com/api/genesys/handoff" },
          };
        },
        async delete(id) { deleted.push(`tool:${id}`); },
      },
    },
  };
  return { context, telnyx, deleted };
}

test("managed Audio deployment review binds every remote object to manifest ID, name and type", async () => {
  const deployment = managedDeploymentFixture("/tmp/not-written.json");
  const { context, telnyx } = managedDeploymentClients();
  const inspection = await inspectManagedAudioDeployment({ deployment, context, telnyx });
  assert.ok(Object.values(inspection.resources).every(({ state }) => state === "ok"));

  const drifted = managedDeploymentClients({ connectorName: "Unrelated connector" });
  const driftInspection = await inspectManagedAudioDeployment({
    deployment,
    context: drifted.context,
    telnyx: drifted.telnyx,
  });
  assert.equal(driftInspection.resources.audioConnector.state, "drift");
  assert.match(driftInspection.resources.audioConnector.detail, /Unrelated connector/);
});

test("managed Audio deployment destroy deletes only manifest-owned resources and archives state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-audio-destroy-"));
  const manifestPath = path.join(directory, "deployments", "A1B2C3.json");
  const deployment = managedDeploymentFixture(manifestPath);
  const { context, telnyx, deleted } = managedDeploymentClients();
  try {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(deployment));
    const result = await destroyManagedAudioDeployment({
      deployment,
      context,
      telnyx,
      options: { "state-dir": directory },
    });
    assert.deepEqual(deleted, [
      "call-route:call-route-1",
      "flow:flow-1",
      "disable:widget-1",
      "integration:widget-1",
      "disable:connector-1",
      "integration:connector-1",
      "credential:credential-1",
      "assistant:assistant-1",
      "tool:tool-1",
      "tool:hangup-tool-1",
    ]);
    assert.equal((await lstat(result.archivedPath)).isFile(), true);
    const journal = JSON.parse(await readFile(result.journalPath, "utf8"));
    assert.equal(journal.status, "completed");
    assert.equal(journal.steps.at(-1).status, "retained");
    assert.equal(journal.steps.at(-1).label, "Retain Genesys handoff script");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed Audio deployment destroy refuses name drift before deleting anything", async () => {
  const deployment = managedDeploymentFixture("/tmp/not-written.json");
  const { context, telnyx, deleted } = managedDeploymentClients({
    connectorName: "Existing customer connector",
  });
  await assert.rejects(
    destroyManagedAudioDeployment({ deployment, context, telnyx }),
    /ownership validation failed.*audioConnector/
  );
  assert.deepEqual(deleted, []);
});

test("managed Telnyx assistant tags satisfy the API length limit", () => {
  assert.ok(MANAGED_ASSISTANT_TAGS.length > 0);
  assert.ok(MANAGED_ASSISTANT_TAGS.every((tag) => tag.length <= 20));
});

test("assistant discovery paginates the Telnyx SDK data envelope", async () => {
  const target = { id: "assistant-target", name: "Genesys Audio Connector Assistant" };
  const requestedPages = [];
  const telnyx = {
    ai: {
      assistants: {
        async list(options) {
          const pageNumber = options.query.page.number;
          requestedPages.push(pageNumber);
          return pageNumber === 1
            ? {
                data: [{ id: "assistant-other", name: "Another assistant" }],
                meta: { total_pages: 2 },
              }
            : { data: [target], meta: { total_pages: 2 } };
        },
      },
    },
  };

  assert.equal(
    await findAssistantByExactName(telnyx, "Genesys Audio Connector Assistant"),
    target
  );
  assert.deepEqual(requestedPages, [1, 2]);
});

test("assistant discovery rejects malformed or ambiguous Telnyx responses", async () => {
  await assert.rejects(
    findAssistantByExactName(
      { ai: { assistants: { async list() { return { items: [] }; } } } },
      "Example"
    ),
    /unexpected response/
  );
  await assert.rejects(
    findAssistantByExactName(
      {
        ai: {
          assistants: {
            async list() {
              return { data: [{ name: "Example" }, { name: "Example" }] };
            },
          },
        },
      },
      "Example"
    ),
    /More than one Telnyx assistant/
  );
});

test("selected widget groups are explicit, unique Genesys resources", () => {
  assert.deepEqual(
    selectedGroups('[{"id":"g1","name":"Support"},{"id":"g1","name":"Support"}]'),
    [{ id: "g1", name: "Support" }]
  );
  assert.throws(() => selectedGroups("[]"), /groups selected by the installer/);
  assert.throws(() => selectedGroups('[{"name":"Support"}]'), /groups selected by the installer/);
});

test("Agent Experience uses the Genesys Open Messaging communication type", async () => {
  let updatedConfig;
  const integrationsApi = {
    async getIntegrations() {
      return { entities: [{ id: "widget-1", name: "Managed Widget" }] };
    },
    async getIntegrationConfigCurrent() {
      return {
        id: "current",
        name: "Managed Widget",
        version: 2,
        properties: {
          communicationTypeFilter: "call",
          groups: ["unexpected-group"],
          queueIdFilterList: ["unexpected-queue"],
        },
        credentials: {},
      };
    },
    async putIntegrationConfigCurrent(_id, request) {
      updatedConfig = request.body;
      return request.body;
    },
    async patchIntegration() {
      return { id: "widget-1", intendedState: "ENABLED" };
    },
  };
  const groupsApi = {
    async getGroups() {
      return { entities: [{ id: "group-1", name: "Agents" }] };
    },
  };
  const routingApi = {
    async getRoutingQueues() {
      return { entities: [{ id: "queue-1", name: "Support" }] };
    },
  };

  assert.equal(INTERACTION_WIDGET_COMMUNICATION_TYPES, "call,open");
  await ensureGenesysAiInteractionWidget({
    integrationsApi,
    groupsApi,
    routingApi,
    activate: true,
    queuesJson: '["Support"]',
    groupsJson: '[{"id":"group-1","name":"Agents"}]',
    widgetName: "Managed Widget",
    baseUrl: "https://widgets.example.com",
  });
  assert.equal(updatedConfig.properties.communicationTypeFilter, "call,open");
  assert.doesNotMatch(updatedConfig.properties.communicationTypeFilter, /message/);
  assert.deepEqual(updatedConfig.properties.groups, ["group-1"]);
  assert.deepEqual(updatedConfig.properties.queueIdFilterList, ["queue-1"]);
});

test("Genesys AI handoff script renders the public Telnyx logo and branded layout", async () => {
  const rendered = await renderGenesysAiHandoffScript("https://tunnel.example.com/");
  assert.doesNotMatch(rendered, /__TELNYX_LOGO_URL__/);
  const script = JSON.parse(rendered);
  const controls = [];
  const collectControls = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.type) controls.push(value);
    Object.values(value).forEach(collectControls);
  };
  collectControls(script.pages[0].rootContainer);
  const logo = controls.find((control) => control.type === "image");
  assert.equal(
    logo.properties.imageSource.value,
    "https://tunnel.example.com/telnyx_logo_black.png"
  );
  assert.equal(logo.properties.width.value.size, 42);
  assert.equal(script.pages[0].properties.backgroundColor.value, "#ffffff");
  assert.equal(
    script.pages[0].rootContainer.children[0].properties.backgroundColor.value,
    "#00e3aa"
  );
  const conversationSummaryHeading = controls.find((control) =>
    control.properties?.text?.value === "CONVERSATION SUMMARY"
  );
  const handoffContextHeading = controls.find((control) =>
    control.properties?.text?.value === "HANDOFF CONTEXT"
  );
  assert.equal(conversationSummaryHeading.properties.textColor.value, "#00e3aa");
  assert.equal(handoffContextHeading.properties.textColor.value, "#00e3aa");
  const intentRow = controls.find((control) =>
    control.type === "horizontalStackContainer" &&
    control.children?.[0]?.properties?.text?.value === "Intent"
  );
  assert.equal(intentRow.properties.backgroundColor.typeName, "null");
  assert.equal(intentRow.children[0].properties.bold.value, true);
  assert.equal(intentRow.children[1].properties.bold.value, false);
  assert.equal(
    intentRow.children[1].properties.text.value,
    "{{0ca57e1e-7fd4-4472-9ca9-238f0910091e}}"
  );
});

test("assistant instructions and webhook enum share the same selected queue allowlist", () => {
  const queues = ["Tier 1 Support", "Sales EMEA"];
  const tool = handoffToolDefinition({
    baseUrl: "https://integrations.example.com",
    queueNames: queues,
    targetName: "Example (A1B2C3)",
    apiKeyRef: "genesys-handoff-secret",
  });
  const instructions = assistantInstructions(queues, tool.webhook.name);
  for (const queue of queues) assert.match(instructions, new RegExp(`- ${queue}`));
  assert.equal(tool.webhook.name, "request_genesys_human_handoff_a1b2c3");
  assert.match(instructions, /request_genesys_human_handoff_a1b2c3/);
  assert.equal(tool.display_name, "Telnyx Integrations");
  assert.deepEqual(tool.webhook.body_parameters.properties.queue_name.enum, queues);
  assert.equal(tool.webhook.body_parameters.properties.queue_id, undefined);
  assert.doesNotMatch(instructions, /queue_id/);
  assert.match(instructions, /resolves it to the immutable Genesys queue ID/);
  assert.equal(tool.webhook.body_parameters.properties.telnyx_conversation_channel.type, "string");
  assert.match(
    tool.webhook.body_parameters.properties.telnyx_conversation_channel.description,
    /\{\{telnyx_conversation_channel\}\}/
  );
  assert.equal(tool.webhook.body_parameters.properties.channel, undefined);
  assert.equal(tool.webhook.url, "https://integrations.example.com/api/genesys/handoff");
  assert.match(tool.webhook.headers[0].value, /integration_secret/);
  const hangup = hangupToolDefinition();
  assert.equal(hangup.display_name, "Telnyx Integrations");
  assert.equal(hangup.type, "hangup");
  assert.match(hangup.hangup.description, /caller asks to disconnect/);
  assert.equal(hangup.hangup.intent_message, "");
});

test("generated assistants retain the Telnyx product specialist role and greeting", () => {
  const instructions = assistantInstructions(
    ["Marketing", "Sales", "Support", "Generic"],
    "request_genesys_human_handoff_a1b2c3"
  );
  assert.equal(
    TELNYX_PRODUCT_ASSISTANT_GREETING,
    "Hi! I can answer questions about Telnyx products and services. If needed, I can connect you to the right human team."
  );
  for (const topic of [
    "Voice API and Call Control",
    "SIP Trunking",
    "WebRTC",
    "SMS/MMS",
    "RCS",
    "WhatsApp",
    "Verify",
    "Fax",
    "IoT connectivity",
    "Telnyx AI Assistants",
  ]) {
    assert.match(instructions, new RegExp(topic.replace("/", "\\/")));
  }
  assert.match(instructions, /say so instead of inventing details/);
  assert.match(instructions, /Marketing: campaigns, brand, events, promotions/);
  assert.match(instructions, /Sales: pricing, quotes, purchasing/);
  assert.match(instructions, /Support: technical problems, configuration, troubleshooting/);
  assert.match(instructions, /Generic: every handoff intent that does not match/);
  assert.match(instructions, /request_genesys_human_handoff_a1b2c3/);
  assert.match(instructions, /Caller number: \{\{genesys_ani\}\}/);
  assert.match(instructions, /Caller display name: \{\{genesys_ani_name\}\}/);
  assert.match(instructions, /Caller first name: \{\{first_name\}\}/);
  assert.match(instructions, /Caller last name: \{\{last_name\}\}/);
  assert.match(instructions, /assistant definition intentionally has empty defaults/);
  assert.match(instructions, /## Ending the call/);
  assert.match(instructions, /call the Hangup tool exactly once/);
  assert.match(instructions, /Do not call Hangup when a human handoff is pending/);
  assert.match(instructions, /Telnyx conversation channel: \{\{telnyx_conversation_channel\}\}/);
  assert.match(instructions, /exact rendered value as authoritative and immutable/);
  assert.match(instructions, /For websocket_call, call the webhook tool/);
  assert.match(instructions, /For phone_call or web_call/);
  assert.match(instructions, /Never disclose internal Genesys conversation/);
  assert.ok(
    Object.values(GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS).every((value) => value === "")
  );
  assert.equal(GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS.genesys_language, "");
  assert.equal(GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS.genesys_ani, "");
  assert.equal(GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS.first_name, "");
  assert.equal(GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS.last_name, "");
});

test("AI-generated and existing assistant instructions receive one managed Genesys runtime context", () => {
  const custom = "Keep this customer-specific instruction unchanged.";
  const once = prepareGenesysAudioAssistantInstructions(custom);
  const twice = prepareGenesysAudioAssistantInstructions(once);

  assert.match(twice, /Keep this customer-specific instruction unchanged\./);
  assert.match(twice, /<!-- genesys-audio-runtime-context:start -->/);
  assert.match(twice, /Caller number: \{\{genesys_ani\}\}/);
  assert.match(twice, /Caller display name: \{\{genesys_ani_name\}\}/);
  assert.match(twice, /Called number: \{\{genesys_dnis\}\}/);
  assert.match(twice, /Genesys language: \{\{genesys_language\}\}/);
  assert.match(twice, /Caller first name: \{\{first_name\}\}/);
  assert.match(twice, /Caller last name: \{\{last_name\}\}/);
  assert.match(twice, /Telnyx conversation channel: \{\{telnyx_conversation_channel\}\}/);
  assert.equal((twice.match(/genesys-audio-runtime-context:start/g) || []).length, 1);
  assert.equal((twice.match(/genesys-universal-handoff:start/g) || []).length, 1);
});

test("handoff webhook function names are unique per Audio Connector deployment", () => {
  assert.equal(
    handoffToolFunctionName("Customer Assistant (A1B2C3)"),
    "request_genesys_human_handoff_a1b2c3"
  );
  assert.equal(
    handoffToolFunctionName("Customer Assistant (D4E5F6)"),
    "request_genesys_human_handoff_d4e5f6"
  );
  assert.notEqual(handoffToolFunctionName("Legacy One"), handoffToolFunctionName("Legacy Two"));
});

test("Audio Connector recognizes legacy and deployment-scoped handoff tool calls", () => {
  assert.equal(isGenesysHandoffToolFunctionName(GENESYS_HANDOFF_TOOL_FUNCTION_NAME), true);
  assert.equal(isGenesysHandoffToolFunctionName("request_genesys_human_handoff_c742fe"), true);
  assert.equal(isGenesysHandoffToolFunctionName("request_genesys_human_handoff_A1B2C3"), true);
  assert.equal(isGenesysHandoffToolFunctionName("request_genesys_human_handoff_12345"), false);
  assert.equal(isGenesysHandoffToolFunctionName("request_genesys_human_handoff_1234567"), false);
  assert.equal(isGenesysHandoffToolFunctionName("request_genesys_human_handoff_nothex"), false);
  assert.equal(
    isGenesysHandoffToolFunctionName("request_genesys_human_handoff_c742fe_extra"),
    false
  );
  assert.equal(isGenesysHandoffToolFunctionName("unrelated_request_genesys_human_handoff"), false);
});

test("Audio Connector runtime applies the shared handoff tool-name matcher", async () => {
  const handler = await source("lib/genesys/audio-connector-handler.js");
  assert.match(handler, /isGenesysHandoffToolFunctionName\(tool\.name\)/);
  assert.doesNotMatch(handler, /tool\.name !== HANDOFF_TOOL_NAME/);
});

test("Genesys AI widget merges handoff attributes and parses nested Telnyx values", () => {
  assert.deepEqual(
    collectGenesysConversationAttributes({
      participants: [
        { attributes: { telnyx_conversation_id: "conversation-1", telnyx_ai_summary: "Summary" } },
        { attributes: {} },
        { attributes: { telnyx_ai_queue_name: "Support" } },
      ],
    }),
    {
      telnyx_conversation_id: "conversation-1",
      telnyx_ai_summary: "Summary",
      telnyx_ai_queue_name: "Support",
    }
  );
  assert.deepEqual(parseTelnyxWidgetValue({ response: '{"customer":{"tier":"gold"}}' }), {
    response: { customer: { tier: "gold" } },
  });
  assert.equal(
    sipHeaderValue(
      "X-TGX-Queue-Name: Support\r\nX-TGX-Call-Control-Id: v3:test-control-id\r\n",
      "x-tgx-call-control-id"
    ),
    "v3:test-control-id"
  );
});

test("Genesys AI widget exposes all demo-portal data tabs and the configured public origin", async () => {
  const widget = await source("components/genesys-ai/GenesysAiConversationWidget.jsx");
  const genesysLayout = await source("app/genesys/layout.jsx");
  const genesysTheme = await source("components/genesys/GenesysThemeToggle.jsx");
  const rootTheme = await source("components/theme-provider.jsx");
  const messages = await source("components/assistants/ConversationMessagesTab.jsx");
  const insights = await source("components/assistants/ConversationInsightsTab.jsx");
  const metadata = await source("components/assistants/ConversationMetadataTab.jsx");
  const dynamicVariables = await source("components/assistants/ConversationDynamicVariablesTab.jsx");
  const costs = await source("components/assistants/ConversationCostsTab.jsx");
  const loader = await source("lib/genesys/ai-conversation-widget.js");
  const nextConfig = await source("next.config.mjs");
  const tunnel = await source("lib/genesys/cloudflare-quick-tunnel.mjs");
  for (const label of ["Conversation", "Insights", "Metadata", "Dynamic Variables", "Costs"]) {
    assert.match(widget, new RegExp(label));
  }
  for (const component of [
    "ConversationMessagesTab",
    "ConversationInsightsTab",
    "ConversationMetadataTab",
    "ConversationDynamicVariablesTab",
    "ConversationCostsTab",
  ]) {
    assert.match(widget, new RegExp(`<${component}`));
  }
  assert.match(widget, /context\.summary/);
  assert.match(widget, /context\.intent/);
  assert.match(widget, /sentimentClasses\(context\.sentiment\)/);
  assert.match(widget, /document\.documentElement\.classList\.remove\("dark"\)/);
  assert.match(genesysLayout, /<GenesysThemeToggle/);
  assert.match(genesysTheme, /pathname\?\.startsWith\("\/genesys\/ai-conversation-widget"\)/);
  assert.match(genesysTheme, /const initialTheme = lightOnly \? "light"/);
  assert.match(genesysTheme, /setTheme\(initialTheme\)/);
  assert.match(genesysTheme, /if \(lightOnly\) return null/);
  assert.match(genesysTheme, /userSelectionVersionRef\.current \+= 1/);
  assert.match(genesysTheme, /selectionVersion !== userSelectionVersionRef\.current/);
  assert.doesNotMatch(
    genesysTheme,
    /\}, \[databasePreference, lightOnly, normalizedDefaultTheme, setTheme\]\);/
  );
  assert.match(rootTheme, /pathname\?\.startsWith\("\/genesys\/ai-conversation-widget"\)/);
  assert.match(rootTheme, /forcedTheme=\{widgetLightOnly \? "light" : props\.forcedTheme\}/);
  assert.match(messages, /<MessageAvatar/);
  assert.match(messages, /variant=\{isGenesysAppearance \? "genesys" : "contained"\}/);
  assert.match(messages, /<TtsExpressionMessageText/);
  assert.match(messages, /m\.tool_calls\.map/);
  assert.match(insights, /orderConversationInsights/);
  assert.match(metadata, /humanizeKey/);
  assert.match(dynamicVariables, /initialWebhookLogs/);
  assert.match(costs, /<ResponsiveContainer/);
  assert.match(costs, /Cost Breakdown/);
  assert.match(costs, /Component Details/);
  assert.match(loader, /\/webhook-logs/);
  assert.match(loader, /\/session_analysis\/ai-voice-assistant/);
  assert.match(loader, /\/conversations-insights/);
  assert.match(nextConfig, /GC_PUBLIC_BASE_URL/);
  assert.doesNotMatch(nextConfig, /\*\.trycloudflare\.com/);
  assert.match(tunnel, /retainBootstrapServer = false/);
  assert.match(tunnel, /Temporary local application stopped/);
});

test("Telnyx handoff secret is created once and never exposed in the result", async () => {
  const createCalls = [];
  const client = {
    integrationSecrets: {
      list() { return { async *[Symbol.asyncIterator]() {} }; },
      async create(body) {
        createCalls.push(body);
        return { data: { id: "secret-1", identifier: body.identifier } };
      },
    },
  };
  const result = await ensureIntegrationSecret(client, {
    identifier: "genesys-handoff",
    token: "private-value",
  });
  assert.deepEqual(result, { id: "secret-1", identifier: "genesys-handoff", created: true });
  assert.equal(createCalls[0].token, "private-value");
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test("handoff secret identifiers are stable without exposing the token", () => {
  const identifier = handoffSecretIdentifier("private-value");
  assert.equal(identifier, handoffSecretIdentifier("private-value"));
  assert.notEqual(identifier, handoffSecretIdentifier("another-value"));
  assert.match(identifier, /^telnyx-genesys-handoff-[a-f0-9]{12}$/);
  assert.doesNotMatch(identifier, /private-value/);
});

test("Audio secret bootstrap generates the required formats without overwriting values", () => {
  const generated = generateAudioSecrets();
  assert.match(generated.GC_AUDIO_CONNECTOR_API_KEY, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(generated.GC_AUDIO_CONNECTOR_CLIENT_SECRET, "base64").length, 32);
  assert.match(generated.GC_AUDIO_HANDOFF_API_KEY, /^[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(generated)).size, 3);
  assert.deepEqual(missingAudioSecretNames(generated), []);

  const merged = mergeEnvironmentFile(
    "GC_ENVIRONMENT=usw2.pure.cloud\nGC_AUDIO_CONNECTOR_API_KEY=\n",
    { GC_AUDIO_CONNECTOR_API_KEY: "generated-value" }
  );
  assert.match(merged, /^GC_AUDIO_CONNECTOR_API_KEY=generated-value$/m);
  assert.throws(
    () => mergeEnvironmentFile("GC_AUDIO_CONNECTOR_API_KEY=keep-me\n", {
      GC_AUDIO_CONNECTOR_API_KEY: "replacement",
    }),
    /Refusing to overwrite/
  );
});

test("interactive Audio configuration validates regions, origins, and masked secret formats", () => {
  assert.equal(
    normalizeInstallerConfigurationValue("GC_ENVIRONMENT", "https://usw2.pure.cloud/"),
    "usw2.pure.cloud"
  );
  assert.equal(
    normalizeInstallerConfigurationValue(
      "GC_PUBLIC_BASE_URL",
      "https://integrations.example.com"
    ),
    "https://integrations.example.com"
  );
  assert.throws(
    () => normalizeInstallerConfigurationValue("GC_PUBLIC_BASE_URL", "http://example.com"),
    /public HTTPS origin/
  );
  const telnyxPublicKey = Buffer.alloc(32, 9).toString("base64");
  assert.equal(
    normalizeInstallerConfigurationValue("TELNYX_PUBLIC_KEY", telnyxPublicKey),
    telnyxPublicKey
  );
  assert.throws(
    () => normalizeInstallerConfigurationValue("TELNYX_PUBLIC_KEY", "invalid"),
    /base64-encoded 32-byte Ed25519 public key/
  );
  assert.throws(
    () => normalizeInstallerConfigurationValue(
      "GC_AUDIO_CONNECTOR_CLIENT_SECRET",
      Buffer.alloc(16).toString("base64")
    ),
    /base64-encoded 32-byte secret/
  );

  const merged = mergeEnvironmentFile("GC_PUBLIC_BASE_URL=\nGC_CLIENT_SECRET=\"\"\n", {
    GC_PUBLIC_BASE_URL: "https://integrations.example.com",
    GC_CLIENT_SECRET: "secret containing # character",
  });
  assert.match(merged, /^GC_PUBLIC_BASE_URL=https:\/\/integrations\.example\.com$/m);
  assert.match(merged, /^GC_CLIENT_SECRET="secret containing # character"$/m);
  assert.equal(parseDotenv(merged).GC_CLIENT_SECRET, "secret containing # character");
});

test("managed Quick Tunnel URLs can rotate without overwriting a custom public origin", () => {
  const first = "https://first-demo.trycloudflare.com";
  const second = "https://second-demo.trycloudflare.com";
  assert.equal(isCloudflareQuickTunnelUrl(first), true);
  assert.equal(isCloudflareQuickTunnelUrl("https://example.com"), false);
  assert.equal(
    parseCloudflareQuickTunnelUrl(`INF Your quick Tunnel has been created! Visit it at ${first}`),
    first
  );
  // Compared line by line rather than with `new RegExp(...${second}...)`:
  // interpolating a URL into a pattern leaves every "." a wildcard, so the
  // assertion accepted hostnames it was never meant to.
  assert.ok(
    mergeEnvironmentFile(`GC_PUBLIC_BASE_URL=${first}\n`, {
      GC_PUBLIC_BASE_URL: second,
    }, { replaceManagedPublicBaseUrl: true })
      .split("\n")
      .includes(`GC_PUBLIC_BASE_URL=${second}`)
  );
  assert.throws(
    () => mergeEnvironmentFile("GC_PUBLIC_BASE_URL=https://integrations.example.com\n", {
      GC_PUBLIC_BASE_URL: second,
    }, { replaceManagedPublicBaseUrl: true }),
    /Refusing to overwrite/
  );
  assert.deepEqual(
    managedQuickTunnelEnvironmentWriteOptions("https://integrations.example.com"),
    {
      replaceManagedPublicBaseUrl: true,
      replaceNames: ["GC_PUBLIC_BASE_URL"],
    }
  );
  assert.deepEqual(managedQuickTunnelEnvironmentWriteOptions(first), {
    replaceManagedPublicBaseUrl: true,
    replaceNames: [],
  });
});

test("Quick Tunnel health checks require the expected application response", async () => {
  const healthy = await checkTunnelHealth("https://demo.trycloudflare.com", {
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: "ok",
          service: url.includes("/api/health")
            ? "telnyx-genesys-integrations"
            : "wrong",
          audioConnector: { configured: true },
        };
      },
    }),
  });
  assert.deepEqual(healthy, {
    ok: true,
    status: 200,
    service: "telnyx-genesys-integrations",
    audioConnectorConfigured: true,
    widgetDatabaseReady: false,
  });
  const unhealthy = await checkTunnelHealth("https://demo.trycloudflare.com", {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { status: "starting" }; } }),
  });
  assert.equal(unhealthy.ok, false);
  assert.equal(
    managedQuickTunnelCanBeReused({
      healthy: false,
      state: { publicBaseUrl: "https://demo.trycloudflare.com", port: 3000 },
      processes: { cloudflared: { running: true } },
      health: { local: { ok: false }, public: { ok: false, status: 502 } },
    }),
    true
  );
  assert.equal(
    managedQuickTunnelCanBeReused({
      healthy: false,
      state: { publicBaseUrl: "https://expired.trycloudflare.com", port: 3000 },
      processes: { cloudflared: { running: true } },
      health: {
        local: { ok: true },
        public: { ok: false, status: 0, error: "getaddrinfo ENOTFOUND" },
      },
    }),
    false
  );
});

test("stopping a managed Quick Tunnel clears only its exact URL from .env", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-audio-tunnel-env-"));
  const envFile = path.join(directory, ".env");
  const url = "https://managed-demo.trycloudflare.com";
  try {
    await writeFile(envFile, `GC_PUBLIC_BASE_URL=${url}\nGC_ENVIRONMENT=usw2.pure.cloud\n`);
    const environment = { GC_PUBLIC_BASE_URL: url };
    const cleared = await clearManagedPublicBaseUrl({ expectedUrl: url, environment, envFile });
    assert.equal(cleared.cleared, true);
    assert.match(await readFile(envFile, "utf8"), /^GC_PUBLIC_BASE_URL=$/m);
    assert.equal(environment.GC_PUBLIC_BASE_URL, undefined);
    assert.equal(quickTunnelPaths(directory).state, path.join(directory, "state.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Quick Tunnel lifecycle records, reports, and identity-checks its managed process", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-audio-tunnel-process-"));
  const binary = path.join(directory, "fake-cloudflared");
  const stateRoot = path.join(directory, "state");
  await writeFile(
    binary,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("cloudflared version test");
  process.exit(0);
}
console.error("https://managed-process.trycloudflare.com");
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  await chmod(binary, 0o700);
  let publicHealthChecks = 0;
  const fetchImpl = async (url) => {
    const isPublic = isQuickTunnelHost(url);
    if (isPublic) publicHealthChecks += 1;
    const ready = !isPublic || publicHealthChecks > 4;
    return {
      ok: ready,
      status: ready ? 200 : 503,
      async json() {
        return ready
          ? {
              status: "ok",
              service: "telnyx-genesys-integrations",
              audioConnector: { configured: true },
            }
          : { status: "starting" };
      },
    };
  };
  const execFileImpl = async (command, args) => {
    if (command === "ps") return { stdout: `node ${binary} tunnel` };
    if (command === binary && args.includes("--version")) {
      return { stdout: "cloudflared version test" };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  try {
    const progress = [];
    const started = await startCloudflareQuickTunnel({
      stateRoot,
      port: 3199,
      cloudflaredBinary: binary,
      fetchImpl,
      execFileImpl,
      timeoutMs: 2_000,
      onProgress(event) {
        progress.push(event);
      },
    });
    assert.equal(started.publicBaseUrl, "https://managed-process.trycloudflare.com");
    assert.equal(started.serverManaged, false);
    assert.equal(
      progress.filter((event) => event.stage === "tunnel-process" && event.status === "active").length,
      2
    );
    assert.ok(
      progress.some(
        (event) => event.stage === "public-health" && event.status === "warning"
      )
    );
    assert.ok(progress.some((event) => event.stage === "ready" && event.status === "success"));
    const status = await getQuickTunnelStatus({ stateRoot, fetchImpl, execFileImpl });
    assert.equal(status.healthy, true);
    assert.equal(status.processes.cloudflared.running, true);
    const firstPid = started.cloudflaredPid;
    let replacementPublicChecks = 0;
    const replaced = await startCloudflareQuickTunnel({
      stateRoot,
      port: 3199,
      cloudflaredBinary: binary,
      execFileImpl,
      timeoutMs: 2_000,
      fetchImpl: async (url) => {
        const isPublic = isQuickTunnelHost(url);
        if (isPublic) replacementPublicChecks += 1;
        const ready = !isPublic || replacementPublicChecks > 1;
        return {
          ok: ready,
          status: ready ? 200 : 503,
          async json() {
            return ready
              ? {
                  status: "ok",
                  service: "telnyx-genesys-integrations",
                  audioConnector: { configured: true },
                }
              : { status: "starting" };
          },
        };
      },
    });
    assert.equal(replaced.reused, false);
    assert.notEqual(replaced.cloudflaredPid, firstPid);
    const stopped = await stopCloudflareQuickTunnel({ stateRoot, execFileImpl });
    assert.equal(stopped.stopped, true);
    assert.equal((await getQuickTunnelStatus({ stateRoot, fetchImpl })).running, false);
  } finally {
    await stopCloudflareQuickTunnel({ stateRoot, execFileImpl }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Quick Tunnel stops only the application server it bootstrapped for validation", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-audio-tunnel-bootstrap-"));
  const stateRoot = path.join(directory, "state");
  const binary = path.join(directory, "fake-cloudflared");
  const serverPidFile = path.join(directory, "server.pid");
  await writeFile(
    path.join(directory, "server.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(serverPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`
  );
  await writeFile(
    binary,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("cloudflared version test");
  process.exit(0);
}
console.error("https://manual-runtime.trycloudflare.com");
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  await chmod(binary, 0o700);
  const execFileImpl = async (command, args) => {
    if (command === binary && args.includes("--version")) {
      return { stdout: "cloudflared version test" };
    }
    if (command === "ps") {
      const requestedPid = Number(args[1]);
      const bootstrapPid = Number(await readFile(serverPidFile, "utf8").catch(() => 0));
      return {
        stdout: requestedPid === bootstrapPid
          ? "node server.mjs --dev"
          : `node ${binary} tunnel`,
      };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const fetchImpl = async (url) => {
    const isLocal = String(url).includes("127.0.0.1");
    const serverStarted = !isLocal || Boolean(await readFile(serverPidFile, "utf8").catch(() => ""));
    return {
      ok: serverStarted,
      status: serverStarted ? 200 : 503,
      async json() {
        return serverStarted
          ? {
              status: "ok",
              service: "telnyx-genesys-integrations",
              audioConnector: { configured: true },
            }
          : { status: "starting" };
      },
    };
  };
  try {
    const progress = [];
    const started = await startCloudflareQuickTunnel({
      stateRoot,
      projectRoot: directory,
      port: 3198,
      cloudflaredBinary: binary,
      fetchImpl,
      execFileImpl,
      timeoutMs: 3_000,
      tunnelAttempts: 1,
      onProgress(event) {
        progress.push(event);
      },
    });
    const bootstrapPid = Number(await readFile(serverPidFile, "utf8"));
    const state = await readQuickTunnelState({ stateRoot });
    assert.equal(started.applicationRunning, false);
    assert.equal(started.serverManaged, false);
    assert.equal(state.status, "waiting-for-local-server");
    assert.equal(state.serverPid, null);
    assert.equal(processIsRunning(bootstrapPid), false);
    assert.ok(
      progress.some(
        (event) => event.stage === "local-server-stop" && event.status === "success"
      )
    );
    const status = await getQuickTunnelStatus({
      stateRoot,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        async json() { return { status: "stopped" }; },
      }),
      execFileImpl,
    });
    assert.equal(status.running, true);
    assert.equal(status.healthy, false);
    assert.equal(status.processes.server.managed, false);
  } finally {
    await stopCloudflareQuickTunnel({ stateRoot, execFileImpl }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Audio secret bootstrap writes a private .env and is idempotent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-audio-secrets-"));
  const envFile = path.join(directory, ".env");
  const environment = {};
  try {
    const first = await bootstrapMissingAudioSecrets({ environment, envFile });
    assert.deepEqual(first.generated.sort(), [
      "GC_AUDIO_CONNECTOR_API_KEY",
      "GC_AUDIO_CONNECTOR_CLIENT_SECRET",
      "GC_AUDIO_HANDOFF_API_KEY",
    ].sort());
    assert.deepEqual(missingAudioSecretNames(environment), []);
    assert.equal((await lstat(envFile)).mode & 0o077, 0);
    const firstContent = await readFile(envFile, "utf8");
    for (const name of first.generated) assert.match(firstContent, new RegExp(`^${name}=.+$`, "m"));

    const second = await bootstrapMissingAudioSecrets({ environment, envFile });
    assert.deepEqual(second.generated, []);
    assert.equal(await readFile(envFile, "utf8"), firstContent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one public HTTPS origin drives webhooks, widgets, and the Audio Connector URI", () => {
  assert.equal(
    publicGenesysBaseUrl("https://integrations.example.com"),
    "https://integrations.example.com"
  );
  assert.equal(
    genesysAudioConnectorBaseUri("https://integrations.example.com"),
    "wss://integrations.example.com/api/genesys/audio-connector"
  );
  assert.throws(() => publicGenesysBaseUrl("http://integrations.example.com"), /public HTTPS origin/);
  assert.throws(() => publicGenesysBaseUrl("https://user@example.com"), /public HTTPS origin/);
  assert.throws(() => publicGenesysBaseUrl("https://example.com/path"), /public HTTPS origin/);
});

test("TTS and Audio can create their first instance after AppFoundry enablement", async () => {
  const manager = await source("scripts/manage-genesys-audio.mjs");
  assert.doesNotMatch(manager, /assertAudioConnectorInstalled\(integrations\)/);
  assert.match(manager, /getIntegrationsType\(AUDIO_CONNECTOR_TYPE\)/);
  assert.match(manager, /postIntegrations/);

  const ttsGenesys = await source("lib/genesys/tts-connector-genesys.mjs");
  assert.doesNotMatch(ttsGenesys, /assertTtsConnectorInstalled\(installed\)/);
  assert.match(ttsGenesys, /postIntegrations/);
});

test("first Audio Connector creation explains when AppFoundry enablement is required", async () => {
  await assert.rejects(
    ensureAudioConnectorDeployment(
      {
        async getIntegrations() {
          return { entities: [] };
        },
        async postIntegrations() {
          const error = new Error("forbidden");
          error.status = 403;
          throw error;
        },
      },
      "Customer Assistant (A1B2C3)"
    ),
    /Enable Genesys Audio Connector.*AppFoundry/
  );
});

test("Audio Connector, queue, and group discovery paginate all Genesys results", async () => {
  const integrationCalls = [];
  const integrations = await listAudioConnectorIntegrations({
    async getIntegrations(options) {
      integrationCalls.push(options);
      return options.pageNumber === 1
        ? { entities: [{ id: "a1" }], nextUri: "/page/2" }
        : { entities: [{ id: "a2" }], nextUri: null };
    },
  });
  assert.deepEqual(integrations.map(({ id }) => id), ["a1", "a2"]);
  assert.ok(integrationCalls.every((call) => call.integrationType === "audio-connector"));

  const queues = await listGenesysQueues({
    async getRoutingQueues(options) {
      return options.pageNumber === 1
        ? { entities: [{ id: "q2", name: "Zulu" }], nextUri: "/page/2" }
        : { entities: [{ id: "q1", name: "Alpha" }], nextUri: null };
    },
  });
  assert.deepEqual(queues.map(({ name }) => name), ["Alpha", "Zulu"]);

  const groups = await listGenesysGroups({
    async getGroups(options) {
      return options.pageNumber === 1
        ? { entities: [{ id: "g2", name: "Support" }], nextUri: "/page/2" }
        : { entities: [{ id: "g1", name: "Agents" }], nextUri: null };
    },
  });
  assert.deepEqual(groups.map(({ name }) => name), ["Agents", "Support"]);
});

test("AudioHook codec round-trips PCMU frames and requires a dynamic assistant ID", () => {
  const pcm = Buffer.alloc(320);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE((offset - 160) * 50, offset);
  const encoded = encodeAudioHookAudio(pcm, GENESYS_AUDIOHOOK_MEDIA);
  const decoded = decodeAudioHookAudio(encoded, GENESYS_AUDIOHOOK_MEDIA);
  assert.equal(encoded.length, pcm.length / 2);
  assert.equal(decoded.length, pcm.length);
  assert.equal(requireAudioHookAssistantId({ parameters: { inputVariables: { assistantId: "assistant-1" } } }), "assistant-1");
  assert.throws(() => requireAudioHookAssistantId({ parameters: { inputVariables: {} } }), /assistantId is required/);
});

test("AudioHook defaults to Audio Connector PCMU and retains explicit L16 support", () => {
  const offered = [GENESYS_AUDIOHOOK_MEDIA, GENESYS_AUDIOHOOK_L16_MEDIA];
  assert.equal(selectAudioHookMedia(offered).format, "PCMU");
  assert.equal(selectAudioHookMedia(offered, "L16").format, "L16");
  assert.equal(selectAudioHookMedia([GENESYS_AUDIOHOOK_MEDIA]).format, "PCMU");
  assert.equal(preferredAudioHookMediaFormat(undefined), "PCMU");
  assert.equal(preferredAudioHookMediaFormat("pcmu"), "PCMU");
  assert.throws(
    () => preferredAudioHookMediaFormat("OPUS"),
    /expected L16 or PCMU/
  );

  const pcm16Le = Buffer.from([0x34, 0x12, 0xcc, 0xff]);
  assert.strictEqual(
    decodeAudioHookAudio(pcm16Le, GENESYS_AUDIOHOOK_L16_MEDIA),
    pcm16Le,
    "Genesys L16 input should pass to Telnyx without transcoding or copying"
  );
  assert.strictEqual(
    encodeAudioHookAudio(pcm16Le, GENESYS_AUDIOHOOK_L16_MEDIA),
    pcm16Le,
    "Telnyx PCM16 output should pass to Genesys L16 without transcoding or copying"
  );
  assert.equal(pcm16Le.readInt16LE(0), 0x1234);
  assert.equal(pcm16Le.readInt16LE(2), -52);
});

test("AudioHook packetizer accepts variable input frames without losing sample bytes", () => {
  const packetizer = new AudioHookPcmPacketizer(320);
  const first = Buffer.alloc(161, 0x11);
  const second = Buffer.alloc(479, 0x22);
  assert.deepEqual(packetizer.push(first), []);
  const frames = packetizer.push(second);
  assert.equal(frames.length, 2);
  assert.equal(Buffer.concat(frames).length, 640);
  assert.deepEqual(Buffer.concat(frames), Buffer.concat([first, second]));
  assert.deepEqual(packetizer.flush(), []);
});

test("realtime input pacing catches up without sending a burst", () => {
  const scheduled = [];
  const sent = [];
  const catchUp = [];
  const pacer = new RealtimeAudioPacer({
    sendFrame: (frame) => sent.push(frame[0]),
    frameDurationMs: 20,
    initialDelayMs: 0,
    catchUpFrameDurationMs: 5,
    catchUpThresholdFrames: 2,
    maxQueueFrames: 10,
    schedule(callback, delay) {
      const task = { callback, delay, id: scheduled.length + 1 };
      scheduled.push(task);
      return task.id;
    },
    cancel() {},
    onCatchUp: (frame) => catchUp.push(frame[0]),
  });

  pacer.start();
  pacer.enqueueMany([1, 2, 3, 4, 5].map((value) => Buffer.from([value])));
  assert.equal(scheduled.shift().delay, 0);
  pacer.tick();
  assert.equal(scheduled.shift().delay, 5);
  pacer.tick();
  assert.equal(scheduled.shift().delay, 5);
  pacer.tick();
  assert.equal(scheduled.shift().delay, 20);
  pacer.tick();
  assert.equal(scheduled.shift().delay, 20);
  pacer.tick();

  assert.deepEqual(sent, [1, 2, 3, 4, 5]);
  assert.deepEqual(catchUp, [2, 3]);
  assert.equal(pacer.catchUpFrames, 2);
  assert.equal(pacer.peakPendingFrames, 5);
});

test("Telnyx session update maps Genesys context and explicitly prefixed Architect inputs", () => {
  assert.equal(assertTelnyxTelephoneTargetNormalization(), true);
  assert.equal(TELNYX_DYNAMIC_VARIABLE_INPUT_PREFIX, "telnyxVar_");
  const { frame, variableNames } = buildTelnyxSessionUpdate({
    context: {
      sessionId: "audiohook-1",
      organizationId: "org-1",
      conversationId: "conversation-1",
      participantId: "participant-1",
      ani: "tel:+15551234567",
      aniName: "Ada Lovelace",
      dnis: "tel:+15550001001",
      language: "en-US",
    },
    inputVariables: {
      assistantId: "assistant-1",
      ignoredVariable: "not forwarded",
      telnyxVar_customer_name: "Ada",
      telnyxVar_account_tier: "pro",
    },
  });

  assert.equal(frame.type, "session.update");
  assert.deepEqual(frame.session.assistant.dynamic_variables, {
    genesys_audiohook_session_id: "audiohook-1",
    genesys_organization_id: "org-1",
    genesys_conversation_id: "conversation-1",
    genesys_participant_id: "participant-1",
    genesys_ani: "+15551234567",
    telnyx_end_user_target: "+15551234567",
    genesys_ani_name: "Ada Lovelace",
    genesys_dnis: "+15550001001",
    telnyx_agent_target: "+15550001001",
    genesys_language: "en-US",
    customer_name: "Ada",
    account_tier: "pro",
  });
  assert.deepEqual(variableNames, Object.keys(frame.session.assistant.dynamic_variables));
  assert.equal(JSON.stringify(frame).includes("assistant-1"), false);
  assert.equal(JSON.stringify(frame).includes("not forwarded"), false);
  assert.equal(JSON.stringify(frame).includes("tel:+"), false);
  assert.equal(normalizeGenesysTelephoneTarget("TEL:+15551234567"), "+15551234567");
  assert.equal(normalizeGenesysTelephoneTarget("  tel:+15551234567  "), "+15551234567");
  assert.equal(normalizeGenesysTelephoneTarget("+15551234567"), "+15551234567");
});

test("Telnyx session update maps the dialed customer as the end user for outbound calls", () => {
  const { frame } = buildTelnyxSessionUpdate({
    context: {
      ani: "tel:+15550001001",
      dnis: "tel:+15551234567",
      direction: "outbound",
    },
  });
  assert.deepEqual(frame.session.assistant.dynamic_variables, {
    genesys_ani: "+15550001001",
    genesys_dnis: "+15551234567",
    genesys_direction: "outbound",
    telnyx_end_user_target: "+15551234567",
    telnyx_agent_target: "+15550001001",
  });
});

test("Telnyx session update is bare without values and rejects unsafe Architect inputs", () => {
  assert.deepEqual(buildTelnyxSessionUpdate(), {
    frame: { type: "session.update" },
    variableNames: [],
  });
  assert.throws(
    () => buildTelnyxSessionUpdate({
      inputVariables: { telnyxVar_telnyx_conversation_channel: "web_call" },
    }),
    /reserved telnyx_ namespace/
  );
  assert.throws(
    () => buildTelnyxSessionUpdate({
      inputVariables: { telnyxVar_customer_name: { unsafe: true } },
    }),
    /must contain a string value/
  );
  assert.throws(
    () => buildTelnyxSessionUpdate({
      context: { conversationId: "conversation-1" },
      inputVariables: { telnyxVar_genesys_conversation_id: "override" },
    }),
    /conflicts with genesys_conversation_id/
  );
  assert.throws(
    () => buildTelnyxSessionUpdate({
      inputVariables: { telnyxVar_CustomerName: "Ada" },
    }),
    /lower-case snake_case/
  );
});

test("Audio Connector waits for Telnyx readiness before opening PCMU media", async () => {
  class FakeWebSocket extends EventEmitter {
    constructor(readyState) {
      super();
      this.readyState = readyState;
      this.bufferedAmount = 0;
      this.sent = [];
    }

    send(value) {
      this.sent.push(value);
    }

    ping() {}
    pong() {}

    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
    }
  }

  const previousApiKey = process.env.TELNYX_API_KEY;
  const previousDebug = process.env.GC_AUDIO_CONNECTOR_DEBUG;
  process.env.TELNYX_API_KEY = "test-key";
  process.env.GC_AUDIO_CONNECTOR_DEBUG = "false";
  const genesys = new FakeWebSocket(1);
  const telnyx = new FakeWebSocket(0);
  try {
    await handleAudioConnectorSession(genesys, {
      createTelnyxWebSocket: () => telnyx,
    });

    genesys.emit("message", Buffer.from(JSON.stringify({
      version: "2",
      type: "open",
      seq: 1,
      id: "audiohook-1",
      parameters: {
        organizationId: "org-1",
        conversationId: "conversation-1",
        participant: {
          id: "participant-1",
          ani: "tel:+15551234567",
          aniName: "Ada Lovelace",
          dnis: "tel:+15550001001",
        },
        language: "en-US",
        media: [GENESYS_AUDIOHOOK_MEDIA],
        inputVariables: {
          assistantId: "assistant-1",
          telnyxVar_account_tier: "pro",
        },
      },
    })), false);
    assert.deepEqual(telnyx.sent, []);
    assert.deepEqual(
      genesys.sent,
      [],
      "Genesys must not receive opened until the Telnyx backend is ready"
    );

    telnyx.readyState = 1;
    telnyx.emit("open");
    assert.equal(telnyx.sent.length, 1);
    const firstFrame = JSON.parse(telnyx.sent[0]);
    assert.equal(firstFrame.type, "session.update");
    assert.equal(firstFrame.session.assistant.dynamic_variables.account_tier, "pro");
    assert.equal(
      firstFrame.session.assistant.dynamic_variables.telnyx_end_user_target,
      "+15551234567"
    );
    assert.equal(
      firstFrame.session.assistant.dynamic_variables.telnyx_agent_target,
      "+15550001001"
    );
    assert.equal(
      firstFrame.session.assistant.dynamic_variables.genesys_ani,
      "+15551234567"
    );
    assert.equal(
      firstFrame.session.assistant.dynamic_variables.genesys_dnis,
      "+15550001001"
    );
    assert.equal(JSON.stringify(firstFrame).includes("tel:+"), false);
    assert.equal(
      firstFrame.session.assistant.dynamic_variables.genesys_conversation_id,
      "conversation-1"
    );
    assert.deepEqual(genesys.sent, []);

    telnyx.emit("message", Buffer.from(JSON.stringify({
      type: "session.created",
      session: {
        conversation_id: "telnyx-conversation-1",
        audio: {
          input: { format: { type: "audio/pcm", rate: 8000 } },
          output: { format: { type: "audio/pcm", rate: 8000 } },
        },
      },
    })));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const opened = JSON.parse(genesys.sent[0]);
    assert.equal(opened.type, "opened");
    assert.equal(opened.parameters.media[0].format, "PCMU");

    const callerPcm16Le = Buffer.alloc(320);
    for (let offset = 0; offset < callerPcm16Le.length; offset += 2) {
      callerPcm16Le.writeInt16LE((offset / 2) * 31 - 2400, offset);
    }
    const callerPcmu = encodeAudioHookAudio(
      callerPcm16Le,
      GENESYS_AUDIOHOOK_MEDIA
    );
    genesys.emit("message", callerPcmu, true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const inputAudioFrame = JSON.parse(telnyx.sent.at(-1));
    assert.equal(inputAudioFrame.type, "input_audio_buffer.append");
    assert.deepEqual(
      Buffer.from(inputAudioFrame.audio, "base64"),
      decodeAudioHookAudio(callerPcmu, GENESYS_AUDIOHOOK_MEDIA),
      "Genesys PCMU must reach Telnyx as decoded PCM16"
    );

    const assistantPcm16Le = Buffer.alloc(3200);
    for (let offset = 0; offset < assistantPcm16Le.length; offset += 2) {
      assistantPcm16Le.writeInt16LE(12000 - (offset / 2) * 13, offset);
    }
    telnyx.emit("message", Buffer.from(JSON.stringify({
      type: "response.created",
      response: { id: "response-1" },
    })));
    telnyx.emit("message", Buffer.from(JSON.stringify({
      type: "response.output_audio.delta",
      response_id: "response-1",
      delta: assistantPcm16Le.toString("base64"),
    })));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const genesysAudioFrames = genesys.sent.filter(Buffer.isBuffer);
    assert.equal(genesysAudioFrames.length, 1);
    assert.deepEqual(
      genesysAudioFrames[0],
      encodeAudioHookAudio(assistantPcm16Le, GENESYS_AUDIOHOOK_MEDIA),
      "Telnyx PCM16 must reach Genesys as PCMU"
    );

    for (const [seq, type] of [[2, "paused"], [3, "resumed"], [4, "discarded"]]) {
      genesys.emit("message", Buffer.from(JSON.stringify({
        version: "2",
        type,
        seq,
        serverseq: 1,
        id: "audiohook-1",
        position: `PT${seq}S`,
        parameters: type === "discarded"
          ? { start: "PT3.5S", discarded: "PT0.5S" }
          : {},
      })), false);
    }
    genesys.emit("message", Buffer.from(JSON.stringify({
      version: "2",
      type: "close",
      seq: 5,
      serverseq: 1,
      id: "audiohook-1",
      position: "PT5S",
      parameters: {},
    })), false);
    const closed = JSON.parse(
      genesys.sent.filter((value) => typeof value === "string").at(-1)
    );
    assert.equal(closed.type, "closed");
    assert.equal(
      genesys.readyState,
      1,
      "the server must let Genesys close the WebSocket after closed"
    );
  } finally {
    genesys.close(1000, "test complete");
    if (previousApiKey == null) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = previousApiKey;
    if (previousDebug == null) delete process.env.GC_AUDIO_CONNECTOR_DEBUG;
    else process.env.GC_AUDIO_CONNECTOR_DEBUG = previousDebug;
  }
});

test("Audio Connector authoritatively forces voice handoff", () => {
  const normalized = normalizeAudioConnectorHandoffRequest({
    channel: "chat",
    queue_name: "Tier 1 Support",
    reason: "Customer asked",
    summary: "Needs help",
    intent: "support",
    sentiment: "neutral",
  });
  assert.equal(normalized.channel, "voice");
  assert.equal(normalized.queueName, "Tier 1 Support");
});

test("Agent Experience distinguishes Open Messaging handoffs from voice calls", () => {
  assert.equal(normalizeGenesysWidgetChannel("messaging"), "messaging");
  assert.equal(normalizeGenesysWidgetChannel("message"), "messaging");
  assert.equal(normalizeGenesysWidgetChannel("web_chat"), "messaging");
  assert.equal(normalizeGenesysWidgetChannel("websocket_call"), "voice");
  assert.equal(normalizeGenesysWidgetChannel(undefined), "voice");
});

test("AudioHook HMAC verification covers the public authority and signed headers", () => {
  const apiKey = "audio-key";
  const secret = Buffer.from("audio-secret").toString("base64");
  const now = 1_800_000_000_000;
  const created = Math.floor(now / 1000) - 1;
  const expires = Math.floor(now / 1000) + 20;
  const components = [
    "@request-target",
    "audiohook-session-id",
    "audiohook-organization-id",
    "audiohook-correlation-id",
    "x-api-key",
    "@authority",
  ];
  const signatureParams = `(${components.map((value) => `"${value}"`).join(" ")});created=${created};expires=${expires};keyid="${apiKey}";alg="hmac-sha256";nonce="n1"`;
  const values = new Map([
    ["host", "voice.example.com"],
    ["x-api-key", apiKey],
    ["audiohook-session-id", "session-1"],
    ["audiohook-organization-id", "org-1"],
    ["audiohook-correlation-id", "corr-1"],
    ["signature-input", `sig1=${signatureParams}`],
  ]);
  const base = [
    '"@request-target": /api/genesys/audio-connector/ws',
    '"audiohook-session-id": session-1',
    '"audiohook-organization-id": org-1',
    '"audiohook-correlation-id": corr-1',
    `"x-api-key": ${apiKey}`,
    '"@authority": voice.example.com',
    `"@signature-params": ${signatureParams}`,
  ].join("\n");
  values.set("signature", `sig1=:${createHmac("sha256", Buffer.from(secret, "base64")).update(base).digest("base64")}:`);
  const request = {
    url: "https://voice.example.com/api/genesys/audio-connector/ws",
    headers: { get: (name) => values.get(name.toLowerCase()) || "" },
  };
  assert.equal(verifyGenesysAudioHookRequest(request, { apiKey, clientSecret: secret, now }).ok, true);
});

test("the unified server isolates the AudioHook upgrade path on port 3000", async () => {
  assert.equal(
    isGenesysAudioWebSocketPath(`${GENESYS_AUDIO_WEBSOCKET_PATH}?source=genesys`),
    true
  );
  assert.equal(isGenesysAudioWebSocketPath("/_next/hmr"), false);
  assert.deepEqual(missingGenesysAudioRuntimeVariables({}), [
    "TELNYX_API_KEY",
    "GC_ENVIRONMENT",
    "GC_CLIENT_CRED_CLIENT_ID",
    "GC_CLIENT_CRED_CLIENT_SECRET",
    "GC_AUDIO_CONNECTOR_API_KEY",
    "GC_AUDIO_CONNECTOR_CLIENT_SECRET",
    "GENESYS_HANDOFF_API_KEY or GC_AUDIO_HANDOFF_API_KEY",
  ]);

  const environment = {
    TELNYX_API_KEY: "telnyx-key",
    GC_ENVIRONMENT: "usw2.pure.cloud",
    GC_CLIENT_CRED_CLIENT_ID: "client-id",
    GC_CLIENT_CRED_CLIENT_SECRET: "client-secret",
    GC_AUDIO_CONNECTOR_API_KEY: "audio-key",
    GC_AUDIO_CONNECTOR_CLIENT_SECRET: Buffer.alloc(32).toString("base64"),
    GC_AUDIO_HANDOFF_API_KEY: "handoff-key",
  };
  const server = new EventEmitter();
  let handledRequest;
  let audioHookRequest;
  const fakeWebSocketServer = {
    clients: new Set(),
    handleUpgrade(request, _socket, _head, callback) {
      callback({ readyState: 1 });
      handledRequest = request;
    },
    close(callback) { callback(); },
  };
  const connector = attachGenesysAudioConnector(server, {
    environment,
    createWebSocketServer: () => fakeWebSocketServer,
    handleUpgrade: async (_websocket, request) => {
      audioHookRequest = request;
    },
  });

  server.emit("upgrade", { url: "/_next/hmr", headers: {} }, {}, Buffer.alloc(0));
  assert.equal(handledRequest, undefined);
  server.emit(
    "upgrade",
    {
      url: GENESYS_AUDIO_WEBSOCKET_PATH,
      headers: {
        host: "127.0.0.1:3000",
        "x-forwarded-host": "public.example.com",
        "x-forwarded-proto": "https",
      },
    },
    {},
    Buffer.alloc(0)
  );
  assert.equal(handledRequest.url, GENESYS_AUDIO_WEBSOCKET_PATH);
  await Promise.resolve();
  assert.equal(
    audioHookRequest.url,
    `https://public.example.com${GENESYS_AUDIO_WEBSOCKET_PATH}`
  );
  assert.equal(connector.configured, true);
  await connector.close();
});

test("the unified server rejects AudioHook without disabling regular Next.js HTTP", async () => {
  const server = new EventEmitter();
  const writes = [];
  let destroyed = false;
  let websocketUpgradeCalls = 0;
  const connector = attachGenesysAudioConnector(server, {
    environment: {},
    createWebSocketServer: () => ({
      clients: new Set(),
      handleUpgrade() { websocketUpgradeCalls += 1; },
      close(callback) { callback(); },
    }),
    logger: { warn() {} },
  });
  const socket = {
    write(value) { writes.push(value); },
    destroy() { destroyed = true; },
  };

  server.emit(
    "upgrade",
    { url: GENESYS_AUDIO_WEBSOCKET_PATH, headers: {} },
    socket,
    Buffer.alloc(0)
  );
  assert.equal(websocketUpgradeCalls, 0);
  assert.equal(destroyed, true);
  assert.match(writes.join(""), /503 Service Unavailable/);
  assert.equal(connector.configured, false);
  await connector.close();
});

test("the unified server delegates non-AudioHook WebSocket upgrades to Next.js", async () => {
  const server = new EventEmitter();
  let delegated = null;
  const connector = attachGenesysAudioConnector(server, {
    environment: {},
    createWebSocketServer: () => ({
      clients: new Set(),
      close(callback) { callback(); },
    }),
  });
  connector.handleNonAudioUpgrade = (request, socket, head) => {
    delegated = { request, socket, head };
  };
  const request = { url: "/_next/webpack-hmr", headers: {} };
  const socket = {};
  const head = Buffer.alloc(0);
  server.emit("upgrade", request, socket, head);
  assert.deepEqual(delegated, { request, socket, head });
  await connector.close();
});

test("Architect DNIS selection accepts up to three E.164 values and fills unused cases safely", () => {
  assert.deepEqual(genesysAudioDnisValues([]), [...GENESYS_AUDIO_PLACEHOLDER_DNIS]);
  assert.deepEqual(genesysAudioDnisValues(["+14155550123"]), [
    "+14155550123",
    "+15550001002",
    "+15550001003",
  ]);
  assert.deepEqual(
    genesysAudioDnisValues('["+14155550123","+442071838750","+61293744000"]'),
    ["+14155550123", "+442071838750", "+61293744000"]
  );
  assert.throws(() => genesysAudioDnisValues(["not-a-number"]), /valid E\.164/);
  assert.throws(
    () => genesysAudioDnisValues(["+14155550123", "+14155550123"]),
    /must be unique/
  );
  assert.throws(
    () => genesysAudioDnisValues(["+1", "+2", "+3", "+4"]),
    /no more than 3/
  );
});

test("Architect flow groups configured DNIS values by Telnyx assistant", async () => {
  const flow = await source("scripts/provision-genesys-audio-connector-flow.mjs");
  const assistant = await source("scripts/provision-telnyx-genesys-assistant.mjs");
  const widget = await source("scripts/provision-genesys-ai-agent-experience.mjs");
  const manager = await source("scripts/manage-genesys-audio.mjs");
  assert.doesNotMatch(flow, /\+48\d{9}/);
  assert.deepEqual(GENESYS_AUDIO_PLACEHOLDER_DNIS, [
    "+15550001001",
    "+15550001002",
    "+15550001003",
  ]);
  assert.match(flow, /addActionSwitch/);
  assert.match(flow, /Call\.CalledAddressOriginal/);
  assert.match(flow, /NoAssistantConfiguredForDnis/);
  assert.match(flow, /setFirstTrueSwitch/);
  assert.match(flow, /groupAssistantRoutes/);
  assert.match(flow, /--assistant-routes-json/);
  assert.match(flow, /--flow-name/);
  assert.match(flow, /GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES/);
  assert.deepEqual(GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES, [
    {
      architectName: "telnyxVar_first_name",
      telnyxName: "first_name",
      value: "John",
    },
    {
      architectName: "telnyxVar_last_name",
      telnyxName: "last_name",
      value: "Wick",
    },
  ]);
  assert.match(flow, /targetFlowName/);
  assert.match(assistant, /enabled_features: \[\.\.\.new Set/);
  assert.match(assistant, /"telephony"/);
  assert.match(assistant, /hangupToolDefinition/);
  assert.match(assistant, /reconciledAssistantToolIds/);
  assert.match(assistant, /attachedGenesysHandoffTools/);
  assert.match(assistant, /DEFAULT_GENESYS_AUDIO_ASSISTANT_NAME/);
  assert.match(assistant, /assistantInstructions\(/);
  assert.match(assistant, /toolDefinition\.webhook\.name/);
  assert.match(assistant, /assistantConfig\?\.forceCreate && existingAssistant/);
  assert.match(assistant, /choose a unique name/);
  assert.doesNotMatch(assistant, /assistant-[0-9a-f]{8}-[0-9a-f-]{27}/);
  assert.match(widget, /INTERACTION_WIDGET_COMMUNICATION_TYPES = "call,open"/);
  assert.match(widget, /communicationTypeFilter: INTERACTION_WIDGET_COMMUNICATION_TYPES/);
  assert.match(widget, /dirname\(fileURLToPath\(import\.meta\.url\)\)[\s\S]*telnyx-ai-handoff-summary\.script/);
  assert.match(widget, /telnyx_logo_black\.png/);
  assert.match(widget, /ensureWidgetOauthRedirectUri/);
  assert.match(widget, /--resource-name/);
  assert.match(widget, /--groups-json/);
  assert.doesNotMatch(widget, /GENESYS_AUDIO_WIDGET_GROUP_NAME|\["Agents"\]/);
  assert.match(manager, /--queues-json/);
  assert.match(manager, /--groups-json/);
  assert.match(manager, /Select every Genesys group/);
  assert.match(manager, /PRIMARY_AUDIO_DEPLOYMENT_ID = "CECA32"/);
  assert.match(manager, /single managed deployment/);
  assert.match(manager, /--assistant-routes-json/);
  assert.match(manager, /--assistant-ids-json/);
  assert.doesNotMatch(manager, /routes\.some\(\(route\) => route\.assistantId !== "__managed_default__"\)/);
  assert.match(manager, /defaultAssistant\?\.enabled && routes\.some\(\(route\) => route\.assistantId === "__managed_default__"\)/);
  assert.match(manager, /select it from the existing assistant list or choose a unique name/);
  assert.match(manager, /forceCreate: Boolean\(current\)/);
  assert.doesNotMatch(manager, /routes\.length !== 1/);
  assert.match(manager, /--call-route-name/);
  assert.match(manager, /--call-route-takeovers-json/);
  assert.match(manager, /callRouteId/);
  assert.doesNotMatch(manager, /randomBytes\(3\).*toString\("hex"\)/);
  assert.doesNotMatch(manager, /Select the installed Audio Connector instance/);
  assert.match(manager, /GENESYS_AUDIO_CONNECTOR_LIMIT/);
  assert.match(manager, /syncManagedDeploymentUrls/);
  assert.match(manager, /plan\.resources\.flowName/);
  assert.doesNotMatch(manager, /queues\.map\(\(\{ name \}\) => name\)\.join\(","\)/);
  assert.match(genesysAudioDnisManualAction("Custom Flow"), /Custom Flow/);
  assert.match(genesysAudioDnisManualAction(), /replace the remaining placeholder DNIS values/);
  assert.doesNotMatch(
    genesysAudioDnisManualAction("Custom Flow", [
      "+14155550123",
      "+442071838750",
      "+61293744000",
    ]),
    /replace the remaining placeholder/
  );
});

test("DNIS-to-assistant routing rejects duplicates and combines numbers for one case", () => {
  const routes = normalizeAssistantRoutes([
    { dnis: "+48111111111", assistantId: "assistant-a" },
    { dnis: "+48222222222", assistantId: "assistant-a" },
    { dnis: "+48333333333", assistantId: "assistant-b" },
  ]);
  assert.deepEqual(groupAssistantRoutes(routes), [
    { assistantId: "assistant-a", dnis: ["+48111111111", "+48222222222"] },
    { assistantId: "assistant-b", dnis: ["+48333333333"] },
  ]);
  assert.equal(
    assistantRouteExpression(["+48111111111", "+48222222222"]),
    'Call.CalledAddressOriginal == "+48111111111" or Call.CalledAddressOriginal == "+48222222222"'
  );
  assert.throws(
    () => normalizeAssistantRoutes([
      { dnis: "+48111111111", assistantId: "assistant-a" },
      { dnis: "+48111111111", assistantId: "assistant-b" },
    ]),
    /assigned more than once/
  );
});

test("package runs Next.js and AudioHook on one custom server", async () => {
  const packageJson = JSON.parse(await source("package.json"));
  assert.equal(packageJson.scripts["genesys:tts"], undefined);
  assert.equal(packageJson.scripts["genesys:audio"], undefined);
  assert.equal(packageJson.scripts["genesys:widget"], undefined);
  assert.equal(packageJson.scripts["genesys:audio:tunnel"], undefined);
  assert.equal(packageJson.scripts.dev, "node server.mjs --dev");
  assert.equal(packageJson.scripts.start, "node server.mjs");
  assert.equal(packageJson.scripts["genesys:audio:bridge"], undefined);
  const server = await source("server.mjs");
  assert.match(server, /process\.env\.PORT \|\| 3000/);
  assert.match(server, /attachGenesysAudioConnector\(server\)/);
  assert.match(server, /Public URL \(\$\{publicMode\}\)/);
  assert.match(server, /Cloudflare Quick Tunnel/);
  assert.match(server, /static HTTPS origin/);
  assert.match(server, /checkTunnelHealth\(publicUrl/);
  assert.match(server, /application is available locally only/);
  assert.match(server, /assertTelnyxTelephoneTargetNormalization/);
  assert.match(server, /Telephone target normalization: enabled/);
  assert.doesNotMatch(server, /3001/);
  const audioManager = await source("scripts/manage-genesys-audio.mjs");
  const widgetManager = await source("scripts/manage-genesys-widget.mjs");
  assert.doesNotMatch(audioManager, /process\.argv|function parseCli/);
  assert.doesNotMatch(widgetManager, /process\.argv|function parseCli/);
});
