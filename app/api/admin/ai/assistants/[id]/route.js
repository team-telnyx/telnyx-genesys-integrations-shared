import { NextResponse } from "next/server";
import Telnyx from "telnyx";

import { requireWidgetAdmin } from "@/lib/genesys/admin-auth";
import {
  adminAssistantPreview,
  extractAdminManagedInstructionSections,
} from "@/lib/genesys/admin-assistant-config.mjs";
import {
  getAdminAssistantUsage,
  listAdminAssistantCatalog,
  removeAdminAssistantMissingFromProvider,
} from "@/lib/genesys/admin-desired-state.mjs";
import {
  listAdminManagedToolAssignments,
  listAdminManagedTools,
} from "@/lib/genesys/admin-managed-tools.mjs";
import {
  adminAssistantInsightState,
  getAdminManagedInsightProfile,
} from "@/lib/genesys/admin-managed-insights.mjs";
import { assistantToolIds } from "@/lib/genesys/handoff-tool-definition.mjs";

function remoteStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

function managedToolDescription(tool) {
  const definition = tool?.desiredDefinition || {};
  const type = String(definition.type || tool?.toolType || "").trim();
  const configuration = type && definition[type] && typeof definition[type] === "object"
    ? definition[type]
    : {};
  return String(configuration.description || "").trim() || null;
}

async function managedAssistantContext(organizationId, assistantId) {
  const [catalog, tools, usage, insightProfile] = await Promise.all([
    listAdminAssistantCatalog(organizationId),
    listAdminManagedTools(organizationId),
    getAdminAssistantUsage(organizationId, assistantId),
    getAdminManagedInsightProfile(organizationId),
  ]);
  const catalogEntry = catalog.find((assistant) => assistant.telnyxAssistantId === assistantId);
  if (!catalogEntry?.managed) return null;
  return {
    catalog,
    catalogEntry,
    tools: tools.filter((tool) => tool.status !== "retired"),
    usage: usage || { dnis: [], callbackCampaign: false, webChannels: [] },
    insightProfile,
  };
}

async function assistantDetails(remoteAssistant, context) {
  const attachedIds = new Set(assistantToolIds(remoteAssistant));
  const managedTools = (await Promise.all(context.tools.map(async (tool) => {
    const assignments = (context.catalogEntry.tools || []).filter((assignment) => assignment.id === tool.id);
    const allAssignments = await listAdminManagedToolAssignments(tool.id);
    const expected = assignments.length > 0;
    const attached = attachedIds.has(tool.remoteToolId);
    if (!expected && !attached) return null;
    return {
      id: tool.id,
      logicalKey: tool.logicalKey,
      displayName: tool.displayName,
      remoteToolId: tool.remoteToolId,
      toolType: tool.toolType,
      scopeType: tool.scopeType,
      scopeId: tool.scopeId,
      status: tool.status,
      description: managedToolDescription(tool),
      attached,
      expected,
      drifted: expected !== attached,
      sharedByAssistantCount: new Set(allAssignments.map((assignment) => assignment.assistantId)).size,
      requiredBy: [...new Set(assignments
        .map((assignment) => assignment.component))],
    };
  }))).filter(Boolean);
  const instructionSections = extractAdminManagedInstructionSections(remoteAssistant.instructions);
  const managedInsights = adminAssistantInsightState(remoteAssistant, context.insightProfile);
  return {
    assistant: context.catalogEntry,
    managedTools,
    managedInsights,
    instructionSections,
    privacy: {
      dataRetention: remoteAssistant?.privacy_settings?.data_retention === true,
      piiRedaction: String(remoteAssistant?.privacy_settings?.pii_redaction || "") || "disabled",
      healthy: remoteAssistant?.privacy_settings?.data_retention === true &&
        String(remoteAssistant?.privacy_settings?.pii_redaction || "disabled") === "disabled",
    },
    bundleStatus: managedTools.some((tool) => tool.drifted) || managedInsights.drifted ||
      remoteAssistant?.privacy_settings?.data_retention !== true ||
      String(remoteAssistant?.privacy_settings?.pii_redaction || "disabled") !== "disabled"
      ? "drifted"
      : "healthy",
    preview: adminAssistantPreview(remoteAssistant, {
      usage: context.usage,
      managedTools,
      managedInsights,
      instructionSections,
    }),
  };
}

export async function GET(request, { params }) {
  const auth = await requireWidgetAdmin(request);
  if (auth.error) return auth.error;
  let assistantId = null;
  try {
    const { id } = await params;
    assistantId = String(id || "").trim();
    const context = await managedAssistantContext(auth.actor.organizationId, assistantId);
    if (!context) return NextResponse.json({ error: "Managed AI assistant was not found" }, { status: 404 });
    const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
    const response = await telnyx.ai.assistants.retrieve(assistantId);
    return NextResponse.json(await assistantDetails(response?.data || response, context), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (assistantId && remoteStatus(error) === 404) {
      await removeAdminAssistantMissingFromProvider({
        organizationId: auth.actor.organizationId,
        telnyxAssistantId: assistantId,
      });
      return NextResponse.json({
        error: "This managed AI assistant no longer exists in Telnyx and was removed from the integration catalog.",
        removed: true,
        assistants: await listAdminAssistantCatalog(auth.actor.organizationId),
      }, { status: 410 });
    }
    const status = remoteStatus(error) >= 400 && remoteStatus(error) < 500 ? remoteStatus(error) : 502;
    return NextResponse.json({ error: error.message }, { status });
  }
}
