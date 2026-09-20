import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  migrateLegacyQuickTunnelState,
  quickTunnelPaths,
} from "../lib/genesys/cloudflare-quick-tunnel.mjs";
import {
  normalizePublicApplicationOrigin,
  synchronizeAllManagedDeploymentUrls,
  updateManagedPublicOrigin,
} from "../lib/genesys/public-origin-manager.mjs";
import { installationResourceNames } from "../lib/genesys/installation-scope.mjs";
import {
  WIDGET_ADMIN_GROUP_ID,
  WIDGET_ADMIN_GROUP_NAME,
  WIDGET_ADMIN_ROLE_ID,
  WIDGET_ADMIN_ROLE_NAME,
  ensureWidgetOpenMessagingIntegration,
  ensureWidgetTypingMessagingSetting,
  widgetClientAppConfiguration,
  widgetHandoffToolDefinition,
  widgetOpenMessagingWebhookUrl,
} from "../lib/genesys/widget-installer-resources.mjs";
import {
  WIDGET_MESSAGE_FLOW_AGENT_EXPERIENCE_MARKER,
  configureWidgetMessageFlow,
} from "../lib/genesys/widget-message-flow.mjs";
import {
  addWidgetAdministrationOrigin,
  configurePublicUrl,
  createWidgetInfrastructurePlan,
  createWidgetInstallationPlan,
  ensureTelnyxAssistantHangupTool,
  ensureTelnyxWidgetTool,
  ensureTelnyxWidgetTransferTool,
  generateWidgetSecrets,
  listInboundMessageFlows,
  missingWidgetConfiguration,
  inspectPublishedWidgetAssistantToolConflicts,
  reconcilePublishedWidgetAssistantToolConflicts,
  runWidgetDeploymentStep,
  saveWidgetEnvironmentValues,
} from "../scripts/manage-genesys-widget.mjs";

test("Web Chat Infrastructure uses one fixed deployment, predefined access, flow, and shared handoff tool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-widget-infrastructure-"));
  const previousOrigin = process.env.GC_PUBLIC_BASE_URL;
  process.env.GC_PUBLIC_BASE_URL = "https://widgets.example.eu";
  try {
    const context = {
      environment: "usw2.pure.cloud",
      organization: { id: "org-1", name: "Example" },
      groups: [{ id: WIDGET_ADMIN_GROUP_ID, name: WIDGET_ADMIN_GROUP_NAME }],
      roles: [{ id: WIDGET_ADMIN_ROLE_ID, name: WIDGET_ADMIN_ROLE_NAME }],
      queues: [
        { id: "queue-1", name: "Sales" },
        { id: "queue-2", name: "Support" },
      ],
      allMessageFlows: [],
      messageFlows: [],
      openMessaging: [],
    };
    const telnyx = {
      ai: {
        tools: {
          async *list() {
            yield {
              id: "shared-tool-1",
              display_name: "Telnyx Integrations",
              tool_definition: { type: "webhook", webhook: { name: "request_genesys_human_handoff" } },
            };
          },
        },
      },
    };
    const { plan } = await createWidgetInfrastructurePlan({
      queueIds: ["queue-1", "queue-2"],
      defaultQueueId: "queue-2",
      context,
      telnyx,
      options: { "state-dir": directory },
    });
    assert.equal(plan.deployment.id, "WEBCHAT");
    assert.equal(plan.deployment.name, "Telnyx Integrations");
    assert.equal(plan.access.group.id, WIDGET_ADMIN_GROUP_ID);
    assert.equal(plan.access.role.id, WIDGET_ADMIN_ROLE_ID);
    assert.equal(plan.messaging.routingFlow.name, "Telnyx Integrations");
    assert.equal(plan.messaging.defaultQueue.id, "queue-2");
    assert.equal(plan.resources.openMessaging.name, "Telnyx Integrations");
    assert.equal(plan.resources.telnyxHandoffTool.id, "shared-tool-1");
    assert.equal(plan.resources.telnyxHandoffTool.functionName, "request_genesys_human_handoff");
    assert.equal(plan.messaging.assistant, undefined);
  } finally {
    if (previousOrigin === undefined) delete process.env.GC_PUBLIC_BASE_URL;
    else process.env.GC_PUBLIC_BASE_URL = previousOrigin;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Web Chat Infrastructure plan is empty when fake live objects match the managed manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-widget-infrastructure-noop-"));
  const previousOrigin = process.env.GC_PUBLIC_BASE_URL;
  process.env.GC_PUBLIC_BASE_URL = "https://widgets.example.eu";
  try {
    await writeFile(path.join(directory, "infrastructure.json"), JSON.stringify({
      schemaVersion: 1,
      deployment: { id: "WEBCHAT", name: "Telnyx Integrations" },
      publicBaseUrl: "https://widgets.example.eu",
      messaging: {
        queues: [
          { id: "queue-1", name: "Sales" },
          { id: "queue-2", name: "Support" },
        ],
        defaultQueue: { id: "queue-2", name: "Support" },
        routingFlow: { id: "flow-1", name: "Telnyx Integrations" },
        recipientId: "recipient-1",
      },
      resources: {
        openMessagingIntegrationId: "open-messaging-1",
        telnyxHandoffToolId: "shared-tool-1",
        scriptId: "script-1",
        interactionWidgetId: "interaction-widget-1",
      },
    }));
    const flow = {
      id: "flow-1",
      name: "Telnyx Integrations",
      description: `Managed by genesys:widget; ${WIDGET_MESSAGE_FLOW_AGENT_EXPERIENCE_MARKER}`,
      publishedVersion: { id: "version-1", version: 1 },
    };
    const openMessaging = {
      id: "open-messaging-1",
      name: "Telnyx Integrations",
      outboundNotificationWebhookUrl: widgetOpenMessagingWebhookUrl(
        "https://widgets.example.eu",
        "open-messaging-1"
      ),
      recipient: { id: "recipient-1" },
    };
    const context = {
      environment: "usw2.pure.cloud",
      organization: { id: "org-1", name: "Example" },
      groups: [{ id: WIDGET_ADMIN_GROUP_ID, name: WIDGET_ADMIN_GROUP_NAME }],
      roles: [{ id: WIDGET_ADMIN_ROLE_ID, name: WIDGET_ADMIN_ROLE_NAME }],
      queues: [
        { id: "queue-1", name: "Sales" },
        { id: "queue-2", name: "Support" },
      ],
      allMessageFlows: [flow],
      messageFlows: [flow],
      openMessaging: [openMessaging],
      routingApi: {
        async getRoutingMessageRecipient(id) {
          assert.equal(id, "recipient-1");
          return { id, flow: { id: "flow-1", name: flow.name } };
        },
      },
    };
    const telnyx = {
      ai: {
        tools: {
          async *list() {
            yield {
              id: "shared-tool-1",
              display_name: "Telnyx Integrations",
              tool_definition: { type: "webhook", webhook: { name: "request_genesys_human_handoff" } },
            };
          },
        },
      },
    };
    const { plan } = await createWidgetInfrastructurePlan({
      queueIds: ["queue-1", "queue-2"],
      defaultQueueId: "queue-2",
      context,
      telnyx,
      options: { "state-dir": directory },
    });

    assert.deepEqual(plan.changes, {
      isCreate: false,
      queuePolicyChanged: false,
      agentExperienceChanged: false,
      architectFlowChanged: false,
      openMessagingChanged: false,
      recipientChanged: false,
      handoffToolChanged: false,
      manifestChanged: false,
      hasChanges: false,
    });
  } finally {
    if (previousOrigin === undefined) delete process.env.GC_PUBLIC_BASE_URL;
    else process.env.GC_PUBLIC_BASE_URL = previousOrigin;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Widget deployment steps report running and successful resource status", async () => {
  const events = [];
  const result = await runWidgetDeploymentStep({
    onProgress: (event) => events.push(event),
    label: "Create Genesys Architect flow: Example",
    operation: async () => ({ id: "flow-1" }),
    successDetail: (flow) => `created · ${flow.id}`,
  });
  assert.equal(result.id, "flow-1");
  assert.deepEqual(events, [
    { status: "running", label: "Create Genesys Architect flow: Example" },
    {
      status: "success",
      label: "Create Genesys Architect flow: Example",
      detail: "created · flow-1",
    },
  ]);
});

test("Widget deployment steps preserve their Admin App deployment ordinal", async () => {
  const events = [];
  await runWidgetDeploymentStep({
    ordinal: 5,
    onProgress: (event) => events.push(event),
    label: "Persist the managed Web Chat infrastructure manifest",
    operation: async () => undefined,
  });
  assert.deepEqual(events, [
    {
      ordinal: 5,
      status: "running",
      label: "Persist the managed Web Chat infrastructure manifest",
    },
    {
      ordinal: 5,
      status: "success",
      label: "Persist the managed Web Chat infrastructure manifest",
      detail: "",
    },
  ]);
});

test("Web Chat infrastructure progress matches the six Admin App review steps", async () => {
  const source = await readFile(
    new URL("../scripts/manage-genesys-widget.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /ordinal: 2,[\s\S]{0,160}label: `Enable the Genesys interaction widget/);
  assert.match(source, /ordinal: 3,[\s\S]{0,160}label: `Ensure shared Genesys Open Messaging integration/);
  assert.match(source, /ordinal: 4,[\s\S]{0,160}label: "Ensure the shared Telnyx handoff integration secret"/);
  assert.match(source, /ordinal: 5,[\s\S]{0,160}label: "Persist the managed Web Chat infrastructure manifest"/);
  assert.match(source, /enabled for call,open/);
});

test("Widget deployment steps report the exact failing resource", async () => {
  const events = [];
  await assert.rejects(
    () => runWidgetDeploymentStep({
      onProgress: (event) => events.push(event),
      label: "Create Genesys Open Messaging integration: Example",
      operation: async () => { throw new Error("recipient creation failed"); },
    }),
    /recipient creation failed/
  );
  assert.deepEqual(events.at(-1), {
    status: "failure",
    label: "Create Genesys Open Messaging integration: Example",
    detail: "recipient creation failed",
  });
});

test("widget voice provisioning preserves Audio Connector tools and adds a separate SIP Transfer tool", async () => {
  const assistantUpdates = [];
  const toolUpdates = [];
  const assistant = {
    id: "assistant-1",
    name: "Combined assistant",
    instructions: "Existing instructions",
    enabled_features: ["messaging"],
    tools: [
      {
        id: "handoff-1",
        shared: true,
        tool_definition: {
          type: "webhook",
          webhook: { name: "request_genesys_human_handoff_a1b2c3" },
        },
      },
      { id: "hangup-1", shared: true, tool_definition: { type: "hangup" } },
      {
        id: "transfer-1",
        shared: true,
        display_name: "Old Genesys transfer",
        tool_definition: {
          type: "transfer",
          transfer: {
            from: "+48111111111",
            targets: [{ name: "Genesys", to: "sip:widget@genesys.example.eu" }],
          },
        },
      },
    ],
  };
  const telnyx = {
    ai: {
      assistants: {
        retrieve: async () => assistant,
        update: async (id, body) => {
          assistantUpdates.push({ id, body });
          return { ...assistant, ...body };
        },
      },
      tools: {
        list: async () => ({ data: [] }),
        retrieve: async () => { throw new Error("unexpected tool retrieve"); },
        create: async (body) => {
          toolUpdates.push({ id: "queue-tool-1", body });
          return { id: "queue-tool-1", ...body };
        },
        update: async (id, body) => {
          toolUpdates.push({ id, body });
          return { id, ...body };
        },
      },
    },
  };
  const result = await ensureTelnyxWidgetTransferTool({
    telnyx,
    assistantId: assistant.id,
    queues: [{ id: "queue-1", name: "Support" }],
    displayName: "Widget - Genesys SIP Transfer",
    from: "{{telnyx_end_user_target}}",
    to: "sip:widget@genesys.example.eu",
    targetName: "Genesys Cloud",
  });
  assert.equal(result.tool.id, "transfer-1");
  assert.equal(result.toolManaged, false);
  assert.equal(toolUpdates[0].body.type, "update_dynamic_variables");
  assert.equal(
    toolUpdates[0].body.update_dynamic_variables.name,
    "select_genesys_voice_queue"
  );
  assert.equal(toolUpdates[1].body.type, "transfer");
  assert.equal(toolUpdates[1].body.transfer.from, "{{telnyx_end_user_target}}");
  assert.equal(toolUpdates[1].body.transfer.targets[0].to, "{{genesys_handoff_sip_uri}}");
  assert.deepEqual(toolUpdates[1].body.transfer.custom_headers, [
    { name: "X-TGX-Queue-Name", value: "{{genesys_queue_name}}" },
    { name: "X-TGX-Call-Control-Id", value: "{{call_control_id}}" },
    { name: "X-TGX-Widget-Session-Id", value: "{{widget_session_id}}" },
    { name: "X-TGX-Handoff-Reason", value: "{{genesys_handoff_reason}}" },
    { name: "X-TGX-Summary", value: "{{genesys_handoff_summary}}" },
    { name: "X-TGX-Intent", value: "{{genesys_handoff_intent}}" },
    { name: "X-TGX-Sentiment", value: "{{genesys_handoff_sentiment}}" },
  ]);
  assert.deepEqual(
    toolUpdates[0].body.update_dynamic_variables.updatable_variables.map(({ name }) => name),
    [
      "genesys_queue_name",
      "genesys_handoff_reason",
      "genesys_handoff_summary",
      "genesys_handoff_intent",
      "genesys_handoff_sentiment",
      "genesys_handoff_sip_uri",
    ]
  );
  assert.deepEqual(
    toolUpdates[0].body.update_dynamic_variables.updatable_variables.map(({ type }) => type),
    ["string", "string", "string", "string", "string", "string"]
  );
  assert.equal(
    toolUpdates[0].body.update_dynamic_variables.updatable_variables.at(-1).description,
    "Use sip:widget@genesys.example.eu"
  );
  assert.deepEqual(assistantUpdates[0].body.tool_ids, [
    "handoff-1",
    "hangup-1",
    "transfer-1",
    "queue-tool-1",
  ]);
  assert.deepEqual(assistantUpdates[0].body.enabled_features, ["messaging", "telephony"]);
  assert.match(assistantUpdates[0].body.instructions, /For websocket_call, call the webhook tool request_genesys_human_handoff_a1b2c3/);
  assert.match(assistantUpdates[0].body.instructions, /For phone_call or web_call, first call select_genesys_voice_queue exactly once/);
  assert.match(assistantUpdates[0].body.instructions, /then call the Telnyx Transfer tool Widget - Genesys SIP Transfer/);
  assert.match(assistantUpdates[0].body.instructions, /plus genesys_handoff_sip_uri/);
});

test("widget handoff provisioning resolves a full attached tool when the assistant inline tool omits display_name", async () => {
  const updates = [];
  const inlineTool = {
    id: "handoff-audio-1",
    tool_definition: {
      type: "webhook",
      webhook: { name: "request_genesys_human_handoff_a1b2c3" },
    },
  };
  const fullTool = {
    id: inlineTool.id,
    display_name: "Existing Audio Genesys Handoff",
    tool_definition: inlineTool.tool_definition,
  };
  const assistant = {
    id: "assistant-1",
    name: "Shared assistant",
    instructions: "Existing",
    enabled_features: ["telephony"],
    tools: [inlineTool],
  };
  const telnyx = {
    integrationSecrets: {
      async *list() { yield { id: "secret-1", identifier: "genesys-widget-handoff-test" }; },
      async create(body) { return { id: "secret-created", ...body }; },
    },
    ai: {
      assistants: {
        retrieve: async () => assistant,
        update: async (_id, body) => ({ ...assistant, ...body }),
      },
      tools: {
        retrieve: async (id) => {
          assert.equal(id, fullTool.id);
          return fullTool;
        },
        update: async (id, body) => {
          updates.push({ id, body });
          return { id, ...body };
        },
      },
    },
  };
  const result = await ensureTelnyxWidgetTool({
    telnyx,
    baseUrl: "https://widgets.example.eu",
    assistant: { operation: "reuse", id: assistant.id },
    queues: [{ id: "queue-1", name: "Support" }],
    token: "x".repeat(32),
    displayName: "Widget - Genesys Handoff",
  });
  assert.equal(result.tool.id, fullTool.id);
  assert.equal(updates[0].body.display_name, fullTool.display_name);
});

test("a managed widget assistant reuses the registered shared Hangup tool even after rename", async () => {
  const toolUpdates = [];
  let assistantBody;
  let toolCreateCount = 0;
  const handoffTool = {
    id: "handoff-1",
    display_name: "Widget - Genesys Handoff",
    tool_definition: {
      type: "webhook",
      webhook: { name: "request_genesys_human_handoff_a1b2c3" },
    },
  };
  const telnyx = {
    integrationSecrets: {
      async *list() {},
      async create(body) { return { id: "secret-1", ...body }; },
    },
    ai: {
      assistants: {
        async list() { return { data: [], meta: { total_pages: 1 } }; },
        async create(body) {
          assistantBody = body;
          return { id: "assistant-1", ...body };
        },
      },
      tools: {
        async *list() { yield handoffTool; },
        async retrieve(id) {
          assert.equal(id, "hangup-registered");
          return {
            id,
            display_name: "Custom renamed Hangup",
            tool_definition: { type: "hangup", hangup: {} },
          };
        },
        async update(id, body) {
          toolUpdates.push({ id, body });
          return { id, ...body };
        },
        async create(body) {
          toolCreateCount += 1;
          return { id: `created-${toolCreateCount}`, ...body };
        },
      },
    },
  };
  const result = await ensureTelnyxWidgetTool({
    telnyx,
    baseUrl: "https://widgets.example.eu",
    assistant: { operation: "create-or-update-managed", name: "Managed Widget Assistant" },
    queues: [{ id: "queue-1", name: "Support" }],
    token: "x".repeat(32),
    displayName: handoffTool.display_name,
    preferredHangupToolId: "hangup-registered",
  });
  assert.equal(result.hangupTool.id, "hangup-registered");
  assert.equal(toolCreateCount, 0);
  assert.equal(toolUpdates.find(({ id }) => id === "hangup-registered").body.display_name, "Telnyx Integrations");
  assert.deepEqual(assistantBody.tool_ids, ["handoff-1", "hangup-registered"]);
  assert.deepEqual(assistantBody.transcription, { model: "deepgram/flux", language: "en" });
  assert.match(assistantBody.instructions, /## Ending voice calls/);
  assert.match(assistantBody.instructions, /call the Hangup tool exactly once/);
});

test("a reused voice assistant receives idempotent Hangup instructions with the shared tool", async () => {
  let assistant = {
    id: "assistant-reused",
    name: "Reused voice assistant",
    instructions: "Keep these existing instructions.",
    tool_ids: ["existing-tool"],
  };
  const telnyx = {
    ai: {
      assistants: {
        async retrieve() { return assistant; },
        async update(_id, body) {
          assistant = { ...assistant, ...body };
          return assistant;
        },
      },
      tools: {
        async *list() {},
        async retrieve(id) {
          return { id, display_name: "Genesys Hangup", tool_definition: { type: "hangup", hangup: {} } };
        },
        async create(body) { return { id: "hangup-created", ...body }; },
        async update(id, body) { return { id, ...body }; },
      },
    },
  };
  await ensureTelnyxAssistantHangupTool({ telnyx, assistantId: assistant.id });
  await ensureTelnyxAssistantHangupTool({
    telnyx,
    assistantId: assistant.id,
    preferredHangupToolId: "hangup-created",
  });
  assert.match(assistant.instructions, /Keep these existing instructions/);
  assert.match(assistant.instructions, /call the Hangup tool exactly once/);
  assert.equal(assistant.instructions.match(/## Ending voice calls/g)?.length, 1);
  assert.deepEqual(assistant.tool_ids, ["existing-tool", "hangup-created"]);
});

test("widget publish requires approval before replacing conflicting singleton inline and shared tools", async () => {
  const assistant = {
    id: "assistant-real-estate",
    name: "Real Estate Concierge",
    instructions: "Keep existing instructions.",
    tool_ids: ["crm-webhook", "foreign-hangup", "foreign-transfer"],
    tools: [
      { type: "hangup", hangup: { description: "Legacy inline hangup" } },
      { type: "webhook", webhook: { name: "inline_crm", url: "https://crm.example.test" } },
    ],
  };
  const sharedTools = {
    "crm-webhook": { id: "crm-webhook", display_name: "CRM", tool_definition: { type: "webhook", webhook: { name: "crm" } } },
    // Matching a managed display name is not enough once PostgreSQL tracks a
    // different remote ID; this foreign tool must still require approval.
    "foreign-hangup": { id: "foreign-hangup", display_name: installationResourceNames().sharedHangupTool, tool_definition: { type: "hangup", hangup: { description: "Foreign shared hangup" } } },
    "foreign-transfer": { id: "foreign-transfer", display_name: "Legacy Transfer", tool_definition: { type: "transfer", transfer: { targets: [{ to: "+15550001111" }] } } },
  };
  const assistantUpdates = [];
  const telnyx = {
    ai: {
      assistants: {
        async retrieve() { return assistant; },
        async update(id, body) { assistantUpdates.push({ id, body }); return { ...assistant, ...body }; },
      },
      tools: {
        async retrieve(id) { return sharedTools[id]; },
      },
    },
  };
  const config = {
    channels: {
      messaging: { enabled: true, assistantId: assistant.id },
      voice: { enabled: true, assistantId: assistant.id, keepAssistantOnCall: false },
    },
  };
  const managedTools = {
    hangup: { remoteToolId: "managed-hangup" },
    handoff: { remoteToolId: "managed-transfer" },
  };
  const inspection = await inspectPublishedWidgetAssistantToolConflicts({
    organizationId: "org-1",
    widget: { id: "widget-1", publicId: "wgt_real_estate", name: "Real Estate Concierge" },
    config,
    telnyx,
    managedTools,
  });
  assert.deepEqual(inspection.conflicts.map(({ type, source }) => ({ type, source })), [
    { type: "hangup", source: "inline" },
    { type: "hangup", source: "shared" },
    { type: "transfer", source: "shared" },
  ]);
  await assert.rejects(() => reconcilePublishedWidgetAssistantToolConflicts({
    organizationId: "org-1",
    widget: { id: "widget-1", publicId: "wgt_real_estate", name: "Real Estate Concierge" },
    config,
    telnyx,
    managedTools,
  }), (error) => error.code === "assistant_tool_conflict" && error.status === 409);
  await reconcilePublishedWidgetAssistantToolConflicts({
    organizationId: "org-1",
    widget: { id: "widget-1", publicId: "wgt_real_estate", name: "Real Estate Concierge" },
    config,
    telnyx,
    managedTools,
    approvedConflictKeys: inspection.conflicts.map(({ key }) => key),
  });
  assert.deepEqual(assistantUpdates[0].body.tool_ids, ["crm-webhook"]);
  assert.deepEqual(assistantUpdates[0].body.tools, [
    { type: "webhook", webhook: { name: "inline_crm", url: "https://crm.example.test" } },
  ]);
});

test("approved singleton replacement creates its own Telnyx client when none is supplied", async () => {
  const assistant = {
    id: "assistant-healthcare",
    name: "Healthcare Appointments",
    instructions: "Keep existing instructions.",
    tool_ids: [],
    tools: [{ type: "hangup", hangup: { description: "Inline Hangup" } }],
  };
  const assistantUpdates = [];
  const telnyx = {
    ai: {
      assistants: {
        async retrieve() { return assistant; },
        async update(id, body) {
          assistantUpdates.push({ id, body });
          return { ...assistant, ...body };
        },
      },
      tools: {
        async retrieve() { throw new Error("No shared tools expected"); },
      },
    },
  };
  const args = {
    organizationId: "org-1",
    widget: { id: "widget-healthcare", publicId: "wgt_healthcare", name: "Healthcare Appointments" },
    config: {
      channels: {
        messaging: { enabled: true, assistantId: assistant.id },
        voice: { enabled: true, assistantId: assistant.id, keepAssistantOnCall: false },
      },
    },
    managedTools: {
      hangup: { remoteToolId: "managed-hangup" },
      handoff: { remoteToolId: "managed-transfer" },
    },
    telnyxFactory: () => telnyx,
  };
  const inspection = await inspectPublishedWidgetAssistantToolConflicts({ ...args, telnyx });
  await reconcilePublishedWidgetAssistantToolConflicts({
    ...args,
    approvedConflictKeys: inspection.conflicts.map(({ key }) => key),
  });
  assert.equal(assistantUpdates.length, 1);
  assert.deepEqual(assistantUpdates[0], {
    id: assistant.id,
    body: { tools: [], tool_ids: [] },
  });
});

test("widget manager persists and can rotate the shared WebRTC caller number", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-widget-caller-"));
  const envFile = path.join(directory, ".env");
  const environment = {};
  try {
    await saveWidgetEnvironmentValues({
      values: { TELNYX_WIDGET_CALLER_NUMBER: "+48221234567" },
      environment,
      envFile,
    });
    await saveWidgetEnvironmentValues({
      values: { TELNYX_WIDGET_CALLER_NUMBER: "+48227654321" },
      replaceNames: ["TELNYX_WIDGET_CALLER_NUMBER"],
      environment,
      envFile,
    });
    assert.match(await readFile(envFile, "utf8"), /TELNYX_WIDGET_CALLER_NUMBER=\+48227654321/);
    assert.equal(environment.TELNYX_WIDGET_CALLER_NUMBER, "+48227654321");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Web Admin widget bootstrap is independent of Audio and TTS secrets", () => {
  const environment = {
    GC_ENVIRONMENT: "usw2.pure.cloud",
    GC_CLIENT_CRED_CLIENT_ID: "client",
    GC_CLIENT_CRED_CLIENT_SECRET: "secret",
    TELNYX_API_KEY: "KEY",
    GC_PUBLIC_BASE_URL: "https://widgets.example.eu",
    WIDGET_SESSION_SIGNING_SECRET: "a".repeat(64),
    WIDGET_HANDOFF_API_KEY: "b".repeat(64),
    GC_OPEN_MESSAGING_SECRET: "c".repeat(64),
    DATABASE_URL: "postgres://example.invalid/widget",
  };
  assert.deepEqual(missingWidgetConfiguration(environment), []);
  assert.equal(environment.GC_AUDIO_CONNECTOR_API_KEY, undefined);
  assert.equal(environment.GC_AUDIO_HANDOFF_API_KEY, undefined);
  assert.equal(environment.TELNYX_TTS_API_KEY, undefined);
  assert.deepEqual(Object.keys(generateWidgetSecrets()).sort(), [
    "GC_OPEN_MESSAGING_SECRET",
    "GENESYS_HANDOFF_API_KEY",
    "WIDGET_HANDOFF_API_KEY",
    "WIDGET_SESSION_SIGNING_SECRET",
  ]);
  const generated = generateWidgetSecrets();
  assert.equal(generated.GENESYS_HANDOFF_API_KEY, generated.WIDGET_HANDOFF_API_KEY);
});

test("interactive widget setup continues when GC_PUBLIC_BASE_URL already exists", async () => {
  let prompted = false;
  const result = await configurePublicUrl(
    {
      async selectMenu() {
        prompted = true;
        return "exit";
      },
    },
    { environment: { GC_PUBLIC_BASE_URL: "https://widgets.example.eu" } }
  );
  assert.equal(result, true);
  assert.equal(prompted, false);
});

test("widget inventory requests the Genesys INBOUNDSHORTMESSAGE enum and keeps published flows", async () => {
  const requests = [];
  const flows = await listInboundMessageFlows({
    async getFlows(options) {
      requests.push(options);
      return {
        entities: [
          { id: "published", name: "Published", publishedVersion: { id: "version-1" } },
          { id: "draft", name: "Draft only" },
        ],
      };
    },
  });
  assert.deepEqual(requests[0].type, ["INBOUNDSHORTMESSAGE"]);
  assert.deepEqual(flows.map(({ id }) => id), ["published"]);
});

test("widget deployment recovery can inventory an unpublished managed message flow", async () => {
  const flows = await listInboundMessageFlows({
    async getFlows() {
      return {
        entities: [
          { id: "published", name: "Published", publishedVersion: { id: "version-1" } },
          { id: "draft", name: "Interrupted managed flow" },
        ],
      };
    },
  }, { includeUnpublished: true });
  assert.deepEqual(flows.map(({ id }) => id), ["published", "draft"]);
});

test("widget resource URLs and webhook tool all derive from one public origin", () => {
  const baseUrl = "https://widgets.example.eu";
  assert.equal(normalizePublicApplicationOrigin(`${baseUrl}/`), baseUrl);
  assert.equal(
    widgetOpenMessagingWebhookUrl(baseUrl, "integration 1"),
    `${baseUrl}/api/webhooks/genesys/open-messaging/integration%201`
  );
  const config = widgetClientAppConfiguration({
    baseUrl,
    groupIds: ["group-1", "group-1", "group-2"],
  });
  assert.equal(config.properties.url, `${baseUrl}/genesys/widget-admin`);
  assert.deepEqual(config.properties.groups, ["group-1", "group-2"]);
  const tool = widgetHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: "widget-secret",
  });
  assert.equal(tool.webhook.url, `${baseUrl}/api/genesys/handoff`);
  assert.equal(tool.webhook.name, "request_genesys_human_handoff");
  assert.deepEqual(tool.webhook.body_parameters.required, [
    "telnyx_conversation_channel",
    "reason",
    "summary",
    "intent",
    "sentiment",
  ]);
});

test("deployment handoff tool restricts queue names to the selected allowlist", () => {
  const tool = widgetHandoffToolDefinition({
    baseUrl: "https://widgets.example.eu",
    integrationSecretIdentifier: "widget-secret",
    displayName: "Widget ABC Handoff",
    queues: [
      { id: "queue-1", name: "Sales" },
      { id: "queue-2", name: "Support" },
    ],
  });
  assert.equal(tool.display_name, "Widget ABC Handoff");
  assert.equal(tool.webhook.body_parameters.properties.queue_id, undefined);
  assert.deepEqual(tool.webhook.body_parameters.properties.queue_name.enum, ["Sales", "Support"]);
  assert.ok(!tool.webhook.body_parameters.required.includes("queue_name"));
  assert.ok(tool.webhook.body_parameters.required.includes("telnyx_conversation_channel"));
});

test("managed Architect message flow switches over every allowed queue ID", async () => {
  const transferred = [];
  const disconnected = [];
  const participantOutputs = [];
  const screenPops = [];
  let scriptLookupAttempts = 0;
  const task = { name: "", actions: [], deleteAction() {} };
  const flow = {
    startUpObject: task,
    dataTypes: { string: { name: "string" } },
    variables: new Map(),
    getVariableByName(name) { return this.variables.get(name); },
    addVariable(name) {
      const variable = { name };
      this.variables.set(`Flow.${name}`, variable);
      return variable;
    },
  };
  const outputs = [{ id: "case-1" }, { id: "case-2" }];
  const scripting = {
    factories: {
      archFactoryTasks: { addTask() { return task; } },
      archFactoryActions: {
        addActionGetParticipantData() {
          return {
            addAttributeNameOutputValuePair(name, variable) {
              participantOutputs.push({ name, variable });
            },
          };
        },
        addActionSwitch(_container, _name, expression, cases) {
          assert.equal(expression, "Flow.TelnyxWidgetQueueId");
          assert.deepEqual(cases, ['"queue-1"', '"queue-2"']);
          return {
            outputDefault: { id: "default" },
            getOutputByIndex(index) { return outputs[index]; },
          };
        },
        addActionTransferToAcd(output, name) {
          const transfer = {
            get outputFailure() {
              throw new Error("Inbound message transfers do not expose a scriptable failure branch");
            },
            priority: { setLiteralInt(value) { assert.equal(value, 0); } },
            async setLiteralByQueueIdAsync(id) { transferred.push({ id, name }); },
          };
          return transfer;
        },
        addActionSetScreenPop(output, name) {
          const inputs = new Map();
          const screenPop = {
            output,
            name,
            scriptId: null,
            scriptInputs: {
              getNamedValueByName(inputName) {
                if (!inputs.has(inputName)) {
                  const value = {
                    expression: null,
                    literal: null,
                    setExpressionFromVariable(variable) { this.expression = variable.name; },
                    setLiteralString(literal) { this.literal = literal; },
                  };
                  inputs.set(inputName, { value });
                }
                return inputs.get(inputName);
              },
            },
            async setScriptByIdAsync(scriptId) {
              scriptLookupAttempts += 1;
              if (scriptLookupAttempts <= 2) throw "Input validation error.";
              this.scriptId = scriptId;
            },
          };
          screenPops.push({ screenPop, inputs });
          return screenPop;
        },
        addActionDisconnect(output) { disconnected.push(output.id); },
      },
    },
  };
  await configureWidgetMessageFlow(scripting, flow, [
    { id: "queue-1", name: "Sales" },
    { id: "queue-2", name: "Support" },
  ], {
    handoffScriptId: "script-1",
    screenPopScriptWait: async () => {},
  });
  assert.deepEqual(transferred.map(({ id }) => id), ["queue-1", "queue-2"]);
  assert.deepEqual(disconnected, ["default"]);
  assert.deepEqual(participantOutputs.map(({ name, variable }) => [name, variable]), [
    ['"telnyx_ai_queue_id"', "flow.TelnyxWidgetQueueId"],
    ['"telnyx_ai_queue_name"', "flow.TelnyxWidgetQueueName"],
    ['"telnyx_conversation_id"', "flow.TelnyxConversationId"],
    ['"telnyx_ai_handoff_reason"', "flow.TelnyxHandoffReason"],
    ['"telnyx_ai_summary"', "flow.TelnyxSummary"],
    ['"telnyx_ai_intent"', "flow.TelnyxIntent"],
    ['"telnyx_ai_sentiment"', "flow.TelnyxSentiment"],
  ]);
  assert.equal(screenPops.length, 2);
  assert.equal(scriptLookupAttempts, 4);
  for (const { screenPop, inputs } of screenPops) {
    assert.equal(screenPop.scriptId, "script-1");
    assert.equal(inputs.get("Channel").value.literal, "messaging");
    assert.equal(inputs.get("Summary").value.expression, "TelnyxSummary");
    assert.equal(inputs.get("TelnyxConversationId").value.expression, "TelnyxConversationId");
  }
  assert.match(flow.description, new RegExp(WIDGET_MESSAGE_FLOW_AGENT_EXPERIENCE_MARKER));
});

test("widget deployment always adds the administration origin without duplicating it", () => {
  assert.deepEqual(
    addWidgetAdministrationOrigin(
      ["https://www.customer.example", "https://widgets.example.eu"],
      "https://widgets.example.eu/"
    ),
    ["https://www.customer.example", "https://widgets.example.eu"]
  );
});

test("widget deployment planning rejects a missing customer website origin", async () => {
  await assert.rejects(
    () => createWidgetInstallationPlan({
      context: {},
      options: { url: "https://widgets.example.eu" },
    }),
    /At least one customer website embedding origin is required/
  );
});

test("Widget deployment plan owns per-deployment resources and supports many queues", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-widget-plan-"));
  try {
    const { plan } = await createWidgetInstallationPlan({
      context: {
        environment: "usw2.pure.cloud",
        organization: { id: "org-1", name: "Example" },
        groups: [{ id: "group-1", name: "Admins", type: "official" }],
        queues: [
          { id: "queue-1", name: "Sales" },
          { id: "queue-2", name: "Support" },
        ],
        messageFlows: [],
        roles: [],
        clientApplications: [],
        openMessaging: [],
      },
      options: {
        "state-dir": directory,
        id: "A1B2C3",
        name: "Customer Widget",
        url: "https://widgets.example.eu",
        groups: "group-1",
        "queue-ids": "queue-1,queue-2",
        "create-assistant": true,
        "enable-voice": true,
        "genesys-sip-uri": "sip:widget@genesys.example.eu",
        "web-caller-number": "+48221234567",
        "voice-region": "eu",
        "allowed-origins": "https://www.example.eu",
      },
    });
    assert.equal(plan.schemaVersion, 2);
    assert.deepEqual(plan.messaging.queues.map(({ id }) => id), ["queue-1", "queue-2"]);
    assert.equal(plan.messaging.routingFlow.operation, "create-or-update-managed");
    assert.equal(plan.messaging.assistant.operation, "create-or-update-managed");
    assert.deepEqual(plan.messaging.allowedOrigins, [
      "https://www.example.eu",
      "https://widgets.example.eu",
    ]);
    assert.equal(plan.resources.openMessaging.name, "Telnyx Integrations - Customer Widget");
    assert.equal(plan.resources.telnyxHandoffTool.name, "Telnyx Integrations");
    assert.equal(plan.voice.enabled, true);
    assert.equal(plan.voice.assistant.operation, "same-as-messaging");
    assert.equal(plan.voice.genesysSipUri, "sip:widget@genesys.example.eu");
    assert.equal(plan.voice.callerNumber, "+48221234567");
    assert.equal(plan.voice.transferFrom, "{{telnyx_end_user_target}}");
    assert.equal(plan.resources.telnyxTransferTool.name, "Telnyx Integrations - Customer Widget");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Widget deployment plan selects a Genesys trunk and defers a single synthetic DID allocation to apply", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-widget-sip-plan-"));
  try {
    const { plan } = await createWidgetInstallationPlan({
      context: {
        environment: "usw2.pure.cloud",
        organization: { id: "org-1", name: "Example" },
        groups: [{ id: "group-1", name: "Admins", type: "official" }],
        queues: [{ id: "queue-1", name: "Sales" }],
        messageFlows: [],
        roles: [],
        clientApplications: [],
        openMessaging: [],
        sipInventory: {
          trunks: [{
            id: "trunk-byoc",
            name: "BYOC",
            enabled: true,
            dnisReplacementEnabled: false,
            routingAddress: "Request-URI",
            fqdn: "telnyx.byoc.usw2.pure.cloud",
          }],
          destinations: [{
            id: "did-sales",
            phoneNumber: "+48123123050",
            ownerType: "IVR_CONFIG",
            route: {
              id: "ivr-sales",
              name: "Sales Queue",
              flows: [{ id: "flow-sales", name: "Transfer from AI Assistants", schedule: "open" }],
            },
          }],
        },
      },
      options: {
        "state-dir": directory,
        id: "A1B2C4",
        name: "Discovered Voice Widget",
        url: "https://widgets.example.eu",
        groups: "group-1",
        "queue-ids": "queue-1",
        "create-assistant": true,
        "enable-voice": true,
        "genesys-trunk-id": "trunk-byoc",
        "web-caller-number": "+48221234567",
        "allowed-origins": "https://www.example.eu",
      },
    });
    assert.equal(plan.voice.genesysSipUri, null);
    assert.equal(plan.voice.sipDestination.mode, "managed-did");
    assert.equal(plan.voice.sipDestination.trunk.id, "trunk-byoc");
    assert.deepEqual(plan.voice.sipDestination.namespace, {
      start: "+11009999000",
      end: "+11009999999",
      allocation: "first-free-single-number-pool",
    });
    assert.equal(plan.voice.routingFlow.name, "Telnyx Integrations - Discovered Voice Widget");
    assert.equal(plan.resources.voiceDidPool.name, "Telnyx Integrations - Discovered Voice Widget");
    assert.match(plan.resources.telnyxVoiceQueueTool.functionName, /^select_genesys_voice_queue_[a-f0-9]{6}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Open Messaging creation immediately patches the integration-scoped webhook URL", async () => {
  const calls = [];
  const result = await ensureWidgetOpenMessagingIntegration({
    conversationsApi: {
      async postConversationsMessagingIntegrationsOpen(body) {
        calls.push({ type: "create", body });
        return { id: "open-1", name: body.name };
      },
      async patchConversationsMessagingIntegrationsOpenIntegrationId(id, body) {
        calls.push({ type: "patch", id, body });
        return { id, ...body };
      },
    },
    integrations: [],
    baseUrl: "https://widgets.example.eu",
    secret: "s".repeat(32),
  });
  assert.equal(result.created, true);
  assert.match(calls[0].body.outboundNotificationWebhookUrl, /\/pending$/);
  assert.equal(
    calls[1].body.outboundNotificationWebhookUrl,
    "https://widgets.example.eu/api/webhooks/genesys/open-messaging/open-1"
  );
});

test("Open Messaging typing profile enables inbound and outbound events", async () => {
  const calls = [];
  const setting = await ensureWidgetTypingMessagingSetting({
    conversationsApi: {
      async getConversationsMessagingSettings() {
        return {
          entities: [{
            id: "setting-1",
            name: "Telnyx Integrations",
            event: { typing: { on: { inbound: "Disabled", outbound: "Disabled" } } },
          }],
        };
      },
      async patchConversationsMessagingSetting(id, body) {
        calls.push({ id, body });
        return { id, ...body };
      },
    },
  });
  assert.equal(setting.id, "setting-1");
  assert.deepEqual(setting.event.typing.on, { inbound: "Enabled", outbound: "Enabled" });
  assert.deepEqual(calls[0], {
    id: "setting-1",
    body: {
      name: "Telnyx Integrations",
      event: { typing: { on: { inbound: "Enabled", outbound: "Enabled" } } },
    },
  });
});

test("Open Messaging installer refreshes the asynchronous inbound recipient", async () => {
  let reads = 0;
  const calls = [];
  const result = await ensureWidgetOpenMessagingIntegration({
    conversationsApi: {
      async postConversationsMessagingIntegrationsOpen(body) {
        return { id: "open-async", name: body.name, createStatus: "Pending" };
      },
      async patchConversationsMessagingIntegrationsOpenIntegrationId(id, body) {
        calls.push("patch");
        return { id, ...body, createStatus: "Pending" };
      },
      async getConversationsMessagingIntegrationsOpenIntegrationId(id) {
        reads += 1;
        calls.push("get");
        return {
          id,
          name: "Telnyx AI Widget Messaging",
          createStatus: "Complete",
          recipient: { id: "recipient-1" },
        };
      },
    },
    integrations: [],
    baseUrl: "https://widgets.example.eu",
    secret: "s".repeat(32),
  });
  assert.equal(reads, 1);
  assert.deepEqual(calls, ["get", "patch"]);
  assert.equal(result.integration.recipient.id, "recipient-1");
});

test("global public URL synchronization invokes every managed resource reconciler", async () => {
  const calls = [];
  const result = await synchronizeAllManagedDeploymentUrls({
    baseUrl: "https://widgets.example.eu",
    async syncAudio(options) {
      calls.push(["audio", options.baseUrl]);
      return [{ deploymentId: "audio-1" }];
    },
    async syncWidget(options) {
      calls.push(["widget", options.baseUrl]);
      return [{ deploymentId: "widget-1" }];
    },
    async syncInsights(options) {
      calls.push(["insights", options.baseUrl]);
      return [{ id: "insight-group-1" }];
    },
  });
  assert.deepEqual(calls, [
    ["audio", "https://widgets.example.eu"],
    ["widget", "https://widgets.example.eu"],
    ["insights", "https://widgets.example.eu"],
  ]);
  assert.equal(result.total, 3);
});

test("public URL is saved only after all managed resource updates succeed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-public-origin-"));
  const envFile = path.join(directory, ".env");
  const environment = { GC_PUBLIC_BASE_URL: "https://old.example.eu" };
  await writeFile(envFile, "GC_PUBLIC_BASE_URL=https://old.example.eu\n");
  try {
    await assert.rejects(
      updateManagedPublicOrigin({
        baseUrl: "https://new.example.eu",
        previousBaseUrl: environment.GC_PUBLIC_BASE_URL,
        environment,
        envFile,
        stateDirectory: path.join(directory, "state"),
        syncAudio: async () => [],
        syncWidget: async () => { throw new Error("widget update failed"); },
        syncInsights: async () => [],
      }),
      /widget update failed/
    );
    assert.equal(environment.GC_PUBLIC_BASE_URL, "https://old.example.eu");
    assert.match(await readFile(envFile, "utf8"), /https:\/\/old\.example\.eu/);

    await updateManagedPublicOrigin({
      baseUrl: "https://new.example.eu",
      previousBaseUrl: environment.GC_PUBLIC_BASE_URL,
      environment,
      envFile,
      stateDirectory: path.join(directory, "state"),
      syncAudio: async () => [],
      syncWidget: async () => [],
      syncInsights: async () => [],
    });
    assert.equal(environment.GC_PUBLIC_BASE_URL, "https://new.example.eu");
    assert.match(await readFile(envFile, "utf8"), /https:\/\/new\.example\.eu/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy Audio tunnel state migrates to the shared state directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "genesys-tunnel-migration-"));
  const legacyRoot = path.join(directory, ".genesys-audio", "tunnel");
  const sharedRoot = path.join(directory, ".genesys-shared", "tunnel");
  const legacy = quickTunnelPaths(legacyRoot);
  await writeFile(path.join(directory, "placeholder"), "");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(legacy.root, { recursive: true }));
  await writeFile(legacy.state, JSON.stringify({
    schemaVersion: 1,
    mode: "quick-tunnel-demo",
    publicBaseUrl: "https://legacy.trycloudflare.com",
    cloudflaredPid: 123,
  }));
  try {
    const result = await migrateLegacyQuickTunnelState({
      sharedStateRoot: sharedRoot,
      legacyStateRoot: legacyRoot,
    });
    assert.equal(result.migrated, true);
    const migrated = JSON.parse(await readFile(quickTunnelPaths(sharedRoot).state, "utf8"));
    assert.equal(migrated.publicBaseUrl, "https://legacy.trycloudflare.com");
    assert.equal(migrated.migratedFrom, path.resolve(legacyRoot));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a TLS trunk publishes a SIP URI that asks Telnyx for SRTP media", async () => {
  const { buildGenesysSipUri, genesysTrunkTransport, genesysTrunkRequiresSecureMedia } =
    await import("../lib/genesys/sip-destination.mjs");
  const { genesysVoiceQueueToolDefinition } = await import("../lib/genesys/sip-transfer-tool.mjs");

  const target = { did: "+11009999002", fqdn: "telnyx.byoc.usw2.pure.cloud" };
  // The transfer tool's own media_encryption field is stored but never applied,
  // so the URI parameter is the only way to reach a TLS trunk's SRTP media.
  assert.equal(
    buildGenesysSipUri({ ...target, transport: "tls" }),
    "sip:+11009999002@telnyx.byoc.usw2.pure.cloud;secure=srtp"
  );
  for (const transport of ["udp", "tcp", "", undefined]) {
    assert.equal(
      buildGenesysSipUri({ ...target, transport }),
      "sip:+11009999002@telnyx.byoc.usw2.pure.cloud",
      String(transport)
    );
  }
  assert.equal(genesysTrunkTransport({ transport: "TLS" }), "tls");
  assert.equal(genesysTrunkTransport({ transport: "nonsense" }), "");
  assert.equal(genesysTrunkRequiresSecureMedia({ transport: "tls" }), true);
  assert.equal(genesysTrunkRequiresSecureMedia({ transport: "udp" }), false);

  // The same URI is what the assistant is told to put in genesys_handoff_sip_uri,
  // which the transfer target resolves from.
  const queueTool = genesysVoiceQueueToolDefinition({
    displayName: "q",
    functionName: "select_q",
    queues: [{ id: "a", name: "Sales" }],
    sipUri: buildGenesysSipUri({ ...target, transport: "tls" }),
  });
  const variable = queueTool.update_dynamic_variables.updatable_variables
    .find(({ name }) => name === "genesys_handoff_sip_uri");
  assert.match(variable.description, /;secure=srtp$/);
});

test("the Genesys SIP transfer leg carries no transport override by default", async () => {
  const { genesysSipTransferToolDefinition } = await import("../lib/genesys/sip-transfer-tool.mjs");

  const definition = genesysSipTransferToolDefinition({
    displayName: "Genesys SIP Transfer",
    from: "+48123123050",
    to: "sip:+11009999002@telnyx.byoc.usw2.pure.cloud",
    targetName: "Genesys Cloud",
  });
  // Telnyx stores sip_transport_protocol and media_encryption on the assistant
  // transfer tool but does not apply them to the INVITE: a tool carrying TLS/SRTP
  // still produced a plain leg and a TLS BYOC trunk answered SIP 488. Emitting
  // them would misdescribe the leg and would break a working unencrypted trunk if
  // Telnyx ever started honoring them.
  assert.equal(definition.transfer.sip_transport_protocol, undefined);
  assert.equal(definition.transfer.media_encryption, undefined);
  assert.deepEqual(Object.keys(definition.transfer), ["from", "targets", "custom_headers"]);
  assert.ok(definition.transfer.custom_headers.some(({ name }) => name === "X-TGX-Queue-Name"));

  // Still reachable for a deployment whose trunk requires an encrypted leg.
  const encrypted = genesysSipTransferToolDefinition({
    displayName: "Genesys SIP Transfer",
    from: "+48123123050",
    to: "sip:+11009999002@telnyx.byoc.usw2.pure.cloud",
    targetName: "Genesys Cloud",
    sipTransportProtocol: "TLS",
    mediaEncryption: "SRTP",
  });
  assert.equal(encrypted.transfer.sip_transport_protocol, "TLS");
  assert.equal(encrypted.transfer.media_encryption, "SRTP");
});
