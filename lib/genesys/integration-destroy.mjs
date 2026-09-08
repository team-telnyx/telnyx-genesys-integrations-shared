import Telnyx from "telnyx";
import { deleteGenesysOauthClient } from "./oauth-client-delete.mjs";
import { executeDeletionPlan } from "./deletion-executor.mjs";

import { getPostgresPool } from "../postgres.mjs";
import { loadAdminConsoleGenesysContext } from "./admin-console-installer.mjs";
import { removeAdminAssistantMissingFromProvider } from "./admin-desired-state.mjs";
import { assistantToolIds } from "./handoff-tool-definition.mjs";
import { listDestroyableManagedResources } from "./managed-resource-registry.mjs";
import {
  deleteGenesysCredentialSafely,
  deleteTtsIntegrationSafely,
} from "./tts-connector-genesys.mjs";

const MANUAL_RESOURCE_TYPES = new Set([
  "architect_script",
  "script",
  "open_messaging_recipient",
]);

const SUPPORTED_GENESYS_RESOURCE_TYPES = new Set([
  "audio_connector",
  "client_application",
  "interaction_widget",
  "tts_connector",
  "open_messaging_integration",
  "supported_content_profile",
  "messaging_setting",
  "architect_inbound_flow",
  "architect_inbound_message_flow",
  "architect_outbound_flow",
  "architect_tts_test_flow",
  "inbound_call_route",
  "did_pool",
  "integration_credential",
  "oauth_client",
  "group",
  "role",
  "contact_list",
  "contact_list_filter",
  "call_analysis_response_set",
  "outbound_campaign",
]);

const SUPPORTED_TELNYX_RESOURCE_TYPES = new Set([
  "ai_assistant",
  "ai_tool",
  "ai_insight_group",
  "ai_insight",
  "integration_secret",
]);

function remoteStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

export function managedResourceDeletionSupport(resource) {
  if (resource.scopeType === "organization") {
    return { supported: false, reason: "Shared organization resource. Manage it in its component settings; removing this installation preserves it." };
  }
  if (resource.ownership !== "managed") {
    return { supported: false, reason: "External resource; this installation does not own it." };
  }
  if (MANUAL_RESOURCE_TYPES.has(resource.resourceType)) {
    return {
      supported: false,
      reason: resource.resourceType === "open_messaging_recipient"
        ? "Recipient is removed with its Open Messaging integration."
        : "Genesys does not expose a supported script-delete API; delete it manually in Genesys Cloud.",
    };
  }
  const supported = resource.provider === "genesys"
    ? SUPPORTED_GENESYS_RESOURCE_TYPES.has(resource.resourceType)
    : SUPPORTED_TELNYX_RESOURCE_TYPES.has(resource.resourceType);
  return supported
    ? { supported: true, reason: null }
    : { supported: false, reason: `No destroy adapter for ${resource.provider} ${resource.resourceType}.` };
}

export function applyDestroyPlanSafety(resources, toolAssignments = []) {
  const managedAssistantResources = new Map(resources
    .filter((resource) => resource.provider === "telnyx" &&
      resource.resourceType === "ai_assistant" && resource.ownership === "managed")
    .map((resource) => [resource.remoteId, resource]));
  const assignmentsByTool = new Map(toolAssignments.map((entry) => [
    String(entry.remoteToolId || entry.remote_tool_id || "").trim(),
    [...new Set(entry.assistantIds || entry.assistant_ids || [])].map(String).filter(Boolean),
  ]));
  const insightGroupAssignments = new Map(resources
    .filter((resource) => resource.provider === "telnyx" && resource.resourceType === "ai_insight_group")
    .map((group) => [group.id, resources.filter((resource) =>
      resource.provider === "telnyx" && resource.resourceType === "ai_assistant" &&
      (resource.dependencies || []).some((dependency) =>
        dependency.resourceId === group.id && dependency.relationship === "uses_insight_group"
      )
    ).map((assistant) => assistant.remoteId)]));
  return resources
    .filter((resource) => !(
      resource.provider === "telnyx" &&
      resource.resourceType === "ai_assistant" &&
      resource.ownership !== "managed"
    ))
    .map((resource) => {
      const support = managedResourceDeletionSupport(resource);
      const assignedAssistantIds = resource.provider === "telnyx" && resource.resourceType === "ai_tool"
        ? assignmentsByTool.get(resource.remoteId) || []
        : resource.provider === "telnyx" && resource.resourceType === "ai_insight_group"
          ? insightGroupAssignments.get(resource.id) || []
          : [];
      const requiredAssistantResourceIds = assignedAssistantIds
        .map((assistantId) => managedAssistantResources.get(assistantId)?.id)
        .filter(Boolean);
      const blockingAssistantIds = assignedAssistantIds.filter(
        (assistantId) => !managedAssistantResources.has(assistantId)
      );
      const assignmentReason = blockingAssistantIds.length
        ? `Assigned to ${blockingAssistantIds.length} other tracked assistant${blockingAssistantIds.length === 1 ? "" : "s"}. It cannot be deleted while those assignments remain.`
        : null;
      return {
        ...resource,
        assignedAssistantIds,
        assignmentCount: assignedAssistantIds.length,
        requiredAssistantResourceIds,
        blockingAssistantIds,
        selectable: resource.selectable && support.supported && !assignmentReason,
        deletionReason: support.reason || assignmentReason,
        selectionReason: requiredAssistantResourceIds.length
          ? `Select ${requiredAssistantResourceIds.length === 1 ? "its assigned managed assistant" : `all ${requiredAssistantResourceIds.length} assigned managed assistants`} first.`
          : null,
      };
    });
}

async function listActiveManagedToolAssignments(organizationId) {
  const result = await getPostgresPool().query(
    `SELECT d.remote_tool_id,
            array_agg(DISTINCT assignment.remote_assistant_id
              ORDER BY assignment.remote_assistant_id) AS assistant_ids
     FROM integration_ai_tool_definitions d
     JOIN integration_configuration_aggregates aggregate ON aggregate.id=d.aggregate_id
     JOIN integration_ai_tool_assignments assignment ON assignment.tool_definition_id=d.id
     WHERE aggregate.genesys_organization_id=$1
       AND d.status <> 'retired' AND assignment.status='active'
     GROUP BY d.remote_tool_id`,
    [organizationId]
  );
  return result.rows.map((row) => ({
    remoteToolId: row.remote_tool_id,
    assistantIds: row.assistant_ids || [],
  }));
}

export async function buildIntegrationDestroyPlan(organizationId) {
  const [resources, toolAssignments] = await Promise.all([
    listDestroyableManagedResources(organizationId),
    listActiveManagedToolAssignments(organizationId),
  ]);
  return applyDestroyPlanSafety(resources, toolAssignments);
}

async function ignoreMissing(operation) {
  try {
    return await operation();
  } catch (error) {
    if (remoteStatus(error) === 404 || /not found|has been deleted/i.test(error?.message || "")) {
      return { alreadyMissing: true };
    }
    throw error;
  }
}

async function disableGenesysIntegration(integrationsApi, id) {
  const integration = await ignoreMissing(() => integrationsApi.getIntegration(id));
  if (integration?.alreadyMissing) return integration;
  if (String(integration?.intendedState || "").toUpperCase() !== "DISABLED") {
    await integrationsApi.patchIntegration(id, { body: { intendedState: "DISABLED" } });
  }
  return integration;
}

export async function listTelnyxAssistantsUsingTool(telnyx, toolId) {
  const assistants = [];
  let pageNumber = 1;
  let totalPages = 1;
  do {
    const response = await telnyx.ai.assistants.list({
      query: { page: { number: pageNumber, size: 100 } },
    });
    if (!Array.isArray(response?.data)) {
      throw new Error("Telnyx assistant list returned an unexpected response while detaching a tool");
    }
    for (const listed of response.data) {
      const retrieved = await ignoreMissing(() => telnyx.ai.assistants.retrieve(listed.id));
      const assistant = retrieved?.data || retrieved;
      if (assistant?.alreadyMissing || !assistantToolIds(assistant).includes(toolId)) continue;
      assistants.push(assistant);
    }
    totalPages = Math.max(1, Number(response.meta?.total_pages || 1));
    pageNumber += 1;
  } while (pageNumber <= totalPages);
  return assistants;
}

export async function detachTelnyxTool(telnyx, toolId) {
  const assistants = await listTelnyxAssistantsUsingTool(telnyx, toolId);
  for (const assistant of assistants) {
    await telnyx.ai.assistants.update(assistant.id, {
      tool_ids: assistantToolIds(assistant).filter((id) => id !== toolId),
    });
  }
  return assistants.map(({ id }) => id);
}

export async function detachTelnyxAssistantTools(telnyx, assistantId) {
  const retrieved = await ignoreMissing(() => telnyx.ai.assistants.retrieve(assistantId));
  const assistant = retrieved?.data || retrieved;
  if (assistant?.alreadyMissing) return { alreadyMissing: true, detachedToolIds: [] };
  const toolIds = assistantToolIds(assistant);
  if (toolIds.length) {
    await telnyx.ai.assistants.update(assistantId, {
      tool_ids: [],
    });
  }
  return { alreadyMissing: false, detachedToolIds: toolIds };
}

export async function listTelnyxAssistantsUsingInsightGroup(telnyx, insightGroupId) {
  const assistants = [];
  let pageNumber = 1;
  let totalPages = 1;
  do {
    const response = await telnyx.ai.assistants.list({
      query: { page: { number: pageNumber, size: 100 } },
    });
    if (!Array.isArray(response?.data)) {
      throw new Error("Telnyx assistant list returned an unexpected response while checking an Insights Group");
    }
    for (const listed of response.data) {
      const retrieved = await ignoreMissing(() => telnyx.ai.assistants.retrieve(listed.id));
      const assistant = retrieved?.data || retrieved;
      if (assistant?.alreadyMissing) continue;
      if (String(assistant?.insight_settings?.insight_group_id || "") === insightGroupId) {
        assistants.push(assistant);
      }
    }
    totalPages = Math.max(1, Number(response.meta?.total_pages || 1));
    pageNumber += 1;
  } while (pageNumber <= totalPages);
  return assistants;
}

async function deleteGenesysResource(context, resource) {
  const id = resource.remoteId;
  switch (resource.resourceType) {
    case "audio_connector":
    case "client_application":
    case "interaction_widget":
      await disableGenesysIntegration(context.integrationsApi, id);
      return ignoreMissing(() => context.integrationsApi.deleteIntegration(id));
    case "tts_connector":
      return deleteTtsIntegrationSafely(context.integrationsApi, id);
    case "open_messaging_integration":
      return ignoreMissing(() => context.conversationsApi
        .deleteConversationsMessagingIntegrationsOpenIntegrationId(id));
    case "supported_content_profile":
      return ignoreMissing(() => context.conversationsApi
        .deleteConversationsMessagingSupportedcontentSupportedContentId(id));
    case "messaging_setting":
      return ignoreMissing(() => context.conversationsApi.deleteConversationsMessagingSetting(id));
    case "architect_inbound_flow":
    case "architect_inbound_message_flow":
    case "architect_outbound_flow":
    case "architect_tts_test_flow":
      return ignoreMissing(() => context.architectApi.deleteFlow(id));
    case "inbound_call_route":
      return ignoreMissing(() => context.architectApi.deleteArchitectIvr(id));
    case "did_pool":
      return ignoreMissing(() => context.telephonyApi.deleteTelephonyProvidersEdgesDidpool(id));
    case "integration_credential":
      return deleteGenesysCredentialSafely(context.integrationsApi, id);
    case "oauth_client":
      return deleteGenesysOauthClient(context.oauthApi, id);
    case "group":
      return ignoreMissing(() => context.groupsApi.deleteGroup(id));
    case "role":
      return ignoreMissing(() => context.authorizationApi.deleteAuthorizationRole(id));
    case "outbound_campaign": {
      const campaign = await ignoreMissing(() => context.outboundApi.getOutboundCampaign(id));
      if (!campaign?.alreadyMissing && String(campaign.campaignStatus || "").toLowerCase() !== "off") {
        await context.outboundApi.putOutboundCampaign(id, { ...campaign, campaignStatus: "off" });
      }
      return ignoreMissing(() => context.outboundApi.deleteOutboundCampaign(id));
    }
    case "contact_list_filter":
      return ignoreMissing(() => context.outboundApi.deleteOutboundContactlistfilter(id));
    case "call_analysis_response_set":
      return ignoreMissing(() => context.outboundApi.deleteOutboundCallanalysisresponseset(id));
    case "contact_list":
      return ignoreMissing(() => context.outboundApi.deleteOutboundContactlist(id));
    default:
      throw new Error(`Unsupported Genesys resource type: ${resource.resourceType}`);
  }
}

async function deleteTelnyxResource(telnyx, resource, organizationId) {
  if (resource.resourceType === "ai_assistant") {
    const detached = await detachTelnyxAssistantTools(telnyx, resource.remoteId);
    const deleted = await ignoreMissing(() => telnyx.ai.assistants.delete(resource.remoteId));
    const local = await removeAdminAssistantMissingFromProvider({
      organizationId,
      telnyxAssistantId: resource.remoteId,
    });
    return { detached, deleted: deleted || null, local };
  }
  if (resource.resourceType === "ai_tool") {
    const assignedAssistants = await listTelnyxAssistantsUsingTool(telnyx, resource.remoteId);
    if (assignedAssistants.length) {
      throw new Error(
        `Telnyx tool ${resource.displayName || resource.remoteId} is still assigned to ${assignedAssistants.length} assistant${assignedAssistants.length === 1 ? "" : "s"}. Detach or delete those assistants first.`
      );
    }
    return ignoreMissing(() => telnyx.ai.tools.delete(resource.remoteId));
  }
  if (resource.resourceType === "ai_insight_group") {
    const assignedAssistants = await listTelnyxAssistantsUsingInsightGroup(telnyx, resource.remoteId);
    if (assignedAssistants.length) {
      throw new Error(
        `Telnyx Insights Group ${resource.displayName || resource.remoteId} is still assigned to ${assignedAssistants.length} assistant${assignedAssistants.length === 1 ? "" : "s"}. Delete or detach those assistants first.`
      );
    }
    return ignoreMissing(() => telnyx.ai.conversations.insightGroups.delete(resource.remoteId));
  }
  if (resource.resourceType === "ai_insight") {
    return ignoreMissing(() => telnyx.ai.conversations.insights.delete(resource.remoteId));
  }
  if (resource.resourceType === "integration_secret") {
    return ignoreMissing(() => telnyx.integrationSecrets.delete(resource.remoteId));
  }
  throw new Error(`Unsupported Telnyx resource type: ${resource.resourceType}`);
}

const DELETE_PRIORITY = Object.freeze({
  outbound_campaign: 100,
  contact_list_filter: 95,
  call_analysis_response_set: 94,
  inbound_call_route: 90,
  did_pool: 88,
  open_messaging_integration: 86,
  interaction_widget: 85,
  client_application: 84,
  ai_assistant: 80,
  architect_outbound_flow: 75,
  architect_inbound_flow: 74,
  architect_inbound_message_flow: 74,
  architect_tts_test_flow: 74,
  supported_content_profile: 70,
  messaging_setting: 68,
  contact_list: 65,
  ai_tool: 60,
  ai_insight_group: 59,
  ai_insight: 58,
  audio_connector: 55,
  tts_connector: 55,
  integration_credential: 45,
  integration_secret: 40,
  oauth_client: 35,
  role: 30,
  group: 25,
});

async function markResourceDeleted(resourceId) {
  await getPostgresPool().query(
    `UPDATE integration_managed_resources
     SET status='retired', deleted_at=NOW(), updated_at=NOW(),
       metadata=metadata || '{"destroyedBy":"danger_zone"}'::jsonb
     WHERE id=$1`,
    [resourceId]
  );
}

async function markResourceDeleteFailure(resourceId, error) {
  await getPostgresPool().query(
    `UPDATE integration_managed_resources
     SET status='error', updated_at=NOW(),
       metadata=metadata || jsonb_build_object('destroyError',$2::text)
     WHERE id=$1`,
    [resourceId, String(error?.message || error).slice(0, 2000)]
  );
}

export async function destroySelectedIntegrationResources({ organizationId, resourceIds }) {
  const selectedIds = [...new Set((resourceIds || []).map(String).filter(Boolean))];
  if (!selectedIds.length) throw new Error("Select at least one managed resource to delete");
  const plan = await buildIntegrationDestroyPlan(organizationId);
  const byId = new Map(plan.map((resource) => [resource.id, resource]));
  const selected = selectedIds.map((id) => {
    const resource = byId.get(id);
    if (!resource) throw new Error(`Managed resource ${id} was not found in this installation`);
    if (!resource.selectable) throw new Error(resource.deletionReason || `${resource.displayName} cannot be deleted`);
    const missingAssistant = (resource.requiredAssistantResourceIds || []).find(
      (assistantResourceId) => !selectedIds.includes(assistantResourceId)
    );
    if (missingAssistant) {
      throw new Error(resource.selectionReason || `${resource.displayName} requires its assigned assistants to be selected`);
    }
    return resource;
  }).sort((left, right) =>
    (DELETE_PRIORITY[right.resourceType] || 0) - (DELETE_PRIORITY[left.resourceType] || 0)
  );
  const needsGenesys = selected.some((resource) => resource.provider === "genesys");
  const needsTelnyx = selected.some((resource) => resource.provider === "telnyx");
  const context = needsGenesys ? await loadAdminConsoleGenesysContext({
    environment: process.env.GC_ENVIRONMENT,
    clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
    clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
  }) : null;
  if (context && context.organization.id !== organizationId) {
    throw new Error("Genesys organization changed after the delete inventory was loaded");
  }
  const telnyx = needsTelnyx ? new Telnyx({ apiKey: process.env.TELNYX_API_KEY }) : null;
  return executeDeletionPlan({
    plan, selected,
    remove: resource => resource.provider === "genesys"
      ? deleteGenesysResource(context, resource)
      : deleteTelnyxResource(telnyx, resource, organizationId),
    markDeleted: markResourceDeleted,
    markFailed: markResourceDeleteFailure,
  });
}
