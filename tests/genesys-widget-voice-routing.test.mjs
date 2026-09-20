import assert from "node:assert/strict";
import test from "node:test";

import {
  firstAvailableWidgetVoiceDid,
  isWidgetVoiceDid,
  widgetVoiceDidCandidates,
} from "../lib/widgets/voice-did-allocation.mjs";
import {
  ensureWidgetVoiceDidPool,
  ensureWidgetVoiceIvrRoute,
} from "../lib/genesys/widget-voice-routing.mjs";
import {
  widgetVoiceHeaderDataExpression,
  widgetVoiceHeaderValueExpression,
  widgetVoiceQueueNameExpression,
} from "../lib/genesys/widget-voice-flow.mjs";

test("Widget synthetic DID namespace contains 1000 sequential candidates", () => {
  const candidates = widgetVoiceDidCandidates();
  assert.equal(candidates.length, 1000);
  assert.equal(candidates[0], "+11009999000");
  assert.equal(candidates.at(-1), "+11009999999");
  assert.equal(isWidgetVoiceDid("+11009999555"), true);
  assert.equal(isWidgetVoiceDid("+11010000000"), false);
});

test("Widget DID allocator selects the first free number without materializing a range", () => {
  assert.equal(
    firstAvailableWidgetVoiceDid(["+11009999000", "+11009999001", "+11009999003"]),
    "+11009999002"
  );
});

test("Genesys provisioning creates one single-number DID pool per deployment", async () => {
  const calls = [];
  const result = await ensureWidgetVoiceDidPool({
    telephonyApi: {
      async postTelephonyProvidersEdgesDidpools(body) {
        calls.push(body);
        return { id: "pool-1", ...body };
      },
    },
    didPools: [],
    name: "Widget [A1B2C3] - Voice DID",
    phoneNumber: "+11009999007",
    deploymentId: "A1B2C3",
  });
  assert.equal(result.created, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].startPhoneNumber, "+11009999007");
  assert.equal(calls[0].endPhoneNumber, "+11009999007");
  assert.equal(calls[0].provider, "PURE_CLOUD");
});

test("Genesys provisioning reuses its ID-bound DID pool when Genesys omits the pool name", async () => {
  let creates = 0;
  const result = await ensureWidgetVoiceDidPool({
    telephonyApi: {
      async getTelephonyProvidersEdgesDidpool(id) {
        return {
          id,
          startPhoneNumber: "+11009999007",
          endPhoneNumber: "+11009999007",
          description: "Managed by genesys:widget; deployment A1B2C3; single synthetic routing DID",
        };
      },
      async postTelephonyProvidersEdgesDidpools() { creates += 1; },
    },
    didPools: [{ id: "pool-1", startPhoneNumber: "+11009999007", endPhoneNumber: "+11009999007" }],
    didPoolId: "pool-1",
    name: "Widget [A1B2C3] - Voice DID",
    phoneNumber: "+11009999007",
    deploymentId: "A1B2C3",
  });
  assert.equal(result.created, false);
  assert.equal(result.didPool.id, "pool-1");
  assert.equal(creates, 0);
});

test("Genesys inbound route assigns only the deployment DID to its managed flow", async () => {
  const calls = [];
  const result = await ensureWidgetVoiceIvrRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [] }; },
      async postArchitectIvrs(body) {
        calls.push(body);
        return { id: "ivr-1", ...body };
      },
    },
    name: "Widget [A1B2C3] - Voice DID Route",
    phoneNumber: "+11009999007",
    flow: { id: "flow-1", name: "Widget [A1B2C3] - Voice Routing" },
    deploymentId: "A1B2C3",
  });
  assert.equal(result.created, true);
  assert.deepEqual(calls[0].dnis, ["+11009999007"]);
  assert.equal(calls[0].openHoursFlow.id, "flow-1");
  assert.equal(calls[0].closedHoursFlow, undefined);
  assert.equal(calls[0].holidayHoursFlow, undefined);
});

test("Genesys inbound route waits for a newly created DID pool to propagate", async () => {
  let creates = 0;
  const result = await ensureWidgetVoiceIvrRoute({
    architectApi: {
      async getArchitectIvrs() { return { entities: [] }; },
      async postArchitectIvrs(body) {
        creates += 1;
        if (creates === 1) {
          throw {
            code: "general.bad.request",
            details: [{ errorCode: "DID_POOL_REQUIRED" }],
          };
        }
        return { id: "ivr-after-propagation", ...body };
      },
    },
    name: "Widget [A1B2C3] - Voice DID Route",
    phoneNumber: "+11009999007",
    flow: { id: "flow-1", name: "Widget [A1B2C3] - Voice Routing" },
    deploymentId: "A1B2C3",
  });
  assert.equal(creates, 2);
  assert.equal(result.ivr.id, "ivr-after-propagation");
});

test("managed voice flow reads named SIP header JSON values and canonicalizes an allowed queue name", () => {
  const headerData = widgetVoiceHeaderDataExpression();
  assert.equal(headerData, "Flow.TelnyxSipHeadersResult");

  const header = widgetVoiceHeaderValueExpression("X-TGX-Call-Control-Id");
  assert.match(header, /GetJsonObjectPropertyNames\(Flow\.TelnyxSipHeadersResult\)/);
  assert.match(header, /FindFirst\(GetJsonObjectPropertyNames\(/);
  assert.match(header, /"x-tgx-call-control-id"/);
  assert.match(
    header,
    /ToJsonCollection\(GetJsonObjectProperty\(Flow\.TelnyxSipHeadersResult, "x-tgx-call-control-id"\)\)\[0\]/
  );
  assert.doesNotMatch(header, /ToString\(GetJsonObjectProperty\(/);
  assert.doesNotMatch(header, /"X-TGX-Call-Control-Id"/);
  assert.doesNotMatch(header, /FindString|Substring|\\r\\n/);

  const queue = widgetVoiceQueueNameExpression([
    { id: "queue-sales", name: "Sales" },
    { id: "queue-support", name: "Support" },
  ]);
  assert.match(queue, /Flow\.TelnyxRequestedQueueName/);
  assert.match(queue, /"Sales"/);
  assert.match(queue, /"Support"/);
  assert.doesNotMatch(queue, /queue-sales|queue-support/);
});
