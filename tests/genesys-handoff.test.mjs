import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GENESYS_HANDOFF_CHANNELS,
  TELNYX_HANDOFF_MECHANISMS,
  genesysHandoffChannelForTelnyx,
  normalizeGenesysHandoffRequest,
  normalizeTelnyxConversationChannel,
  telnyxHandoffMechanism,
} from "../lib/genesys/handoff-request.js";
import {
  assistantToolIds,
  assistantSharedToolIds,
  attachedGenesysHandoffTools,
  mergeGenesysHandoffQueues,
  reconciledAssistantToolIds,
  telnyxToolDisplayName,
  telnyxToolFunctionName,
  universalGenesysHandoffToolDefinition,
} from "../lib/genesys/handoff-tool-definition.mjs";
import {
  GENESYS_HANDOFF_SIP_URI_TEMPLATE,
  genesysSipTransferToolDefinition,
  genesysVoiceQueueToolDefinition,
  isTransferToolForDestination,
} from "../lib/genesys/sip-transfer-tool.mjs";
import {
  genesysUniversalHandoffInstructions,
  genesysAudioRuntimeContextInstructions,
  removeGenesysAudioRuntimeContextInstructions,
  upsertGenesysUniversalHandoffInstructions,
} from "../lib/genesys/handoff-assistant-instructions.mjs";
import { normalizeAudioConnectorHandoffRequest } from "../lib/genesys/audio-connector-handler.js";
import {
  authorizeGenesysHandoffRequest,
  configuredGenesysHandoffTokens,
} from "../lib/genesys/handoff-auth.js";

const root = new URL("../", import.meta.url);

test("Telnyx conversation channels map to the correct Genesys handoff transport", () => {
  for (const channel of ["phone_call", "web_call", "websocket_call"]) {
    assert.equal(genesysHandoffChannelForTelnyx(channel), GENESYS_HANDOFF_CHANNELS.VOICE);
  }
  assert.equal(
    telnyxHandoffMechanism("websocket_call"),
    TELNYX_HANDOFF_MECHANISMS.AUDIO_CONNECTOR
  );
  for (const channel of ["phone_call", "web_call"]) {
    assert.equal(telnyxHandoffMechanism(channel), TELNYX_HANDOFF_MECHANISMS.SIP_TRANSFER);
  }
  for (const channel of ["sms_chat", "web_chat", "sms"]) {
    assert.equal(genesysHandoffChannelForTelnyx(channel), GENESYS_HANDOFF_CHANNELS.MESSAGING);
    assert.equal(telnyxHandoffMechanism(channel), TELNYX_HANDOFF_MECHANISMS.OPEN_MESSAGING);
  }
  assert.equal(normalizeTelnyxConversationChannel(" WEB_CHAT "), "web_chat");
  assert.equal(genesysHandoffChannelForTelnyx("voice"), null);
  assert.equal(genesysHandoffChannelForTelnyx("email"), null);
});

test("shared and legacy handoff secrets are accepted during migration", () => {
  const environment = {
    GENESYS_HANDOFF_API_KEY: "s".repeat(32),
    GC_AUDIO_HANDOFF_API_KEY: "a".repeat(32),
    WIDGET_HANDOFF_API_KEY: "w".repeat(32),
  };
  assert.deepEqual(configuredGenesysHandoffTokens(environment), [
    "s".repeat(32),
    "a".repeat(32),
    "w".repeat(32),
  ]);
  for (const token of configuredGenesysHandoffTokens(environment)) {
    const request = new Request("https://example.test/api/genesys/handoff", {
      headers: { "telnyx-ai-api-key": token },
    });
    assert.deepEqual(authorizeGenesysHandoffRequest(request, environment), { ok: true });
  }
});

test("universal handoff requests retain Telnyx channel semantics", () => {
  const common = {
    queue_name: "Support",
    reason: "Customer requested a person",
    summary: "Customer needs account support",
    intent: "account_support",
    sentiment: "mixed",
  };
  assert.equal(
    normalizeGenesysHandoffRequest({
      ...common,
      telnyx_conversation_channel: "web_chat",
    }).channel,
    GENESYS_HANDOFF_CHANNELS.MESSAGING
  );
  assert.equal(
    normalizeGenesysHandoffRequest({
      ...common,
      telnyx_conversation_channel: "websocket_call",
    }).channel,
    GENESYS_HANDOFF_CHANNELS.VOICE
  );
});

test("Audio handoff falls back to the configured default queue", () => {
  const options = {
    defaultChannel: "voice",
    defaultQueueName: "Support",
    allowedQueueNames: ["Sales", "Support"],
  };
  const common = {
    reason: "Escalation",
    summary: "Customer needs a human",
    intent: "support",
    sentiment: "neutral",
  };
  assert.deepEqual(
    normalizeGenesysHandoffRequest(common, options),
    {
      channel: "voice",
      queueName: "Support",
      queueFallbackReason: "missing",
      ...common,
    }
  );
  const outside = normalizeGenesysHandoffRequest({ ...common, queue_name: "Billing" }, options);
  assert.equal(outside.queueName, "Support");
  assert.equal(outside.queueFallbackReason, "outside_allowlist");
});

test("Audio Connector transport overrides a model-supplied messaging channel", () => {
  const handoff = normalizeAudioConnectorHandoffRequest({
    telnyx_conversation_channel: "web_chat",
    queue_name: "Support",
    reason: "Escalation",
    summary: "Needs a human",
    intent: "support",
    sentiment: "neutral",
  });
  assert.equal(handoff.channel, GENESYS_HANDOFF_CHANNELS.VOICE);
});

test("universal Telnyx tool copies the resolved channel and uses one handoff route", () => {
  const tool = universalGenesysHandoffToolDefinition({
    baseUrl: "https://integrations.example.eu",
    integrationSecretIdentifier: "handoff-secret",
    displayName: "Genesys Handoff",
    targetName: "Example (A1B2C3)",
    queues: [{ id: "queue-1", name: "Support" }],
  });
  assert.equal(tool.webhook.url, "https://integrations.example.eu/api/genesys/handoff");
  assert.equal(tool.webhook.name, "request_genesys_human_handoff_a1b2c3");
  assert.equal(tool.webhook.body_parameters.properties.telnyx_conversation_channel.type, "string");
  assert.equal(tool.webhook.body_parameters.properties.telnyx_conversation_channel.enum, undefined);
  assert.match(
    tool.webhook.body_parameters.properties.telnyx_conversation_channel.description,
    /Copy the exact resolved value/
  );
  assert.match(tool.webhook.description, /Never use this webhook for phone_call or web_call/);
});

test("Genesys SIP Transfer tool is a separate Telnyx tool for phone_call", () => {
  const tool = genesysSipTransferToolDefinition({
    displayName: "Widget - Genesys SIP Transfer",
    from: "{{telnyx_end_user_target}}",
    to: "sip:widget@eu.example.pure.cloud",
    targetName: "Genesys Cloud",
  });
  assert.deepEqual(tool, {
    display_name: "Widget - Genesys SIP Transfer",
    type: "transfer",
    transfer: {
      from: "{{telnyx_end_user_target}}",
      targets: [{ name: "Genesys Cloud", to: "sip:widget@eu.example.pure.cloud" }],
      custom_headers: [
        { name: "X-TGX-Queue-Name", value: "{{genesys_queue_name}}" },
        { name: "X-TGX-Call-Control-Id", value: "{{call_control_id}}" },
        { name: "X-TGX-Widget-Session-Id", value: "{{widget_session_id}}" },
        { name: "X-TGX-Handoff-Reason", value: "{{genesys_handoff_reason}}" },
        { name: "X-TGX-Summary", value: "{{genesys_handoff_summary}}" },
        { name: "X-TGX-Intent", value: "{{genesys_handoff_intent}}" },
        { name: "X-TGX-Sentiment", value: "{{genesys_handoff_sentiment}}" },
      ],
    },
  });
  assert.equal(isTransferToolForDestination(tool, "sip:widget@eu.example.pure.cloud"), true);
});

test("WebRTC voice tools set a deployment SIP URI before transferring through a dynamic target", () => {
  const queueTool = genesysVoiceQueueToolDefinition({
    displayName: "select_genesys_voice_queue_a1b2c3",
    functionName: "select_genesys_voice_queue_a1b2c3",
    queues: [{ id: "queue-1", name: "Support" }, { id: "queue-2", name: "Sales" }],
    sipUri: "sip:+11009999000@telnyx.byoc.usw2.pure.cloud;secure=srtp",
  });
  assert.equal(queueTool.type, "update_dynamic_variables");
  assert.equal(
    queueTool.update_dynamic_variables.updatable_variables.at(-1).name,
    "genesys_handoff_sip_uri"
  );
  assert.equal(
    queueTool.update_dynamic_variables.updatable_variables.at(-1).description,
    "Use sip:+11009999000@telnyx.byoc.usw2.pure.cloud;secure=srtp"
  );
  const transferTool = genesysSipTransferToolDefinition({
    displayName: "Widget - Genesys SIP Transfer",
    from: "{{telnyx_end_user_target}}",
    to: "sip:+11009999000@telnyx.byoc.usw2.pure.cloud;secure=srtp",
    targetName: "Genesys Cloud - BYOC",
    dynamicDestination: true,
  });
  assert.equal(transferTool.transfer.targets[0].to, GENESYS_HANDOFF_SIP_URI_TEMPLATE);
});

test("assistant instructions never route phone_call to the Audio Connector webhook", () => {
  const instructions = genesysUniversalHandoffInstructions({
    queues: [{ id: "queue-1", name: "Support" }],
    handoffToolName: "request_genesys_human_handoff_a1b2c3",
    transferToolName: "Widget - Genesys SIP Transfer",
    voiceQueueToolName: "Widget - Select Genesys Voice Queue",
  });
  assert.match(instructions, /For websocket_call, call the webhook tool/);
  assert.match(instructions, /For phone_call or web_call, first call Widget - Select Genesys Voice Queue exactly once/);
  assert.match(instructions, /then call the Telnyx Transfer tool/);
  assert.match(instructions, /X-TGX-Call-Control-Id/);
  assert.match(instructions, /genesys_handoff_summary/);
  assert.match(instructions, /never call the handoff webhook for these transports/i);
  assert.match(instructions, /from=\{\{telnyx_end_user_target\}\}/);
  assert.match(instructions, /WebRTC calls made by the Telnyx AI Agent Library/);
  assert.match(instructions, /authoritative and immutable/);
  assert.match(instructions, /Never translate it to voice, voice_call/);
  assert.match(instructions, /If the value is empty or anything else, do not call any handoff or transfer tool/);
  assert.match(instructions, /genesys_handoff_sip_uri/);
});

test("upserting universal handoff removes the managed legacy Audio Connector handoff section", () => {
  const legacy = `## Role
Keep helping the customer.

Telnyx sets \`telnyx_conversation_channel\` to \`websocket_call\` for this Audio Connector path; treat that value as a voice call.

## Human handoff
This assistant runs in a Genesys Audio Connector voice session. For every handoff set channel to voice.

When a handoff is required, call request_genesys_human_handoff_a1b2c3.

<!-- genesys-universal-handoff:start -->
old managed block
<!-- genesys-universal-handoff:end -->`;
  const instructions = upsertGenesysUniversalHandoffInstructions(legacy, {
    queues: [{ id: "queue-1", name: "Sales" }],
    handoffToolName: "request_genesys_human_handoff_a1b2c3",
    transferToolName: "Genesys SIP Transfer",
    voiceQueueToolName: "select_genesys_voice_queue",
  });

  assert.doesNotMatch(instructions, /This assistant runs in a Genesys Audio Connector voice session/);
  assert.doesNotMatch(instructions, /For every handoff set channel to voice/);
  assert.doesNotMatch(instructions, /old managed block/);
  assert.match(instructions, /Telnyx sets `telnyx_conversation_channel` for every conversation/);
  assert.equal((instructions.match(/genesys-universal-handoff:start/g) || []).length, 1);
  assert.match(instructions, /For phone_call or web_call, first call select_genesys_voice_queue/);
});

test("detaching the last Genesys handoff removes its managed Audio runtime context", () => {
  const custom = "Keep this custom assistant role.";
  const instructions = `${custom}\n\n${genesysAudioRuntimeContextInstructions()}`;
  assert.equal(removeGenesysAudioRuntimeContextInstructions(instructions), custom);
});

test("assistant tool reconciliation preserves shared tools without promoting inline tools", async () => {
  const assistant = {
    tools: [
      {
        id: "handoff-old-1",
        shared: true,
        tool_definition: { webhook: { name: "request_genesys_human_handoff_a1b2c3" } },
      },
      {
        id: "handoff-old-2",
        shared: false,
        tool_definition: { webhook: { name: "request_genesys_human_handoff_d4e5f6" } },
      },
      { id: "hangup-1", shared: true, tool_definition: { type: "hangup" } },
      { id: "crm-inline-1", shared: false, tool_definition: { webhook: { name: "lookup_customer" } } },
      { id: "crm-shared-1", shared: true, tool_definition: { webhook: { name: "lookup_account" } } },
    ],
  };
  const handoffTools = await attachedGenesysHandoffTools(
    { ai: { tools: { retrieve: async () => { throw new Error("unexpected retrieve"); } } } },
    assistant
  );
  assert.deepEqual(assistantToolIds(assistant), [
    "handoff-old-1",
    "handoff-old-2",
    "hangup-1",
    "crm-inline-1",
    "crm-shared-1",
  ]);
  assert.deepEqual(assistantSharedToolIds(assistant), [
    "handoff-old-1",
    "hangup-1",
    "crm-shared-1",
  ]);
  assert.deepEqual(
    reconciledAssistantToolIds({
      assistant,
      attachedHandoffTools: handoffTools,
      handoffToolId: "handoff-old-1",
    }),
    ["handoff-old-1", "hangup-1", "crm-shared-1"]
  );
});

test("shared Telnyx webhook tools retrieved by ID normalize the flat SDK shape", () => {
  const tool = {
    id: "tool-1",
    type: "webhook",
    display_name: "Genesys Audio Handoff",
    tool_definition: {
      name: "request_genesys_human_handoff_c742fe",
      body_parameters: {
        properties: {
          queue_name: { enum: ["Generic", "Support"] },
          queue_id: { enum: ["queue-generic", "queue-support"] },
        },
      },
    },
  };

  assert.equal(telnyxToolDisplayName(tool), "Genesys Audio Handoff");
  assert.equal(
    telnyxToolFunctionName(tool),
    "request_genesys_human_handoff_c742fe"
  );
  assert.deepEqual(
    mergeGenesysHandoffQueues(tool, [{ id: "queue-sales", name: "Sales" }]),
    [
      { id: "queue-generic", name: "Generic" },
      { id: "queue-support", name: "Support" },
      { id: "queue-sales", name: "Sales" },
    ]
  );
});

test("assistant inline Telnyx tools expose their display name as name", () => {
  assert.equal(telnyxToolDisplayName({
    tool_id: "tool-1",
    type: "webhook",
    name: "Genesys Audio Handoff",
    webhook: { name: "request_genesys_human_handoff_c742fe" },
  }), "Genesys Audio Handoff");
});

test("the public handoff route dispatches messaging while the legacy widget route remains compatible", async () => {
  const publicRoute = await readFile(new URL("lib/genesys/handoff-route.js", root), "utf8");
  const legacyRoute = await readFile(
    new URL("app/api/widgets/handoff/messaging/route.js", root),
    "utf8"
  );
  assert.match(publicRoute, /telnyxHandoffMechanism/);
  assert.match(publicRoute, /GENESYS_SIP_TRANSFER_REQUIRED/);
  assert.match(publicRoute, /processGenesysMessagingHandoff\(body\)/);
  assert.match(legacyRoute, /handleGenesysMessagingHandoffRequest/);
});

test("agent assignment reaches the widget before the agent's first message", async () => {
  const [stateRoute, handoffs, openMessaging, schema] = await Promise.all([
    readFile(new URL("../app/api/widget-sessions/state/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/widgets/handoffs.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/widget-open-messaging.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8"),
  ]);
  // Open Messaging webhooks carry messages only, so participants are read instead.
  assert.match(stateRoute, /refreshHandoffAgentPresence/);
  assert.match(stateRoute, /agent\.state === "connected"/);
  assert.match(stateRoute, /agent\.state === "alerting"/);
  // The lifecycle is on the media session, not the participant itself.
  assert.match(openMessaging, /function participantMessageState\(participant\)/);
  assert.match(openMessaging, /Array\.isArray\(participant\?\.messages\)/);
  assert.match(openMessaging, /state !== "disconnected" && state !== "terminated"/);
  assert.match(handoffs, /export async function markMessagingHandoffAssigned/);
  // Assignment must never move a connected handoff backwards.
  assert.match(handoffs, /status='assigned',[\s\S]*?WHERE id=\$1 AND status IN \('reserved','waiting'\)/);
  assert.match(handoffs, /status IN \('reserved','waiting','assigned','connected'\)/);
  // The Genesys lookup is claimed once per interval, not once per browser poll.
  assert.match(handoffs, /export async function claimHandoffAgentLookup/);
  assert.match(handoffs, /agent_polled_at IS NULL OR agent_polled_at < NOW\(\) - /);
  assert.match(schema, /widget_handoff_agent_presence_polling/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS agent_polled_at TIMESTAMPTZ/);
});

test("an assigned handoff keeps the same customer capabilities as a connected one", async () => {
  const [messages, attachments, handoffRoute, frame] = await Promise.all([
    readFile(new URL("../app/api/widget-sessions/messages/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/attachments/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/widget-messaging-handoff-route.js", import.meta.url), "utf8"),
    readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(messages, /\["reserved", "waiting", "assigned", "connected"\]/);
  assert.match(attachments, /\["waiting", "assigned", "connected"\]/);
  assert.match(handoffRoute, /\["waiting", "assigned", "connected", "completed"\]/);
  assert.match(frame, /\["waiting", "assigned", "connected"\]\.includes\(handoff\?\.status\)/);
});

test("an agent leaving closes the chat session in configuration, runtime and API", async () => {
  const { DEFAULT_WIDGET_CONFIG, parseWidgetConfig } = await import("../lib/widgets/config.js");
  // Widgets published before this event keep parsing and gain the defaults.
  const legacy = structuredClone(DEFAULT_WIDGET_CONFIG);
  delete legacy.components.handoff.disconnected;
  delete legacy.content.handoffDisconnectedMessage;
  const migrated = parseWidgetConfig(legacy);
  assert.equal(migrated.components.handoff.disconnected.enabled, true);
  assert.match(migrated.content.handoffDisconnectedMessage, /\{agent\}/);

  const [frame, timeline, controls, handoffs, stateRoute, messages, attachments, sessions, locales] = await Promise.all([
    readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/widget/HandoffTimeline.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/widget-admin/WidgetStudioControls.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/widgets/handoffs.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/state/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/messages/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/attachments/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widgets/[publicId]/sessions/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/widgets/locales.js", import.meta.url), "utf8"),
  ]);
  assert.match(controls, /label="Show agent disconnected message"/);
  assert.match(controls, /"content", "handoffDisconnectedMessage"/);
  assert.match(stateRoute, /agent\.state === "disconnected"/);
  assert.match(handoffs, /export async function markMessagingHandoffDisconnected/);
  // A disconnect only applies to a live handoff, never to one still queued.
  assert.match(handoffs, /status='disconnected',[\s\S]*?WHERE id=\$1 AND status IN \('assigned','connected'\)/);
  // Presence keeps being polled while connected so the disconnect is noticed.
  assert.match(handoffs, /status IN \('waiting','assigned','connected'\)\s*\n\s*AND genesys_conversation_id IS NOT NULL/);
  assert.match(frame, /const conversationEnded = \["disconnected", "completed"\]\.includes\(handoff\?\.status\)/);
  assert.match(frame, /chatStatus === "ready" && !conversationEnded/);
  assert.match(frame, /!conversationEnded\s*\n\s*&& \["waiting", "assigned", "connected"\]/);
  assert.match(timeline, /key: "disconnected"/);
  // The transfer steps sit at the handoff point; the agent leaving sits at the end.
  assert.match(timeline, /\(phase === "closing"\) === \(event\.key === "disconnected"\)/);
  assert.match(frame, /phase="closing"/);
  // The server refuses new traffic instead of quietly routing it back to the bot.
  assert.match(messages, /\["disconnected", "completed"\]\.includes\(handoff\.status\)/);
  assert.match(attachments, /\["disconnected", "completed"\]\.includes\(handoff\.status\)/);
  // The terminal footer replaces the disabled composer and starts a clean
  // session without requiring the host page to reload.
  assert.match(frame, /ui\.actions\.startNewConversation/);
  assert.match(frame, /onClick=\{startNewConversation\}/);
  assert.match(frame, /window\.localStorage\.removeItem\(sessionStorageKey\)/);
  assert.match(frame, /setRestartCount\(\(current\) => current \+ 1\)/);
  assert.match(locales, /startNewConversation: "Start a new conversation"/);
  assert.match(locales, /startNewConversation: "Rozpocznij nową rozmowę"/);
  // A stale persisted token must not revive a terminal handoff after refresh.
  assert.match(sessions, /getMessagingHandoffBySession\(existing\.id\)/);
  assert.match(sessions, /\["disconnected", "completed"\]\.includes\(existingHandoff\?\.status\)/);
  assert.match(sessions, /matchesRequest && !conversationEnded/);
});

test("the attachment viewer shows a spinner and drops its backdrop when expanded", async () => {
  const frame = await readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8");
  // A partially loaded <img> renders the browser's broken-file placeholder.
  assert.match(frame, /const rendered = Boolean\(displayUrl\) && renderedUrl === displayUrl/);
  assert.match(frame, /motion-safe:animate-spin/);
  assert.match(frame, /onLoad=\{\(\) => setRenderedUrl\(displayUrl\)\}/);
  // Expanded, the frame is already the requested size, so a backdrop would only
  // draw a hard-cornered band around the rounded viewer.
  assert.match(frame, /expanded \? "" : "bg-black\/70 p-3 backdrop-blur-sm"/);
});

test("keeping the assistant on the call swaps SIP transfer for invite plus skip turn", async () => {
  const {
    genesysSipInviteToolDefinition,
    genesysSkipTurnToolDefinition,
    telnyxInviteTargets,
  } = await import("../lib/genesys/sip-transfer-tool.mjs");

  const invite = genesysSipInviteToolDefinition({
    displayName: "Widget · Genesys Invite",
    from: "{{telnyx_end_user_target}}",
    targetName: "Genesys Cloud",
    dynamicDestination: true,
  });
  assert.equal(invite.type, "invite");
  // Invite carries the same identity, destination variable and handoff context as
  // transfer, so a TLS trunk's ;secure=srtp URI reaches it unchanged.
  assert.equal(invite.invite.from, "{{telnyx_end_user_target}}");
  assert.deepEqual(invite.invite.targets, [{ name: "Genesys Cloud", to: "{{genesys_handoff_sip_uri}}" }]);
  assert.deepEqual(
    invite.invite.custom_headers.map(({ name }) => name),
    ["X-TGX-Queue-Name", "X-TGX-Call-Control-Id", "X-TGX-Widget-Session-Id", "X-TGX-Handoff-Reason", "X-TGX-Summary", "X-TGX-Intent", "X-TGX-Sentiment"]
  );
  assert.deepEqual(telnyxInviteTargets({ invite: invite.invite, type: "invite" }), invite.invite.targets);

  // A fixed destination is still accepted and validated.
  const fixed = genesysSipInviteToolDefinition({
    displayName: "x", from: "+48123123050", to: "sip:+1100@a.b.cloud;secure=srtp", targetName: "Genesys Cloud",
  });
  assert.equal(fixed.invite.targets[0].to, "sip:+1100@a.b.cloud;secure=srtp");
  assert.throws(() => genesysSipInviteToolDefinition({
    displayName: "x", from: "+48123123050", to: "not-a-uri", targetName: "Genesys Cloud",
  }), /valid sip: or sips: URI/);

  const skipTurn = genesysSkipTurnToolDefinition({ displayName: "Widget · Skip Turn" });
  assert.equal(skipTurn.type, "skip_turn");
  assert.match(skipTurn.skip_turn.description, /without speaking/i);
});

test("assistant instructions describe inviting and staying silent only in that mode", async () => {
  const { genesysUniversalHandoffInstructions } = await import("../lib/genesys/handoff-assistant-instructions.mjs");
  const shared = { queues: [{ name: "Sales" }], handoffToolName: "handoff", voiceQueueToolName: "select_queue" };

  const invite = genesysUniversalHandoffInstructions({
    ...shared, transferToolName: "Genesys Invite", keepAssistantOnCall: true, skipTurnToolName: "Skip Turn",
  });
  assert.match(invite, /call the Telnyx Invite tool Genesys Invite/);
  assert.match(invite, /Inviting does not end your part of the call/);
  assert.match(invite, /call Skip Turn/);
  assert.match(invite, /never hang up a call an agent has joined/);

  // Transfer stays exactly as before, with no invite wording leaking in.
  const transfer = genesysUniversalHandoffInstructions({ ...shared, transferToolName: "Genesys SIP Transfer" });
  assert.match(transfer, /call the Telnyx Transfer tool Genesys SIP Transfer/);
  assert.doesNotMatch(transfer, /Inviting does not end/);
  assert.doesNotMatch(transfer, /Skip Turn/);
});

test("the Assistant Tools catalog lists the invite-mode tools", async () => {
  const console_ = await readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8");
  // Only logical keys present in GENESYS_TOOL_CATALOG survive genesysToolCatalog(),
  // so a missing entry hides a provisioned tool from the page entirely.
  const catalog = console_.slice(console_.indexOf("const GENESYS_TOOL_CATALOG"), console_.indexOf("const DYNAMIC_VARIABLE_TEMPLATE"));
  for (const logicalKey of ["genesys_human_handoff", "genesys_sip_transfer", "hangup", "genesys_voice_queue_selector", "genesys_sip_invite", "skip_turn"]) {
    assert.match(catalog, new RegExp(`logicalKey: "${logicalKey}"`));
  }
  // Both are provisioned per widget deployment, so unprovisioned rows need templates.
  assert.match(console_, /invite: \{\n\s+type: "invite",/);
  assert.match(console_, /skip_turn: \{\n\s+type: "skip_turn",/);
  assert.match(console_, /invite: "Invite",/);
  assert.match(console_, /skip_turn: "Skip Turn",/);
  // Invite exposes the same caller, targets and SIP headers as transfer.
  assert.match(console_, /if \(type === "transfer" \|\| type === "invite"\) \{/);
  assert.match(console_, /scopeType: spec\.scopeType \|\| "shared"/);
});

test("switching handoff mode detaches the tool the other mode used", async () => {
  const { attachedGenesysCallHandoffTools } = await import("../lib/genesys/sip-transfer-tool.mjs");
  const assistant = {
    tool_ids: ["tool-transfer", "tool-invite", "tool-foreign"],
    tools: [
      { id: "tool-transfer", type: "transfer", transfer: { targets: [{ to: "{{genesys_handoff_sip_uri}}" }] } },
      { id: "tool-invite", type: "invite", invite: { targets: [{ to: "{{genesys_handoff_sip_uri}}" }] } },
      // Someone else's transfer tool, pointing somewhere this integration does not own.
      { id: "tool-foreign", type: "transfer", transfer: { targets: [{ to: "sip:someone@else.example" }] } },
    ],
  };
  const telnyx = { ai: { tools: { retrieve: async () => { throw new Error("should not fetch inline tools"); } } } };

  // With both attached the model picks between transferring and inviting at random.
  assert.deepEqual(await attachedGenesysCallHandoffTools(telnyx, assistant, ["transfer"]), ["tool-transfer"]);
  assert.deepEqual(await attachedGenesysCallHandoffTools(telnyx, assistant, ["invite"]), ["tool-invite"]);
  // An unrelated transfer tool must survive: the assistant may be shared.
  for (const types of [["transfer"], ["invite"]]) {
    assert.ok(!(await attachedGenesysCallHandoffTools(telnyx, assistant, types)).includes("tool-foreign"));
  }

  const installer = await readFile(new URL("../scripts/manage-genesys-widget.mjs", import.meta.url), "utf8");
  assert.match(installer, /assistantSharedToolIds\(currentAssistant\)\.filter\(\(id\) => !obsoleteToolIds\.has\(id\)\)/);
  assert.match(installer, /keepAssistantOnCall \? \["transfer"\] : \["invite"\]/);
  // Leaving invite mode also drops skip turn, which has no destination to match on.
  assert.match(installer, /\[managedOppositeHandoff\?\.remoteToolId, managedSkipTurn\?\.remoteToolId\]/);
  // The tools being attached this run must never end up in the detach set.
  assert.match(installer, /obsoleteToolIds\.delete\(tool\.id\)/);
});

test("invite and skip turn are provisioned as shared tools and chosen per widget", async () => {
  const [installer, audio, runner, keys, console_] = await Promise.all([
    readFile(new URL("../scripts/manage-genesys-widget.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/manage-genesys-audio.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-deployment-runner.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-managed-tools.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(keys, /ADMIN_SHARED_INVITE_TOOL_KEY = "genesys_sip_invite"/);
  assert.match(keys, /ADMIN_SHARED_SKIP_TURN_TOOL_KEY = "skip_turn"/);
  // Created where the installation already creates shared tools, even though an
  // Audio Connector call can never use them.
  assert.match(audio, /async function ensureSharedGenesysCallTools/);
  assert.match(audio, /genesysSipInviteToolDefinition\(\{/);
  assert.match(audio, /genesysSkipTurnToolDefinition\(\{/);
  assert.match(runner, /logicalKey: ADMIN_SHARED_INVITE_TOOL_KEY/);
  assert.match(runner, /logicalKey: ADMIN_SHARED_SKIP_TURN_TOOL_KEY/);
  // Publishing picks one path or the other, never both.
  assert.match(installer, /keepAssistantOnCall\s*\n?\s*\? genesysSipInviteToolDefinition/);
  assert.match(installer, /: genesysSipTransferToolDefinition/);
  assert.match(installer, /keepAssistantOnCall \? ADMIN_SHARED_INVITE_TOOL_KEY : ADMIN_SIP_TRANSFER_TOOL_KEY/);
  assert.match(installer, /\.\.\.\(skipTurnTool \? \[skipTurnTool\.id\] : \[\]\)/);
  assert.match(console_, /label="Keep AI assistant on the call during handoff"/);
});
