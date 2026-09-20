import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeAdminComponentConfig } from "../lib/genesys/admin-components.mjs";
import {
  callbackContactData,
  immediateCallbackSlots,
  callbackSlotCounts,
  callbackSlotsForDate,
  resolveCallbackAt,
} from "../lib/genesys/callback-request.mjs";
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig } from "../lib/widgets/config.js";
import {
  CALLBACK_CONTACT_COLUMNS,
  CALLBACK_RESOURCE_NAME,
  applyCallbacksDeployment,
  callbackCampaignBody,
  callbackContactListRecordCounts,
  callbackContactListBody,
  callbackContactListFilterBody,
  callbackContactListFilterMatches,
  callbackResponseSetBody,
  callbackResponseSetMatches,
  ensureCallbackCampaign,
  setCallbackCampaignEnabled,
  resolvePublishedHandoffScript,
} from "../lib/genesys/callbacks-manager.mjs";

const baseConfig = {
  queueIds: ["queue-1", "queue-2"],
  defaultQueueId: "queue-1",
  assistantId: "assistant-1",
  createAssistant: false,
  callerAddress: "+48123456789",
  callerName: "Telnyx Integrations",
  siteId: "site-1",
  wrapupCodeId: "wrapup-1",
  topics: [{ key: "sales", label: "Sales" }],
  consentText: "I consent to phone contact.",
  consentPolicyVersion: "2026-08",
  scheduleStepMinutes: 15,
  minimumLeadMinutes: 5,
  maximumScheduleDays: 30,
  availabilityWindowStart: "09:00",
  availabilityWindowEnd: "17:00",
  maxCallbacksPerSlot: 3,
};

test("Callbacks config supports an existing assistant and the shared AI-generated assistant workflow", () => {
  const existing = normalizeAdminComponentConfig("callbacks", baseConfig);
  assert.equal(existing.assistantId, "assistant-1");
  assert.equal(existing.applicationName, CALLBACK_RESOURCE_NAME);

  const generated = normalizeAdminComponentConfig("callbacks", {
    ...baseConfig,
    assistantId: "",
    createAssistant: true,
    assistantName: "Callback Assistant",
    assistantUseCase: "Handle scheduled customer callbacks",
    assistantInstructions: "Help the customer and offer a Genesys handoff when needed.",
    assistantGreeting: "Hello, this is your requested callback.",
    assistantContentGenerated: true,
  });
  assert.equal(generated.assistantId, "__managed_default__");
  assert.equal(generated.assistantContentGenerated, true);
});

test("Widget callback experience rejects malformed or reversed availability windows before publish", () => {
  assert.throws(
    () => parseWidgetConfig({
      ...DEFAULT_WIDGET_CONFIG,
      callbacks: { ...DEFAULT_WIDGET_CONFIG.callbacks, availabilityWindowStart: "9:00" },
    }),
    (error) => error.issues?.some((issue) => issue.path.join(".") === "callbacks.availabilityWindowStart")
  );
  assert.throws(
    () => parseWidgetConfig({
      ...DEFAULT_WIDGET_CONFIG,
      callbacks: {
        ...DEFAULT_WIDGET_CONFIG.callbacks,
        availabilityWindowStart: "17:00",
        availabilityWindowEnd: "09:00",
      },
    }),
    (error) => error.issues?.some((issue) =>
      issue.path.join(".") === "callbacks.availabilityWindowEnd" &&
      issue.message === "Availability window must end after it starts"
    )
  );
});

test("Callbacks managed Genesys resources share the exact Telnyx Integrations name", () => {
  const contactList = callbackContactListBody();
  const filter = callbackContactListFilterBody("list-1");
  const responseSet = callbackResponseSetBody("flow-1");
  const campaign = callbackCampaignBody(baseConfig, {
    contactListId: "list-1",
    contactListFilterId: "filter-1",
    responseSetId: "cars-1",
  });
  assert.equal(contactList.name, CALLBACK_RESOURCE_NAME);
  assert.equal(filter.name, CALLBACK_RESOURCE_NAME);
  assert.equal(responseSet.name, CALLBACK_RESOURCE_NAME);
  assert.deepEqual(responseSet.responses["disposition.classification.callable.person"], {
    reactionType: "transfer_flow",
    name: CALLBACK_RESOURCE_NAME,
    data: "flow-1",
  });
  assert.deepEqual(responseSet.responses["disposition.classification.callable.machine"], {
    reactionType: "transfer_flow",
    name: CALLBACK_RESOURCE_NAME,
    data: "flow-1",
  });
  assert.equal(responseSet.responses["callable.person"], undefined);
  assert.equal(campaign.name, CALLBACK_RESOURCE_NAME);
  assert.deepEqual(contactList.columnNames, CALLBACK_CONTACT_COLUMNS);
  assert.equal(filter.sourceType, "ContactList");
  assert.deepEqual(filter.clauses[0].predicates[0], {
    column: "callback_at_utc",
    columnType: "alphabetic",
    operator: "BEFORE",
    value: "P00DT00H00M",
  });
  assert.equal(campaign.dialingMode, "agentless");
  assert.equal(campaign.alwaysRunning, true);
  assert.deepEqual(campaign.dynamicContactQueueingSettings, { sort: false, filter: true });
  assert.equal(campaign.campaignStatus, "off");
});

test("Callbacks preserve a running campaign while reconciling its configuration", async () => {
  let written;
  const result = await ensureCallbackCampaign({
    async getOutboundCampaign() {
      return { id: "campaign-1", campaignStatus: "on", version: 7 };
    },
    async putOutboundCampaign(id, body) {
      written = { id, body };
      return { ...body, id };
    },
  }, "campaign-1", baseConfig, {
    contactListId: "list-1",
    contactListFilterId: "filter-1",
    responseSetId: "response-set-1",
  });

  assert.equal(written.id, "campaign-1");
  assert.equal(written.body.campaignStatus, "on");
  assert.equal(written.body.version, 7);
  assert.equal(result.campaignStatus, "on");
});

test("Callback campaign runtime control waits for a confirmed Genesys status", async () => {
  const statuses = ["off", "stopping", "on"];
  let starts = 0;
  const campaign = await setCallbackCampaignEnabled({
    async getOutboundCampaign(id) {
      return { id, name: CALLBACK_RESOURCE_NAME, campaignStatus: statuses.shift() || "on" };
    },
    async postOutboundCampaignStart(id) {
      assert.equal(id, "campaign-1");
      starts += 1;
    },
    async postOutboundCampaignStop() {
      assert.fail("stop should not be called while enabling");
    },
  }, "campaign-1", true, { attempts: 4, intervalMs: 0, sleep: async () => undefined });

  assert.equal(starts, 1);
  assert.equal(campaign.campaignStatus, "on");
});

test("Callback Contact List counts use the live campaign filter preview", () => {
  assert.deepEqual(callbackContactListRecordCounts(
    { id: "list-1", size: 17 },
    { filteredContacts: 5, totalContacts: 17 }
  ), {
    callableRecords: 5,
    totalRecords: 17,
    recordCountsAvailable: true,
  });
  assert.deepEqual(callbackContactListRecordCounts({ id: "list-1", size: 17 }, null), {
    callableRecords: null,
    totalRecords: 17,
    recordCountsAvailable: false,
  });
});

test("Callbacks complete the deployment against strict fake Genesys objects", async () => {
  const state = {
    contactList: null,
    filter: null,
    responseSet: null,
    campaign: null,
  };
  const genericGenesysError = () => new Error(
    "The server encountered an unexpected condition which prevented it from fulfilling the request."
  );
  const outboundApi = {
    async postOutboundContactlists(body) {
      state.contactList = { ...structuredClone(body), id: "list-1", version: 1 };
      return state.contactList;
    },
    async postOutboundContactlistfilters(body) {
      state.filter = { ...structuredClone(body), id: "filter-1", version: 1 };
      // Reproduce Genesys persisting an object and still returning HTTP 500.
      throw genericGenesysError();
    },
    async getOutboundContactlistfilters() {
      return { entities: state.filter ? [state.filter] : [] };
    },
    async postOutboundCallanalysisresponsesets(body) {
      for (const [disposition, reaction] of Object.entries(body.responses || {})) {
        assert.match(disposition, /^disposition\.classification\./);
        assert.ok(["transfer_flow", "hangup"].includes(reaction.reactionType));
      }
      assert.equal(body.responses["disposition.classification.callable.person"].data, "flow-1");
      if (body.beepDetectionEnabled) {
        assert.equal(
          body.responses["disposition.classification.callable.machine"].reactionType,
          "transfer_flow"
        );
        assert.equal(body.responses["disposition.classification.callable.machine"].data, "flow-1");
      }
      state.responseSet = { ...structuredClone(body), id: "response-set-1", version: 1 };
      // Exercise the same read-after-write recovery for the next managed object.
      throw genericGenesysError();
    },
    async getOutboundCallanalysisresponsesets() {
      return { entities: state.responseSet ? [state.responseSet] : [] };
    },
    async postOutboundCampaigns(body) {
      assert.equal(body.contactList.id, "list-1");
      assert.equal(body.contactListFilters[0].id, "filter-1");
      assert.equal(body.callAnalysisResponseSet.id, "response-set-1");
      state.campaign = { ...structuredClone(body), id: "campaign-1", version: 1 };
      return state.campaign;
    },
  };
  const progress = [];
  const result = await applyCallbacksDeployment({
    schemaVersion: 1,
    organization: { id: "org-1", name: "Fake Genesys" },
    environment: "example.invalid",
    config: baseConfig,
    queues: [{ id: "queue-1", name: "Support" }],
    dependencies: {
      audioConnectorIntegrationId: "connector-1",
      handoffScriptId: "script-1",
    },
    current: {
      contactListId: null,
      contactListFilterId: null,
      responseSetId: null,
      campaignId: null,
      flowId: null,
    },
  }, {
    onProgress: async (entry) => progress.push(entry),
    dependencies: {
      loadAdminConsoleGenesysContext: async () => ({
        organization: { id: "org-1", name: "Fake Genesys" },
        environment: "example.invalid",
        accessToken: "fake-token",
        outboundApi,
        architectApi: { getFlows: async () => ({ entities: [] }) },
      }),
      getAdminManagedTool: async () => ({ remoteToolId: "tool-1" }),
      provisionSharedGenesysHandoff: async () => ({ assistant: { id: "assistant-1" } }),
      publishArchitectFlow: async () => ({ id: "flow-1", name: CALLBACK_RESOURCE_NAME }),
    },
  });

  assert.equal(result.contactList.id, "list-1");
  assert.equal(result.contactListFilter.id, "filter-1");
  assert.equal(result.responseSet.id, "response-set-1");
  assert.equal(result.campaign.id, "campaign-1");
  assert.deepEqual(
    progress.filter(({ status }) => status === "succeeded").map(({ ordinal }) => ordinal),
    [1, 2, 3, 4, 5, 6]
  );
  assert.equal(callbackResponseSetMatches(state.responseSet, callbackResponseSetBody("flow-1")), true);
});

test("Callbacks accept a filter write only when Genesys read-back matches desired state", () => {
  const desired = callbackContactListFilterBody("list-1");
  assert.equal(callbackContactListFilterMatches({
    ...desired,
    id: "filter-1",
    version: 2,
    clauses: desired.clauses.map((clause) => ({
      ...clause,
      predicates: clause.predicates.map((predicate) => ({ ...predicate, inverted: false })),
    })),
  }, desired), true);
  assert.equal(callbackContactListFilterMatches({
    ...desired,
    clauses: [{ ...desired.clauses[0], predicates: [{ ...desired.clauses[0].predicates[0], value: "P01DT00H00M" }] }],
  }, desired), false);
});

test("Callbacks resolve the published handoff script from the managed Audio Connector manifest", () => {
  const deployment = {
    deployment: { id: "CECA32", name: "Telnyx Integrations" },
    resources: { scriptId: "script-managed" },
    resourceNames: { handoffScriptName: "Telnyx Integrations" },
  };
  const scripts = [
    { id: "script-legacy", name: "Telnyx AI Handoff Summary" },
    { id: "script-managed", name: "Telnyx Integrations" },
  ];
  assert.deepEqual(resolvePublishedHandoffScript(scripts, deployment), scripts[1]);
  assert.equal(resolvePublishedHandoffScript([scripts[0]], deployment), null);
});

test("Callback data contains exact consent evidence and resolves immediate time in the visitor timezone", () => {
  const now = new Date("2026-08-17T08:02:00.000Z");
  const data = callbackContactData({
    requestId: "05b6edda-e1a8-47b1-ad78-ece9db4fcf27",
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+48123456789",
    email: "ada@example.com",
    topicKey: "sales",
    description: "Please call about an offer.",
    mode: "immediate",
    timeZone: "Europe/Warsaw",
    locale: "pl-PL",
    consentPhone: true,
    consentSms: false,
    consentEmail: true,
  }, baseConfig, { widgetId: "support", now });
  assert.equal(data.callback_at_utc, "2026-08-17T08:15Z");
  assert.equal(data.consent_text, baseConfig.consentText);
  assert.equal(data.consent_policy_version, baseConfig.consentPolicyVersion);
  assert.equal(data.consent_phone, "true");
  assert.equal(data.consent_email, "true");
});

test("Callback API data rejects callback modes disabled by the published widget", () => {
  const input = {
    requestId: "05b6edda-e1a8-47b1-ad78-ece9db4fcf27",
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+48123456789",
    email: "ada@example.com",
    topicKey: "sales",
    description: "Please call about an offer.",
    timeZone: "Europe/Warsaw",
    locale: "pl-PL",
    consentPhone: true,
    consentSms: false,
    consentEmail: false,
  };
  assert.throws(
    () => callbackContactData(
      { ...input, mode: "immediate" },
      { ...baseConfig, allowImmediate: false },
      { widgetId: "support", now: new Date("2026-08-17T08:02:00.000Z") }
    ),
    /Immediate callbacks are unavailable/
  );
  assert.throws(
    () => callbackContactData(
      { ...input, mode: "scheduled", scheduledAtUtc: "2026-08-17T08:30:00.000Z" },
      { ...baseConfig, allowScheduled: false },
      { widgetId: "support", now: new Date("2026-08-17T08:02:00.000Z") }
    ),
    /Scheduled callbacks are unavailable/
  );
});

test("Immediate callbacks expose later eligible slots when the first slot is full", () => {
  const slots = immediateCallbackSlots({
    timeZone: "Europe/Warsaw",
    config: { ...baseConfig, availabilityWindowStart: "09:00", availabilityWindowEnd: "10:00" },
    now: new Date("2026-08-17T06:50:00.000Z"),
    notBeforeUtc: "2026-08-17T07:00:00.000Z",
  });
  assert.deepEqual(
    slots.slice(0, 4).map(({ callbackAtUtc }) => callbackAtUtc),
    ["2026-08-17T07:00Z", "2026-08-17T07:15Z", "2026-08-17T07:30Z", "2026-08-17T07:45Z"]
  );
  assert.ok(slots.some(({ callbackAtUtc }) => callbackAtUtc === "2026-08-18T07:00Z"));
});

test("Scheduled callback time is validated against step, lead time and horizon", () => {
  const now = new Date("2026-08-17T08:00:00.000Z");
  assert.equal(resolveCallbackAt({
    mode: "scheduled",
    scheduledAtUtc: "2026-08-17T08:30:00.000Z",
    timeZone: "Europe/Warsaw",
    config: baseConfig,
    now,
  }), "2026-08-17T08:30Z");
  assert.throws(() => resolveCallbackAt({
    mode: "scheduled",
    scheduledAtUtc: "2026-08-17T08:17:00.000Z",
    timeZone: "Europe/Warsaw",
    config: baseConfig,
    now,
  }), /15-minute step/);
  assert.throws(() => resolveCallbackAt({
    mode: "scheduled",
    scheduledAtUtc: "2026-08-17T16:15:00.000Z",
    timeZone: "Europe/Warsaw",
    config: baseConfig,
    now,
  }), /between 09:00 and 17:00/);
});

test("Callback availability generates local slots and counts matching Genesys records", async () => {
  const slots = callbackSlotsForDate({
    date: "2026-08-18",
    timeZone: "Europe/Warsaw",
    config: { ...baseConfig, availabilityWindowStart: "09:00", availabilityWindowEnd: "10:00" },
    now: new Date("2026-08-17T08:00:00.000Z"),
  });
  assert.deepEqual(slots.map(({ label }) => label), ["09:00", "09:15", "09:30", "09:45"]);
  assert.equal(slots[0].callbackAtUtc, "2026-08-18T07:00Z");
  const calls = [];
  const counts = await callbackSlotCounts({
    async postOutboundContactlistContactsSearch(listId, body) {
      calls.push({ listId, body });
      return {
        entities: [
          { data: { callback_at_utc: slots[1].callbackAtUtc } },
          { data: { callback_at_utc: slots[1].callbackAtUtc } },
          { data: { callback_at_utc: slots[3].callbackAtUtc } },
        ],
        pageCount: 1,
      };
    },
  }, "list-1", slots.map(({ callbackAtUtc }) => callbackAtUtc));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.criteria.filterType, "OR");
  // One predicate per day rather than per slot: Genesys rejects a filter carrying
  // a predicate for each slot of a normal availability window.
  assert.equal(calls[0].body.criteria.clauses[0].predicates.length, 1);
  assert.deepEqual(calls[0].body.criteria.clauses[0].predicates[0], {
    column: "callback_at_utc",
    columnType: "alphabetic",
    operator: "BEGINS_WITH",
    value: "2026-08-18",
  });
  assert.equal(counts[slots[1].callbackAtUtc], 2);
  assert.equal(counts[slots[3].callbackAtUtc], 1);
  // Contacts outside the requested slots must not be counted toward them.
  const strayCounts = await callbackSlotCounts({
    async postOutboundContactlistContactsSearch() {
      return { entities: [{ data: { callback_at_utc: "2026-08-18T23:45Z" } }], pageCount: 1 };
    },
  }, "list-1", slots.map(({ callbackAtUtc }) => callbackAtUtc));
  assert.deepEqual(Object.values(strayCounts), [0, 0, 0, 0]);
});

test("slot counting groups a local day that straddles two UTC dates", async () => {
  const { callbackSlotDatePrefixes } = await import("../lib/genesys/callback-request.mjs");
  assert.deepEqual(
    callbackSlotDatePrefixes(["2026-08-18T22:00Z", "2026-08-18T23:45Z", "2026-08-19T00:15Z"]),
    ["2026-08-18", "2026-08-19"]
  );
  assert.deepEqual(callbackSlotDatePrefixes(["", null, "nonsense"]), []);
});

test("widget runtime routes agree on which organization owns a widget", async () => {
  const [store, bootstrap, callbacks] = await Promise.all([
    readFile(new URL("../lib/widgets/store.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widgets/[publicId]/bootstrap/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widgets/[publicId]/callbacks/route.js", import.meta.url), "utf8"),
  ]);
  // Seeded example widgets carry no organization. Bootstrap fell back to the
  // installed one while the callbacks route did not, so the form offered a
  // channel whose availability endpoint answered 404.
  assert.match(store, /export function widgetOrganizationId\(widget\)/);
  assert.match(store, /process\.env\.GC_ORGANIZATION_ID/);
  assert.match(bootstrap, /const organizationId = widgetOrganizationId\(result\.widget\)/);
  assert.match(callbacks, /const organizationId = widgetOrganizationId\(widget\)/);
  assert.match(callbacks, /getAdminCallbacksConfig\(organizationId\)/);
  assert.match(callbacks, /context\.organization\.id !== organizationId/);
  assert.doesNotMatch(callbacks, /widget\.genesys_organization_id/);
});
