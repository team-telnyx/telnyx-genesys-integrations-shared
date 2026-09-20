import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeInsightGroupWebhookEvent,
  recordInsightGroupWebhookEvent,
  resolveConversationIdByCallControlId,
  TELNYX_CALL_INSIGHT_EVENT_TYPE,
  TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE,
  TELNYX_INSIGHT_EVENT_TYPE,
} from "../lib/telnyx/insight-events.mjs";
import {
  normalizeTelnyxPublicKey,
  TelnyxWebhookConfigurationError,
  TelnyxWebhookSignatureError,
  verifyAndParseTelnyxWebhookRequest,
  verifyTelnyxWebhookSignature,
} from "../lib/telnyx/webhooks.mjs";

function signingFixture(body, timestamp = String(Math.floor(Date.now() / 1000))) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const encodedPublicKey = der.subarray(der.length - 32).toString("base64");
  const signature = sign(
    null,
    Buffer.from(`${timestamp}|${body}`),
    privateKey
  ).toString("base64");
  return { publicKey: encodedPublicKey, signature, timestamp };
}

test("Telnyx public keys are canonical 32-byte Ed25519 values", () => {
  const valid = Buffer.alloc(32, 7).toString("base64");
  assert.equal(normalizeTelnyxPublicKey(` ${valid} `), valid);
  assert.throws(
    () => normalizeTelnyxPublicKey(Buffer.alloc(31).toString("base64")),
    TelnyxWebhookConfigurationError
  );
  assert.throws(() => normalizeTelnyxPublicKey("not-base64"), TelnyxWebhookConfigurationError);
});

test("Telnyx webhook verification uses the exact raw body and rejects tampering", async () => {
  const body = JSON.stringify({
    event_type: TELNYX_INSIGHT_EVENT_TYPE,
    conversation_id: "conversation-1",
    insight_group_id: "group-1",
  });
  const fixture = signingFixture(body);
  assert.equal(
    await verifyTelnyxWebhookSignature({ payload: body, ...fixture }),
    true
  );
  await assert.rejects(
    verifyTelnyxWebhookSignature({ payload: `${body} `, ...fixture }),
    TelnyxWebhookSignatureError
  );
  const stale = signingFixture(body, String(Math.floor(Date.now() / 1000) - 301));
  await assert.rejects(
    verifyTelnyxWebhookSignature({ payload: body, ...stale }),
    TelnyxWebhookSignatureError
  );
});

test("verified requests are parsed only after Ed25519 verification", async () => {
  const body = JSON.stringify({
    event_type: TELNYX_INSIGHT_EVENT_TYPE,
    conversation_id: "conversation-2",
    insight_group_id: "group-2",
    insights: [{ insight_name: "Sentiment", result: { score: 8 } }],
  });
  const fixture = signingFixture(body);
  const request = new Request("https://example.test/api/webhooks/telnyx/insights", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": fixture.signature,
      "telnyx-timestamp": fixture.timestamp,
    },
    body,
  });
  const result = await verifyAndParseTelnyxWebhookRequest(request, {
    publicKey: fixture.publicKey,
  });
  assert.equal(result.rawBody, body);
  assert.equal(result.event.conversation_id, "conversation-2");
});

test("insight group events normalize both documented and enveloped payloads", () => {
  const documented = {
    event_type: TELNYX_INSIGHT_EVENT_TYPE,
    conversation_id: "conversation-3",
    insight_group_id: "group-3",
  };
  assert.deepEqual(normalizeInsightGroupWebhookEvent(documented), {
    eventType: TELNYX_INSIGHT_EVENT_TYPE,
    status: null,
    conversationId: "conversation-3",
    callControlId: null,
    insightGroupId: "group-3",
    providerEventId: null,
  });
  assert.equal(normalizeInsightGroupWebhookEvent({ event_type: "other.event" }), null);
  assert.equal(
    normalizeInsightGroupWebhookEvent({ data: { ...documented, id: "event-3" } }).providerEventId,
    "event-3"
  );
});

test("call insight callbacks normalize identifiers from the Telnyx data payload envelope", () => {
  const normalized = normalizeInsightGroupWebhookEvent({
    data: {
      record_type: "event",
      event_type: TELNYX_CALL_INSIGHT_EVENT_TYPE,
      id: "event-call-1",
      payload: {
        call_control_id: "v3:call-control-1",
        insight_group_id: "group-call-1",
        results: [{ insight_id: "insight-1", result: "not persisted" }],
      },
    },
  });
  assert.deepEqual(normalized, {
    eventType: TELNYX_CALL_INSIGHT_EVENT_TYPE,
    status: null,
    conversationId: null,
    callControlId: "v3:call-control-1",
    insightGroupId: "group-call-1",
    providerEventId: "event-call-1",
  });
});

test("conversation insight result webhooks normalize the production payload", () => {
  const normalized = normalizeInsightGroupWebhookEvent({
    record_type: "event",
    event_type: TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE,
    payload: {
      request_id: "request-insight-1",
      conversation_id: "66b541ed-269e-4af8-a50a-7b4101bc5ff3",
      status: "completed",
      insight_group_id: "964de51d-f6d5-49ca-bafe-81d430a7287a",
      results: [{ insight_id: "insight-1", result: "not persisted" }],
    },
  });
  assert.deepEqual(normalized, {
    eventType: TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE,
    status: "completed",
    conversationId: "66b541ed-269e-4af8-a50a-7b4101bc5ff3",
    callControlId: null,
    insightGroupId: "964de51d-f6d5-49ca-bafe-81d430a7287a",
    providerEventId: "request-insight-1",
  });
});

test("conversation insight result webhooks notify only after completion", async () => {
  const queries = [];
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return {
        rows: [{
          event_id: parameters[0],
          conversation_id: parameters[2],
          insight_group_id: parameters[3],
          received_at: new Date("2026-08-24T14:56:47.424Z"),
        }],
      };
    },
  };
  const completedEvent = {
    record_type: "event",
    event_type: TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE,
    payload: {
      request_id: "request-insight-2",
      conversation_id: "66b541ed-269e-4af8-a50a-7b4101bc5ff3",
      status: "completed",
      insight_group_id: "964de51d-f6d5-49ca-bafe-81d430a7287a",
      results: [{ insight_id: "insight-2", result: "must not be stored" }],
    },
  };
  const recorded = await recordInsightGroupWebhookEvent({
    rawBody: JSON.stringify(completedEvent),
    event: completedEvent,
    pool,
    resolveConversationId: async () => {
      throw new Error("conversation lookup should not run");
    },
  });
  assert.equal(recorded.accepted, true);
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.eventId, "request-insight-2");
  assert.equal(recorded.conversationId, "66b541ed-269e-4af8-a50a-7b4101bc5ff3");
  assert.equal(queries[0].parameters[0], "request-insight-2");
  assert.match(queries[0].sql, /pg_notify/);
  assert.doesNotMatch(JSON.stringify(queries), /results|must not be stored/);

  const pendingEvent = {
    ...completedEvent,
    payload: {
      ...completedEvent.payload,
      request_id: "request-insight-3",
      status: "pending",
    },
  };
  const ignored = await recordInsightGroupWebhookEvent({
    rawBody: JSON.stringify(pendingEvent),
    event: pendingEvent,
    pool,
  });
  assert.deepEqual(ignored, {
    accepted: false,
    duplicate: false,
    eventType: TELNYX_CONVERSATION_INSIGHT_RESULT_EVENT_TYPE,
    status: "pending",
    reason: "not_completed",
  });
  assert.equal(queries.length, 1);
});

test("call control IDs resolve to exactly one Telnyx conversation", async () => {
  const expectedConversationId = "36e27aa0-f41a-4b1f-9ccc-c865625120af";
  let request = null;
  const resolved = await resolveConversationIdByCallControlId("v3:call-control-2", {
    apiKey: "test-key",
    attempts: 1,
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return {
        ok: true,
        async json() {
          return {
            data: [{
              id: expectedConversationId,
              metadata: { call_control_id: "v3:call-control-2" },
            }],
          };
        },
      };
    },
  });
  assert.equal(resolved, expectedConversationId);
  assert.equal(request.url.pathname, "/v2/ai/conversations");
  assert.equal(
    request.url.searchParams.get("metadata->call_control_id"),
    "eq.v3:call-control-2"
  );
  assert.equal(request.url.searchParams.get("limit"), "2");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
});

test("call insight callbacks resolve a conversation before persisting and notifying", async () => {
  const queries = [];
  const resolvedConversationId = "36e27aa0-f41a-4b1f-9ccc-c865625120af";
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return {
        rows: [{
          event_id: parameters[0],
          conversation_id: parameters[2],
          insight_group_id: parameters[3],
          received_at: new Date("2026-08-24T14:00:00.000Z"),
        }],
      };
    },
  };
  const event = {
    data: {
      event_type: TELNYX_CALL_INSIGHT_EVENT_TYPE,
      id: "event-call-2",
      payload: {
        call_control_id: "v3:call-control-3",
        insight_group_id: "group-call-2",
      },
    },
  };
  const recorded = await recordInsightGroupWebhookEvent({
    rawBody: JSON.stringify(event),
    event,
    pool,
    resolveConversationId: async (callControlId) => {
      assert.equal(callControlId, "v3:call-control-3");
      return resolvedConversationId;
    },
  });
  assert.equal(recorded.accepted, true);
  assert.equal(recorded.eventType, TELNYX_CALL_INSIGHT_EVENT_TYPE);
  assert.equal(recorded.conversationId, resolvedConversationId);
  assert.equal(queries[0].parameters[2], resolvedConversationId);
  assert.match(queries[0].sql, /pg_notify/);
  assert.doesNotMatch(JSON.stringify(queries), /results|not persisted/);
});

test("insight webhook markers are idempotent and do not persist insight contents", async () => {
  const queries = [];
  let inserted = false;
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql.includes("INSERT INTO telnyx_conversation_insight_events")) {
        if (inserted) return { rows: [], rowCount: 0 };
        inserted = true;
        return {
          rows: [{
            event_id: parameters[0],
            conversation_id: parameters[2],
            insight_group_id: parameters[3],
            received_at: new Date("2026-08-24T10:00:00.000Z"),
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const event = {
    event_type: TELNYX_INSIGHT_EVENT_TYPE,
    conversation_id: "conversation-4",
    insight_group_id: "group-4",
    insights: [{ insight_name: "Private result", result: "must not be stored" }],
  };
  const rawBody = JSON.stringify(event);
  const first = await recordInsightGroupWebhookEvent({ rawBody, event, pool });
  const duplicate = await recordInsightGroupWebhookEvent({ rawBody, event, pool });
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ sql }) => sql.includes("pg_notify")));
  assert.doesNotMatch(JSON.stringify(queries), /must not be stored|Private result/);
});

test("Genesys widget uses an authenticated insight event stream with one fallback read", async () => {
  const [widget, eventRoute, notificationHub, webhookRoute, smsRoute] = await Promise.all([
    readFile(new URL("../components/genesys-ai/GenesysAiConversationWidget.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/genesys/ai-conversation-widget/insights-events/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/telnyx/insight-notification-hub.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/webhooks/telnyx/insights/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/genesys/sms/inbound/route.js", import.meta.url), "utf8"),
  ]);
  assert.match(widget, /new EventSource/);
  assert.match(widget, /"insights-ready"/);
  assert.match(widget, /35_000/);
  assert.doesNotMatch(widget, /\[1_000, 3_000, 7_000, 15_000, 30_000\]/);
  assert.match(eventRoute, /authorizeGenesysAiConversationWidget/);
  assert.match(eventRoute, /subscribeToInsightNotifications/);
  assert.match(eventRoute, /text\/event-stream/);
  assert.match(notificationHub, /LISTEN/);
  assert.match(notificationHub, /globalThis\.__telnyxInsightNotificationHub/);
  assert.match(webhookRoute, /verifyAndParseTelnyxWebhookRequest/);
  assert.match(smsRoute, /verifyAndParseTelnyxWebhookRequest/);
  assert.doesNotMatch(webhookRoute, /request\.json\(\)/);
  assert.doesNotMatch(smsRoute, /request\.json\(\)/);
});

test("insight event storage uses a migration version newer than legacy notification migrations", async () => {
  const schema = await readFile(
    new URL("../lib/postgres-schema.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    schema,
    /version: 105,[\s\S]{0,80}name: "telnyx_conversation_insight_events"/
  );
  assert.doesNotMatch(
    schema,
    /version: 103,[\s\S]{0,80}name: "telnyx_conversation_insight_events"/
  );
});
