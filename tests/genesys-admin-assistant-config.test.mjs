import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adminAssistantPreview,
  applyAdminManagedInstructionSections,
  extractAdminManagedInstructionSections,
} from "../lib/genesys/admin-assistant-config.mjs";
import {
  ADMIN_MANAGED_INSIGHT_DEFINITIONS,
  adminAssistantInsightState,
  adminManagedInsightProfileDefinition,
  partitionExistingTelnyxToolIds,
} from "../lib/genesys/admin-managed-insights.mjs";

const instructions = `Customer-owned instructions.

<!-- genesys-audio-runtime-context:start -->
## Genesys runtime context
Original managed text.
<!-- genesys-audio-runtime-context:end -->

Customer-owned closing instructions.`;

test("managed assistant instruction editor only replaces content inside known markers", () => {
  const sections = extractAdminManagedInstructionSections(instructions);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, "audio_runtime_context");
  const updated = applyAdminManagedInstructionSections(instructions, [{
    id: "audio_runtime_context",
    content: "## Genesys runtime context\nUpdated managed text.",
  }]);
  assert.match(updated, /Customer-owned instructions\./);
  assert.match(updated, /Updated managed text\./);
  assert.match(updated, /Customer-owned closing instructions\./);
  assert.equal((updated.match(/genesys-audio-runtime-context:start/g) || []).length, 1);
  assert.throws(() => applyAdminManagedInstructionSections(instructions, [{
    id: "audio_runtime_context",
    content: "<!-- invalid marker -->",
  }]), /cannot contain instruction markers/);
});

test("assistant preview normalizes channels, assigned numbers, LLM, STT and TTS", () => {
  const preview = adminAssistantPreview({
    id: "assistant-1",
    name: "Concierge",
    greeting: "Hello",
    instructions: "Help the caller.",
    model: "openai/gpt-4.1-mini",
    enabled_features: ["telephony", "messaging"],
    transcription: { model: "deepgram/flux", language: "en" },
    voice_settings: { voice: "Telnyx.NaturalHD.astra" },
    assigned_phone_numbers: [{ phone_number: "+12125550100" }],
  }, { usage: { dnis: ["+12125550101"], webChannels: ["voice"] } });
  assert.deepEqual(preview.enabledFeatures, ["telephony", "messaging"]);
  assert.deepEqual(preview.assignedNumbers, ["+12125550101", "+12125550100"]);
  assert.equal(preview.model, "openai/gpt-4.1-mini");
  assert.equal(preview.transcription.model, "deepgram/flux");
  assert.equal(preview.voiceSettings.voice, "Telnyx.NaturalHD.astra");
});

test("managed Insights Group uses installation naming, the backend webhook and exact unstructured definitions", () => {
  const profile = adminManagedInsightProfileDefinition({
    GC_INSTALLATION_KEY: "prod",
    GC_INSTALLATION_NAME: "Telnyx Integrations PROD",
    GC_PUBLIC_BASE_URL: "https://genesys.example.com",
  });
  assert.equal(profile.groupName, "Telnyx Integrations PROD");
  assert.equal(profile.webhookUrl, "https://genesys.example.com/api/webhooks/telnyx/insights");
  assert.deepEqual(profile.insights.map(({ label }) => label), ["Sentiment", "Summary"]);
  assert.ok(profile.insights.every(({ jsonSchema }) => jsonSchema === null));
  assert.equal(ADMIN_MANAGED_INSIGHT_DEFINITIONS[0].instructions,
    "Analyze sentiment of that conversation. Provide also scoring in a range between 0 and 1 using 2 decimal places. \nOutput should be nicely formatted using github markdown, add some additional styling like icons etc.");
  assert.equal(ADMIN_MANAGED_INSIGHT_DEFINITIONS[1].instructions,
    "Summarize the conversation for use as future context. Include key facts, decisions, preferences, or goals that could help continue or complete future tasks. Avoid unnecessary details or general pleasantries. Be concise but informative. Format the summary as a short paragraph (3–5 sentences max).");
  const state = adminAssistantInsightState({
    insight_settings: { insight_group_id: "group-1" },
  }, { group: { id: "group-1", status: "healthy" }, insights: [] });
  assert.equal(state.attached, true);
  assert.equal(state.drifted, false);
});

test("assistant reconciliation drops only shared tool IDs that no longer exist in Telnyx", async () => {
  const calls = [];
  const telnyx = {
    ai: {
      tools: {
        async retrieve(id) {
          calls.push(id);
          if (id === "tool-missing") {
            const error = new Error("Shared tool not found");
            error.status = 404;
            throw error;
          }
          return { id };
        },
      },
    },
  };
  const cache = new Map();
  const first = await partitionExistingTelnyxToolIds(
    telnyx,
    ["tool-live", "tool-missing", "tool-live"],
    cache
  );
  const second = await partitionExistingTelnyxToolIds(
    telnyx,
    ["tool-missing", "tool-live"],
    cache
  );
  assert.deepEqual(first, { existing: ["tool-live"], missing: ["tool-missing"] });
  assert.deepEqual(second, { existing: ["tool-live"], missing: ["tool-missing"] });
  assert.deepEqual(calls, ["tool-live", "tool-missing"]);
});

test("managed assistant bundles preserve foreign tools and expose one read-only master-detail UI", async () => {
  const [route, reconcile, desiredState, registry, consoleSource] = await Promise.all([
    readFile(new URL("../app/api/admin/ai/assistants/[id]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-managed-insights.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-desired-state.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-managed-tools.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AdminConsole.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(reconcile, /partitionExistingTelnyxToolIds/);
  assert.match(reconcile, /existingToolIds\.has\(toolId\) && !managedRemoteToolIds\.has\(toolId\)/);
  assert.match(reconcile, /reconcileAdminManagedInstructionSections/);
  assert.match(reconcile, /saveAdminManagedAssistantConfiguration/);
  assert.match(reconcile, /data_retention: true/);
  assert.match(reconcile, /pii_redaction: "disabled"/);
  assert.match(reconcile, /insight_group_id: profile\.group\.id/);
  assert.match(desiredState, /managed: row\.ownership === "managed" \|\| row\.has_dnis_route \|\| row\.has_active_tool_assignment/);
  assert.doesNotMatch(registry, /managedToolSelectionConfigured/);
  assert.match(consoleSource, /filter\(\(assistant\) => assistant\.managed === true && assistant\.status !== "missing"\)/);
  assert.match(consoleSource, /Agent config preview/);
  assert.match(consoleSource, /AssistantPreviewSettingsSection/);
  assert.match(consoleSource, /AssistantPreviewBadgeTile/);
  assert.doesNotMatch(consoleSource, /function AssistantJsonPreview/);
  assert.doesNotMatch(consoleSource, /JSON\.stringify\(tool\.desiredDefinition, null, 2\)/);
  assert.match(consoleSource, /tool\.description/);
  assert.match(consoleSource, /Managed instruction inserts/);
  assert.match(consoleSource, /Managed assistant tools/);
  assert.match(consoleSource, /Managed insights/);
  assert.doesNotMatch(consoleSource, /id: "tools", label: "Assistant Tools"/);
  assert.doesNotMatch(route, /export async function PATCH/);
});

test("missing managed assistants and tools are pruned after external Telnyx deletion", async () => {
  const [assistantRoute, assignmentRoute, desiredState, registry, inventoryRoute] = await Promise.all([
    readFile(new URL("../app/api/admin/ai/assistants/[id]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/ai/tools/[id]/assignments/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-desired-state.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/admin-managed-tools.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/inventory/route.js", import.meta.url), "utf8"),
  ]);
  assert.match(desiredState, /removeAdminAssistantWithClient/);
  assert.match(desiredState, /DELETE FROM integration_audio_dnis_routes/);
  assert.match(desiredState, /UPDATE integration_callback_campaigns[\s\S]*SET assistant_id=NULL/);
  assert.match(desiredState, /UPDATE integration_widget_channel_profiles[\s\S]*SET assistant_id=NULL/);
  assert.match(desiredState, /DELETE FROM integration_ai_tool_assignments[\s\S]*remote_assistant_id/);
  assert.match(assistantRoute, /remoteStatus\(error\) === 404/);
  assert.match(assistantRoute, /removeAdminAssistantMissingFromProvider/);
  assert.match(registry, /reconcileAdminManagedToolsWithProvider/);
  assert.match(registry, /removeAdminManagedToolMissingFromProvider/);
  assert.match(assignmentRoute, /telnyx\.ai\.tools\.retrieve\(tool\.remoteToolId\)/);
  assert.match(inventoryRoute, /reconcileAdminManagedToolsWithProvider/);
});
