import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  enrichGenesysWidgetVoiceEvent,
  listGenesysWidgetVoiceQueueIds,
  normalizeGenesysWidgetVoiceEvent,
  recordGenesysWidgetVoiceEvent,
} from "../lib/genesys/widget-voice-notifications.mjs";
import { telnyxCallControlId } from "../lib/widgets/voice-call.js";
import { handoffTimelinePhases } from "../lib/widgets/handoff-timeline.js";

const sessionId = "5d38d01c-981c-4c60-820d-cb7aeec17a49";
const telnyxCallId = "v3:widget-call-control-id";
const conversationId = "bb377db7-839c-4f44-9e20-469af9040118";

function notification(agent = null) {
  return {
    topicName: "v2.routing.queues.queue-support.conversations.calls",
    eventBody: {
      id: conversationId,
      participants: [
        {
          id: "customer-1",
          purpose: "customer",
          attributes: {
            telnyx_widget_session_id: sessionId,
            telnyx_call_control_id: telnyxCallId,
            telnyx_ai_queue_id: "queue-support",
            telnyx_ai_queue_name: "Support",
          },
          calls: [{ state: "connected" }],
        },
        ...(agent ? [agent] : []),
      ],
    },
  };
}

test("Genesys queue call events map waiting, assigned, connected and disconnected phases", () => {
  assert.deepEqual(normalizeGenesysWidgetVoiceEvent(notification()), {
    sessionId,
    telnyxCallId,
    status: "waiting",
    genesysConversationId: conversationId,
    queueId: "queue-support",
    queueName: "Support",
    agentName: null,
    agentUserId: null,
  });

  const assigned = normalizeGenesysWidgetVoiceEvent(notification({
    id: "agent-participant-1",
    purpose: "agent",
    userId: "agent-user-1",
    name: "Anna Kowalska",
    calls: [{ state: "alerting" }],
  }));
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.agentName, "Anna Kowalska");
  assert.equal(assigned.agentUserId, "agent-user-1");

  const connected = normalizeGenesysWidgetVoiceEvent(notification({
    id: "agent-participant-1",
    purpose: "agent",
    userId: "agent-user-1",
    name: "Anna Kowalska",
    calls: [{ state: "connected" }],
  }));
  assert.equal(connected.status, "connected");

  const disconnected = normalizeGenesysWidgetVoiceEvent(notification({
    id: "agent-participant-1",
    purpose: "agent",
    userId: "agent-user-1",
    name: "Anna Kowalska",
    endTime: "2026-08-24T16:00:00.000Z",
    calls: [{ state: "disconnected" }],
  }));
  // A rejected agent offer must not end a customer who is still queued.
  assert.equal(disconnected.status, "waiting");

  const disconnectedEvent = notification({
    id: "agent-participant-1",
    purpose: "agent",
    userId: "agent-user-1",
    name: "Anna Kowalska",
    endTime: "2026-08-24T16:00:00.000Z",
    calls: [{ state: "disconnected" }],
  });
  disconnectedEvent.eventBody.participants[0].endTime = "2026-08-24T16:00:00.000Z";
  disconnectedEvent.eventBody.participants[0].calls = [{ state: "disconnected" }];
  const customerDisconnected = normalizeGenesysWidgetVoiceEvent(disconnectedEvent);
  assert.equal(customerDisconnected.status, "disconnected");
});

test("a customer ending a queued call does not invent an agent lifecycle", () => {
  assert.deepEqual(handoffTimelinePhases({
    status: "disconnected",
    agentAssigned: false,
    agentConnected: false,
  }), {
    ended: true,
    assigned: false,
    connected: false,
    disconnected: false,
    failed: false,
  });
  assert.deepEqual(handoffTimelinePhases({
    status: "disconnected",
    agentAssigned: true,
    agentConnected: true,
  }), {
    ended: true,
    assigned: true,
    connected: true,
    disconnected: true,
    failed: false,
  });
});

test("real Genesys queue notification shape maps nested user, queue and participant state", () => {
  const realPayload = notification();
  const customer = realPayload.eventBody.participants[0];
  customer.state = "connected";
  delete customer.calls;
  delete customer.attributes.telnyx_ai_queue_id;
  delete customer.attributes.telnyx_ai_queue_name;

  realPayload.eventBody.participants.push({
    id: "acd-participant-1",
    purpose: "acd",
    state: "connected",
    queue: { id: "queue-support", name: "Support" },
    attributes: {},
  }, {
    id: "agent-participant-1",
    purpose: "agent",
    state: "alerting",
    initialState: "alerting",
    user: { id: "agent-user-1", name: "Anna Kowalska" },
    queue: { id: "queue-support", name: "Support" },
    attributes: {},
  });

  const assigned = normalizeGenesysWidgetVoiceEvent(realPayload);
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.agentUserId, "agent-user-1");
  assert.equal(assigned.agentName, "Anna Kowalska");
  assert.equal(assigned.queueId, "queue-support");
  assert.equal(assigned.queueName, "Support");

  const agent = realPayload.eventBody.participants.at(-1);
  agent.state = "connected";
  agent.connectedTime = "2026-08-24T16:00:05.000Z";
  assert.equal(normalizeGenesysWidgetVoiceEvent(realPayload).status, "connected");

  agent.state = "terminated";
  agent.endTime = "2026-08-24T16:00:10.000Z";
  delete agent.connectedTime;
  assert.equal(normalizeGenesysWidgetVoiceEvent(realPayload).status, "waiting");

  customer.state = "terminated";
  customer.endTime = "2026-08-24T16:00:12.000Z";
  const ended = normalizeGenesysWidgetVoiceEvent(realPayload);
  assert.equal(ended.status, "disconnected");
  assert.equal(ended.agentName, "Anna Kowalska");
});

test("voice notifications resolve and cache an agent name omitted by the queue topic", async () => {
  const event = notification({
    id: "agent-participant-without-name",
    purpose: "agent",
    state: "alerting",
    user: { id: "agent-user-without-name" },
    queue: { id: "queue-support", name: "Support" },
    attributes: {},
  });
  const normalized = normalizeGenesysWidgetVoiceEvent(event);
  assert.equal(normalized.agentName, null);
  assert.equal(normalized.agentUserId, "agent-user-without-name");

  let lookups = 0;
  const usersApi = {
    async getUser(userId) {
      lookups += 1;
      assert.equal(userId, "agent-user-without-name");
      return { id: userId, name: "Alex Rivera" };
    },
  };
  const assigned = await enrichGenesysWidgetVoiceEvent(normalized, { usersApi });
  const connected = await enrichGenesysWidgetVoiceEvent({
    ...normalized,
    status: "connected",
  }, { usersApi });

  assert.equal(assigned.agentName, "Alex Rivera");
  assert.equal(connected.agentName, "Alex Rivera");
  assert.equal(lookups, 1);
});

test("voice notification correlation fails closed without a Telnyx call identifier", () => {
  const missing = notification();
  delete missing.eventBody.participants[0].attributes.telnyx_widget_session_id;
  delete missing.eventBody.participants[0].attributes.telnyx_call_control_id;
  assert.equal(normalizeGenesysWidgetVoiceEvent(missing), null);
  assert.equal(normalizeGenesysWidgetVoiceEvent({
    topicName: "v2.routing.queues.queue-support.conversations.messages",
    eventBody: missing.eventBody,
  }), null);
});

test("voice events persist only the handoff marker and preserve event-derived identifiers", async () => {
  const queries = [];
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return {
        rows: [{
          id: parameters[0],
          session_id: sessionId,
          channel: "voice",
          status: parameters[1],
          genesys_conversation_id: parameters[2],
          queue_id: parameters[3],
          queue_name: parameters[4],
          agent_name: parameters[5],
          agent_user_id: parameters[6],
        }],
      };
    },
  };
  const event = notification({
    id: "agent-participant-1",
    purpose: "agent",
    userId: "agent-user-1",
    calls: [{ state: "connected" }],
  });
  const handoff = await recordGenesysWidgetVoiceEvent(event, {
    pool,
    usersApi: {
      async getUser(userId) {
        return { id: userId, name: "Anna Kowalska" };
      },
    },
  });
  assert.equal(handoff.status, "connected");
  assert.equal(handoff.session_id, sessionId);
  assert.equal(handoff.genesys_conversation_id, conversationId);
  assert.match(queries[0].sql, /ON CONFLICT \(session_id\) DO UPDATE/);
  assert.match(queries[0].sql, /status IN \('active','completed'\)/);
  assert.equal(queries[0].parameters[7], sessionId);
  assert.equal(queries[0].parameters[8], telnyxCallId);
  assert.equal(queries[0].parameters[5], "Anna Kowalska");
  assert.equal(queries[0].parameters[6], "agent-user-1");
  assert.match(queries[0].sql, /s\.telnyx_call_id=\$9/);
  assert.doesNotMatch(JSON.stringify(queries), /transcript|summary|recording/);
});

test("voice notification correlation falls back to the call-control ID for PSTN calls", () => {
  const pstn = notification();
  delete pstn.eventBody.participants[0].attributes.telnyx_widget_session_id;
  assert.deepEqual(normalizeGenesysWidgetVoiceEvent(pstn), {
    sessionId: null,
    telnyxCallId,
    status: "waiting",
    genesysConversationId: conversationId,
    queueId: "queue-support",
    queueName: "Support",
    agentName: null,
    agentUserId: null,
  });
});

test("voice notification subscriptions include central and published widget queues", async () => {
  let sql = "";
  const queueIds = await listGenesysWidgetVoiceQueueIds({
    pool: {
      async query(value) {
        sql = value;
        return { rows: [{ queue_id: "queue-support" }, { queue_id: "queue-sales" }] };
      },
    },
  });
  assert.deepEqual(queueIds, ["queue-support", "queue-sales"]);
  assert.match(sql, /p\.context='web_voice'/);
  assert.match(sql, /JOIN integration_configuration_aggregates a ON a\.id=p\.aggregate_id/);
  assert.match(sql, /a\.enabled=TRUE/);
  assert.doesNotMatch(sql, /p\.enabled/);
  assert.match(sql, /channels,messaging,genesys,queues/);
});

test("WebRTC correlation uses the Telnyx call-control ID instead of the SDK call UUID", () => {
  const sdkCallId = "e1f7bfef-fe94-4609-b7ec-7dd9604f096f";
  const callControlId = "v3:0OECBVxnVNksxZxN0nuZQhkLPaVP2chujLXKtDJU3VoqdpphtBN27w";
  assert.equal(telnyxCallControlId({
    id: sdkCallId,
    telnyxIDs: { telnyxCallControlId: callControlId },
  }), callControlId);
  assert.equal(telnyxCallControlId({
    id: sdkCallId,
    options: { telnyxCallControlId: callControlId },
  }), callControlId);
  assert.equal(telnyxCallControlId({ id: sdkCallId }), null);
});

test("the server subscribes to Genesys calls and the WebRTC widget renders the shared timeline", async () => {
  const [monitor, server, runtime, timeline, route, flow, transfer] = await Promise.all([
    readFile(new URL("../lib/genesys/widget-voice-notifications.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/widget/VoiceWidgetRuntime.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/widget/HandoffTimeline.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/voice-state/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/widget-voice-flow.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/sip-transfer-tool.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(monitor, /v2\.routing\.queues\.\$\{queueId\}\.conversations\.calls/);
  assert.match(monitor, /postNotificationsChannelSubscriptions/);
  assert.match(monitor, /new WebSocket\(channel\.connectUri\)/);
  assert.doesNotMatch(monitor, /MessagingHandoff|OpenMessaging|open-messaging/);
  assert.match(server, /startGenesysWidgetVoiceNotifications/);
  assert.match(server, /stopGenesysWidgetVoiceNotifications/);
  assert.match(runtime, /fetch\("\/api\/widget-sessions\/voice-state"/);
  assert.match(runtime, /<HandoffTimeline config=\{config\} handoff=\{handoff\} ui=\{ui\}/);
  assert.match(timeline, /handoffWaitingMessage/);
  assert.match(timeline, /handoffAssignedMessage/);
  assert.match(timeline, /handoffConnectedMessage/);
  assert.match(route, /export async function GET\(request\)/);
  assert.match(flow, /telnyx_call_control_id/);
  assert.match(flow, /telnyx_widget_session_id/);
  assert.match(transfer, /X-TGX-Call-Control-Id/);
  assert.match(transfer, /X-TGX-Widget-Session-Id/);
  assert.match(runtime, /telnyxCallControlId\(notification\.call\)/);
});
