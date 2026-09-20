import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertWidgetNameIsNotReserved,
  normalizedManagedNameKey,
  widgetResourceBaseName,
  widgetTechnicalId6,
  widgetVoiceQueueFunctionName,
} from "../lib/genesys/resource-naming.mjs";
import {
  applyDestroyPlanSafety,
  detachTelnyxAssistantTools,
  detachTelnyxTool,
  managedResourceDeletionSupport,
} from "../lib/genesys/integration-destroy.mjs";

const environment = {
  GC_INSTALLATION_KEY: "prod",
  GC_INSTALLATION_NAME: "Telnyx Integrations PROD",
};

test("widget resources use INSTALLATION - WIDGET while only technical names receive ID6", () => {
  const widget = { id: "widget-db-id", publicId: "wgt_public_stable", name: "Customer Portal" };
  assert.equal(widgetResourceBaseName(widget, environment), "Telnyx Integrations PROD - Customer Portal");
  assert.match(widgetTechnicalId6(widget), /^[a-f0-9]{6}$/);
  assert.equal(widgetTechnicalId6(widget), widgetTechnicalId6({ ...widget, id: "another-row-id" }));
  assert.equal(
    widgetVoiceQueueFunctionName(widget),
    `select_genesys_voice_queue_${widgetTechnicalId6(widget)}`
  );
  assert.doesNotMatch(widgetResourceBaseName(widget, environment), /[a-f0-9]{6}$/i);
});

test("widget names normalize for deployment uniqueness and cannot equal INSTALLATION", () => {
  assert.equal(normalizedManagedNameKey(" Customer   Portal "), "customer portal");
  assert.equal(normalizedManagedNameKey("customer portal"), "customer portal");
  assert.throws(
    () => assertWidgetNameIsNotReserved("Telnyx Integrations PROD", environment),
    /reserved by this installation/
  );
});

test("database enforces normalized widget-name uniqueness per organization and installation", async () => {
  const schema = await readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8");
  const store = await readFile(new URL("../lib/widgets/store.js", import.meta.url), "utf8");
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS widgets_deployment_name_idx/);
  assert.match(schema, /COALESCE\(genesys_organization_id, ''\)[\s\S]*COALESCE\(installation_key, 'seed'\)[\s\S]*normalized_name/);
  assert.match(store, /WidgetNameConflictError/);
  assert.match(store, /status = 409|this\.status = 409/);
});

test("Danger Zone excludes external and manual-only resources", () => {
  assert.deepEqual(
    managedResourceDeletionSupport({ provider: "telnyx", resourceType: "ai_assistant", ownership: "external" }),
    { supported: false, reason: "External resource; this installation does not own it." }
  );
  assert.equal(managedResourceDeletionSupport({ provider: "genesys", resourceType: "script", ownership: "managed" }).supported, false);
  assert.equal(managedResourceDeletionSupport({ provider: "telnyx", resourceType: "ai_tool", ownership: "managed" }).supported, true);
  assert.equal(managedResourceDeletionSupport({ provider: "genesys", resourceType: "tts_connector", ownership: "managed" }).supported, true);
});

test("Danger Zone lists only managed Telnyx assistants and protects tools assigned elsewhere", () => {
  const resources = applyDestroyPlanSafety([
    { id: "external", provider: "telnyx", resourceType: "ai_assistant", remoteId: "assistant-external", ownership: "external", selectable: false },
    { id: "managed", provider: "telnyx", resourceType: "ai_assistant", remoteId: "assistant-managed", ownership: "managed", selectable: true },
    { id: "shared-tool", provider: "telnyx", resourceType: "ai_tool", remoteId: "tool-shared", ownership: "managed", selectable: true },
    { id: "free-tool", provider: "telnyx", resourceType: "ai_tool", remoteId: "tool-free", ownership: "managed", selectable: true },
  ], [
    { remoteToolId: "tool-shared", assistantIds: ["assistant-managed", "assistant-external"] },
    { remoteToolId: "tool-free", assistantIds: ["assistant-managed"] },
  ]);

  assert.deepEqual(resources.map(({ id }) => id), ["managed", "shared-tool", "free-tool"]);
  assert.equal(resources.find(({ id }) => id === "managed").selectable, true);
  assert.equal(resources.find(({ id }) => id === "shared-tool").selectable, false);
  assert.equal(resources.find(({ id }) => id === "shared-tool").assignmentCount, 2);
  assert.deepEqual(resources.find(({ id }) => id === "shared-tool").requiredAssistantResourceIds, ["managed"]);
  assert.deepEqual(resources.find(({ id }) => id === "shared-tool").blockingAssistantIds, ["assistant-external"]);
  assert.match(resources.find(({ id }) => id === "shared-tool").deletionReason, /Assigned to 1 other tracked assistant/);
  assert.equal(resources.find(({ id }) => id === "free-tool").selectable, true);
  assert.deepEqual(resources.find(({ id }) => id === "free-tool").requiredAssistantResourceIds, ["managed"]);
  assert.match(resources.find(({ id }) => id === "free-tool").selectionReason, /assigned managed assistant/);
});

test("Danger Zone requires managed assistants before deleting their Insights Group", () => {
  const resources = applyDestroyPlanSafety([
    {
      id: "assistant-resource",
      provider: "telnyx",
      resourceType: "ai_assistant",
      remoteId: "assistant-1",
      ownership: "managed",
      selectable: true,
      dependencies: [{ resourceId: "group-resource", relationship: "uses_insight_group" }],
    },
    {
      id: "group-resource",
      provider: "telnyx",
      resourceType: "ai_insight_group",
      remoteId: "group-1",
      ownership: "managed",
      selectable: true,
      dependencies: [],
    },
    {
      id: "insight-resource",
      provider: "telnyx",
      resourceType: "ai_insight",
      remoteId: "insight-1",
      ownership: "managed",
      selectable: true,
      dependencies: [],
    },
  ]);
  const group = resources.find(({ id }) => id === "group-resource");
  assert.deepEqual(group.requiredAssistantResourceIds, ["assistant-resource"]);
  assert.match(group.selectionReason, /assigned managed assistant/);
  assert.equal(managedResourceDeletionSupport({
    provider: "telnyx", resourceType: "ai_insight", ownership: "managed",
  }).supported, true);
});

test("Danger Zone detaches a Telnyx tool from assistants across every API page", async () => {
  const updates = [];
  const pages = [
    { data: [{ id: "assistant-1" }], meta: { total_pages: 2 } },
    { data: [{ id: "assistant-2" }], meta: { total_pages: 2 } },
  ];
  const telnyx = {
    ai: {
      assistants: {
        async list(options) {
          return pages[options.query.page.number - 1];
        },
        async retrieve(id) {
          return id === "assistant-1"
            ? { id, tool_ids: ["tool-1", "foreign-tool"] }
            : { id, tool_ids: ["foreign-tool"] };
        },
        async update(id, body) {
          updates.push({ id, body });
        },
      },
    },
  };

  await detachTelnyxTool(telnyx, "tool-1");

  assert.deepEqual(updates, [{ id: "assistant-1", body: { tool_ids: ["foreign-tool"] } }]);
});

test("Danger Zone detaches every tool before deleting an assistant", async () => {
  const updates = [];
  const telnyx = {
    ai: {
      assistants: {
        async retrieve(id) {
          return { data: { id, tool_ids: ["tool-1", "tool-2"] } };
        },
        async update(id, body) {
          updates.push({ id, body });
        },
      },
    },
  };

  const result = await detachTelnyxAssistantTools(telnyx, "assistant-managed");

  assert.deepEqual(result, {
    alreadyMissing: false,
    detachedToolIds: ["tool-1", "tool-2"],
  });
  assert.deepEqual(updates, [{ id: "assistant-managed", body: { tool_ids: [] } }]);
});
test('Danger Zone preserves organization-scoped TTS and test flows',()=>{
 for(const resourceType of ['tts_connector','architect_tts_test_flow']) {
  const result=managedResourceDeletionSupport({resourceType,provider:'genesys',ownership:'managed',scopeType:'organization'});
  assert.equal(result.supported,false);assert.match(result.reason,/Shared organization/);
 }
});
