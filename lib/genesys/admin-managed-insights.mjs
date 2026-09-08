import { createHash } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";
import {
  extractAdminManagedInstructionSections,
  reconcileAdminManagedInstructionSections,
} from "./admin-assistant-config.mjs";
import {
  listAdminAssistantCatalog,
  removeAdminAssistantMissingFromProvider,
  saveAdminManagedAssistantConfiguration,
} from "./admin-desired-state.mjs";
import {
  listAdminManagedTools,
  reconcileAdminManagedToolsWithProvider,
} from "./admin-managed-tools.mjs";
import { assistantToolIds } from "./handoff-tool-definition.mjs";
import { installationResourceNames } from "./installation-scope.mjs";
import { registerManagedResourceBatch } from "./managed-resource-registry.mjs";

export const ADMIN_INSIGHT_PROFILE_AGGREGATE_NAME = "installation:insights";
export const ADMIN_INSIGHT_GROUP_LOGICAL_KEY = "assistant_insight_group";
export const ADMIN_SUMMARY_INSIGHT_LOGICAL_KEY = "assistant_summary_insight";
export const ADMIN_SENTIMENT_INSIGHT_LOGICAL_KEY = "assistant_sentiment_insight";

// These definitions intentionally mirror the manually verified Telnyx group
// "Genesys Integrations". Both are unstructured insights; do not add a JSON schema.
export const ADMIN_MANAGED_INSIGHT_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "sentiment",
    logicalKey: ADMIN_SENTIMENT_INSIGHT_LOGICAL_KEY,
    label: "Sentiment",
    instructions:
      "Analyze sentiment of that conversation. Provide also scoring in a range between 0 and 1 using 2 decimal places. \nOutput should be nicely formatted using github markdown, add some additional styling like icons etc.",
  }),
  Object.freeze({
    key: "summary",
    logicalKey: ADMIN_SUMMARY_INSIGHT_LOGICAL_KEY,
    label: "Summary",
    instructions:
      "Summarize the conversation for use as future context. Include key facts, decisions, preferences, or goals that could help continue or complete future tasks. Avoid unnecessary details or general pleasantries. Be concise but informative. Format the summary as a short paragraph (3–5 sentences max).",
  }),
]);

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function unwrap(value) {
  return value?.data || value;
}

function definitionHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function adminManagedInsightProfileDefinition(environment = process.env) {
  const installationName = installationResourceNames(environment).installationName;
  const publicBaseUrl = required(environment.GC_PUBLIC_BASE_URL, "GC_PUBLIC_BASE_URL").replace(/\/$/, "");
  return Object.freeze({
    groupName: installationName,
    description: `Conversation insights managed by ${installationName}.`,
    webhookUrl: `${publicBaseUrl}/api/webhooks/telnyx/insights`,
    insights: ADMIN_MANAGED_INSIGHT_DEFINITIONS.map((entry) => ({
      ...entry,
      name: `${installationName} - ${entry.label}`,
      jsonSchema: null,
    })),
  });
}

async function trackedProfileResources(organizationId) {
  const result = await getPostgresPool().query(
    `SELECT r.id, r.resource_type, r.remote_id, r.display_name, r.status,
            r.logical_key, r.observed_config, r.metadata, a.desired_config
     FROM integration_managed_resources r
     JOIN integration_configuration_aggregates a ON a.id=r.aggregate_id
     WHERE a.genesys_organization_id=$1 AND a.kind='insight_profile'
       AND a.name=$2 AND r.provider='telnyx' AND r.status <> 'retired'
       AND r.deleted_at IS NULL`,
    [required(organizationId, "Genesys organization ID"), ADMIN_INSIGHT_PROFILE_AGGREGATE_NAME]
  );
  return result.rows;
}

async function findInsightByExactName(telnyx, name) {
  for await (const insight of telnyx.ai.conversations.insights.list({ page: { size: 100 } })) {
    if (String(insight?.name || "").trim() === name) return insight;
  }
  return null;
}

async function findGroupByExactName(telnyx, name) {
  for await (const group of telnyx.ai.conversations.insightGroups.retrieveInsightGroups({
    page: { size: 100 },
  })) {
    if (String(group?.name || "").trim() === name) return group;
  }
  return null;
}

async function retrieveOrMissing(operation) {
  try {
    return unwrap(await operation());
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
    if (status === 404) return null;
    throw error;
  }
}

async function ensureInsight(telnyx, definition, tracked, created) {
  let insight = tracked?.remote_id
    ? await retrieveOrMissing(() => telnyx.ai.conversations.insights.retrieve(tracked.remote_id))
    : null;
  if (!insight) {
    const collision = await findInsightByExactName(telnyx, definition.name);
    if (collision) {
      throw new Error(
        `Telnyx insight ${definition.name} already exists but is not tracked by this installation`
      );
    }
    insight = unwrap(await telnyx.ai.conversations.insights.create({
      name: definition.name,
      instructions: definition.instructions,
    }));
    created.insights.push(insight.id);
  } else if (
    String(insight.name || "") !== definition.name ||
    String(insight.instructions || "") !== definition.instructions ||
    insight.json_schema != null
  ) {
    insight = unwrap(await telnyx.ai.conversations.insights.update(insight.id, {
      name: definition.name,
      instructions: definition.instructions,
      json_schema: null,
    }));
  }
  return insight;
}

async function ensureGroup(telnyx, definition, tracked, created) {
  let group = tracked?.remote_id
    ? await retrieveOrMissing(() => telnyx.ai.conversations.insightGroups.retrieve(tracked.remote_id))
    : null;
  if (!group) {
    const collision = await findGroupByExactName(telnyx, definition.groupName);
    if (collision) {
      throw new Error(
        `Telnyx insight group ${definition.groupName} already exists but is not tracked by this installation`
      );
    }
    group = unwrap(await telnyx.ai.conversations.insightGroups.insightGroups({
      name: definition.groupName,
      description: definition.description,
      webhook: definition.webhookUrl,
    }));
    created.group = group.id;
  } else if (
    String(group.name || "") !== definition.groupName ||
    String(group.description || "") !== definition.description ||
    String(group.webhook || "") !== definition.webhookUrl
  ) {
    group = unwrap(await telnyx.ai.conversations.insightGroups.update(group.id, {
      name: definition.groupName,
      description: definition.description,
      webhook: definition.webhookUrl,
    }));
  }
  return group;
}

async function linkGroupDependencies(organizationId, groupId, insightIds) {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const resources = await client.query(
      `SELECT r.id, r.remote_id
       FROM integration_managed_resources r
       JOIN integration_configuration_aggregates a ON a.id=r.aggregate_id
       WHERE a.genesys_organization_id=$1 AND r.provider='telnyx'
         AND r.remote_id=ANY($2::text[])`,
      [required(organizationId, "Genesys organization ID"), [groupId, ...insightIds]]
    );
    const byRemoteId = new Map(resources.rows.map((row) => [row.remote_id, row.id]));
    const groupResourceId = byRemoteId.get(groupId);
    if (groupResourceId) {
      await client.query(
        `DELETE FROM integration_resource_dependencies
         WHERE resource_id=$1 AND relationship='contains_insight'`,
        [groupResourceId]
      );
      for (const insightId of insightIds) {
        const insightResourceId = byRemoteId.get(insightId);
        if (!insightResourceId || insightResourceId === groupResourceId) continue;
        await client.query(
          `INSERT INTO integration_resource_dependencies
            (resource_id, depends_on_resource_id, relationship)
           VALUES ($1,$2,'contains_insight') ON CONFLICT DO NOTHING`,
          [groupResourceId, insightResourceId]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { organizationId };
}

export async function ensureAdminManagedInsightProfile({
  telnyx,
  organizationId,
  environment = process.env,
}) {
  const definition = adminManagedInsightProfileDefinition(environment);
  const trackedRows = await trackedProfileResources(organizationId);
  const tracked = new Map(trackedRows.map((row) => [row.logical_key, row]));
  const created = { group: null, insights: [] };
  let ensuredGroup = null;
  try {
    const insights = [];
    for (const insightDefinition of definition.insights) {
      insights.push(await ensureInsight(
        telnyx,
        insightDefinition,
        tracked.get(insightDefinition.logicalKey),
        created
      ));
    }
    const group = await ensureGroup(
      telnyx,
      definition,
      tracked.get(ADMIN_INSIGHT_GROUP_LOGICAL_KEY),
      created
    );
    ensuredGroup = group;
    const attachedIds = new Set((group.insights || []).map((insight) => String(insight?.id || insight)));
    for (const insight of insights) {
      if (!attachedIds.has(insight.id)) {
        await telnyx.ai.conversations.insightGroups.insights.assign(insight.id, {
          group_id: group.id,
        });
      }
    }
    const observedGroup = unwrap(await telnyx.ai.conversations.insightGroups.retrieve(group.id));
    await registerManagedResourceBatch({
      organizationId,
      aggregate: {
        kind: "insight_profile",
        name: ADMIN_INSIGHT_PROFILE_AGGREGATE_NAME,
        desiredConfig: definition,
      },
      resources: [
        {
          key: "group",
          provider: "telnyx",
          resourceType: "ai_insight_group",
          remoteId: observedGroup.id,
          displayName: definition.groupName,
          logicalKey: ADMIN_INSIGHT_GROUP_LOGICAL_KEY,
          observed: observedGroup,
          metadata: { definitionHash: definitionHash(definition), managedBy: "genesys-web-admin" },
        },
        ...insights.map((insight, index) => ({
          key: definition.insights[index].key,
          provider: "telnyx",
          resourceType: "ai_insight",
          remoteId: insight.id,
          displayName: definition.insights[index].name,
          logicalKey: definition.insights[index].logicalKey,
          observed: insight,
          metadata: {
            definitionHash: definitionHash(definition.insights[index]),
            managedBy: "genesys-web-admin",
            unstructured: true,
          },
        })),
      ],
    });
    await linkGroupDependencies(organizationId, observedGroup.id, insights.map(({ id }) => id));
    return {
      status: "healthy",
      group: observedGroup,
      insights,
      definition,
    };
  } catch (error) {
    if (ensuredGroup?.id) {
      for (const insightId of created.insights) {
        await telnyx.ai.conversations.insightGroups.insights.deleteUnassign(insightId, {
          group_id: ensuredGroup.id,
        }).catch(() => undefined);
      }
    }
    if (created.group) {
      await telnyx.ai.conversations.insightGroups.delete(created.group).catch(() => undefined);
    }
    for (const insightId of created.insights.reverse()) {
      await telnyx.ai.conversations.insights.delete(insightId).catch(() => undefined);
    }
    throw error;
  }
}

export async function getAdminManagedInsightProfile(organizationId, environment = process.env) {
  const definition = adminManagedInsightProfileDefinition(environment);
  const rows = await trackedProfileResources(organizationId);
  const byKey = new Map(rows.map((row) => [row.logical_key, row]));
  const group = byKey.get(ADMIN_INSIGHT_GROUP_LOGICAL_KEY);
  const insights = definition.insights.map((entry) => {
    const tracked = byKey.get(entry.logicalKey);
    return {
      ...entry,
      id: tracked?.remote_id || null,
      status: tracked?.status || "missing",
      observed: tracked?.observed_config || null,
    };
  });
  return {
    status: group?.status || "missing",
    group: {
      id: group?.remote_id || null,
      name: definition.groupName,
      webhookUrl: definition.webhookUrl,
      status: group?.status || "missing",
      observed: group?.observed_config || null,
    },
    insights,
  };
}

export async function trackAdminAssistantInsightAssignment({
  organizationId,
  assistantId,
  insightGroupId,
}) {
  const organization = required(organizationId, "Genesys organization ID");
  const remoteAssistantId = required(assistantId, "Telnyx assistant ID");
  const remoteGroupId = required(insightGroupId, "Telnyx insight group ID");
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const resources = await client.query(
      `SELECT r.id, r.resource_type, r.remote_id
       FROM integration_managed_resources r
       JOIN integration_configuration_aggregates a ON a.id=r.aggregate_id
       WHERE a.genesys_organization_id=$1 AND r.provider='telnyx'
         AND r.remote_id=ANY($2::text[])`,
      [organization, [remoteAssistantId, remoteGroupId]]
    );
    const assistantResource = resources.rows.find((row) => row.remote_id === remoteAssistantId);
    const groupResource = resources.rows.find((row) => row.remote_id === remoteGroupId);
    if (!assistantResource || !groupResource) {
      throw new Error("Assistant and Insight Group must be registered before linking them");
    }
    await client.query(
      `DELETE FROM integration_resource_dependencies
       WHERE resource_id=$1 AND relationship='uses_insight_group'`,
      [assistantResource.id]
    );
    await client.query(
      `INSERT INTO integration_resource_dependencies
        (resource_id, depends_on_resource_id, relationship)
       VALUES ($1,$2,'uses_insight_group') ON CONFLICT DO NOTHING`,
      [assistantResource.id, groupResource.id]
    );
    await client.query(
      `UPDATE integration_ai_assistants aa
       SET desired_config=COALESCE(aa.desired_config, '{}'::jsonb) || $3::jsonb,
           updated_at=NOW()
       FROM integration_configuration_aggregates a
       WHERE a.id=aa.aggregate_id AND a.genesys_organization_id=$1
         AND aa.telnyx_assistant_id=$2`,
      [organization, remoteAssistantId, JSON.stringify({ managedInsightGroupId: remoteGroupId })]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function adminAssistantInsightState(remoteAssistant, profile) {
  const assignedId = String(remoteAssistant?.insight_settings?.insight_group_id || "").trim() || null;
  const expectedId = profile?.group?.id || null;
  const resourcesHealthy = profile?.group?.status === "healthy" &&
    (profile?.insights || []).every((insight) => insight.status === "healthy");
  return {
    ...profile,
    assignedGroupId: assignedId,
    attached: Boolean(expectedId && assignedId === expectedId && resourcesHealthy),
    drifted: !expectedId || assignedId !== expectedId || !resourcesHealthy,
  };
}

export function adminAssistantBundleFingerprint({ tools = [], insights, instructionSections = [], privacy }) {
  return definitionHash({
    tools: tools.map((tool) => tool.remoteToolId).filter(Boolean).sort(),
    insightGroupId: insights?.group?.id || null,
    instructionSections: instructionSections.map(({ id, content }) => ({ id, content })),
    privacy,
  });
}

function sameStringSet(left, right) {
  return [...new Set(left)].sort().join("\n") === [...new Set(right)].sort().join("\n");
}

function remoteStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

export async function partitionExistingTelnyxToolIds(telnyx, toolIds, cache = new Map()) {
  const existing = [];
  const missing = [];
  for (const toolId of [...new Set((toolIds || []).map(String).filter(Boolean))]) {
    let exists = cache.get(toolId);
    if (exists === undefined) {
      try {
        await telnyx.ai.tools.retrieve(toolId);
        exists = true;
      } catch (error) {
        if (remoteStatus(error) !== 404) throw error;
        exists = false;
      }
      cache.set(toolId, exists);
    }
    (exists ? existing : missing).push(toolId);
  }
  return { existing, missing };
}

export async function reconcileAdminManagedAssistantBundles({
  telnyx,
  actor,
  environment = process.env,
}) {
  const organizationId = required(actor?.organizationId, "Genesys organization ID");
  const [profile, trackedTools] = await Promise.all([
    ensureAdminManagedInsightProfile({ telnyx, organizationId, environment }),
    listAdminManagedTools(organizationId),
  ]);
  const toolProviderState = await reconcileAdminManagedToolsWithProvider({
    telnyx,
    organizationId,
    tools: trackedTools,
  });
  const [catalog, managedTools] = await Promise.all([
    listAdminAssistantCatalog(organizationId),
    listAdminManagedTools(organizationId),
  ]);
  const managedRemoteToolIds = new Set(managedTools.map((tool) => tool.remoteToolId).filter(Boolean));
  const toolExistenceCache = new Map(toolProviderState.tools.map((tool) => [tool.remoteToolId, true]));
  for (const removed of toolProviderState.removed) {
    if (removed?.remoteToolId) toolExistenceCache.set(removed.remoteToolId, false);
  }
  const results = [];
  for (const catalogEntry of catalog.filter((entry) => entry.managed && entry.status !== "missing")) {
    const assistantId = catalogEntry.telnyxAssistantId;
    let remoteAssistant;
    try {
      remoteAssistant = unwrap(await telnyx.ai.assistants.retrieve(assistantId));
    } catch (error) {
      if (remoteStatus(error) !== 404) throw error;
      await removeAdminAssistantMissingFromProvider({
        organizationId,
        telnyxAssistantId: assistantId,
      });
      results.push({ assistantId, status: "missing", changed: false });
      continue;
    }
    const requiredToolRegistryIds = [...new Set((catalogEntry.tools || []).map((tool) => tool.id))];
    const requiredToolRemoteIds = [...new Set(
      (catalogEntry.tools || []).map((tool) => tool.remoteToolId).filter(Boolean)
    )];
    const previousToolIds = assistantToolIds(remoteAssistant);
    const verifiedTools = await partitionExistingTelnyxToolIds(
      telnyx,
      [...previousToolIds, ...requiredToolRemoteIds],
      toolExistenceCache
    );
    const existingToolIds = new Set(verifiedTools.existing);
    const nextToolIds = [...new Set([
      ...previousToolIds.filter((toolId) =>
        existingToolIds.has(toolId) && !managedRemoteToolIds.has(toolId)
      ),
      ...requiredToolRemoteIds.filter((toolId) => existingToolIds.has(toolId)),
    ])];
    const desiredSections = Array.isArray(catalogEntry.desiredConfig?.managedInstructionSections)
      ? catalogEntry.desiredConfig.managedInstructionSections
      : extractAdminManagedInstructionSections(remoteAssistant.instructions)
          .map(({ id, content }) => ({ id, content }));
    const instructions = reconcileAdminManagedInstructionSections(
      remoteAssistant.instructions,
      desiredSections
    );
    const privacySettings = {
      ...(remoteAssistant.privacy_settings || {}),
      data_retention: true,
      pii_redaction: "disabled",
    };
    const insightSettings = {
      ...(remoteAssistant.insight_settings || {}),
      insight_group_id: profile.group.id,
    };
    const changed = !sameStringSet(previousToolIds, nextToolIds) ||
      instructions !== String(remoteAssistant.instructions || "") ||
      remoteAssistant?.privacy_settings?.data_retention !== true ||
      String(remoteAssistant?.privacy_settings?.pii_redaction || "disabled") !== "disabled" ||
      String(remoteAssistant?.insight_settings?.insight_group_id || "") !== profile.group.id;
    const updated = changed
      ? unwrap(await telnyx.ai.assistants.update(assistantId, {
          instructions,
          tool_ids: nextToolIds,
          privacy_settings: privacySettings,
          insight_settings: insightSettings,
        }))
      : remoteAssistant;
    const instructionSections = extractAdminManagedInstructionSections(updated.instructions)
      .map(({ id, content }) => ({ id, content }));
    await saveAdminManagedAssistantConfiguration({
      actor,
      telnyxAssistantId: assistantId,
      assistant: updated,
      managedToolIds: requiredToolRegistryIds,
      instructionSections,
      insightGroupId: profile.group.id,
      bundleFingerprint: adminAssistantBundleFingerprint({
        tools: catalogEntry.tools || [],
        insights: profile,
        instructionSections,
        privacy: { dataRetention: true, piiRedaction: "disabled" },
      }),
    });
    await trackAdminAssistantInsightAssignment({
      organizationId,
      assistantId,
      insightGroupId: profile.group.id,
    });
    results.push({
      assistantId,
      name: updated.name || catalogEntry.name,
      status: "healthy",
      changed,
      tools: requiredToolRemoteIds.length,
      instructionInserts: instructionSections.length,
      insightGroupId: profile.group.id,
      removedMissingToolIds: verifiedTools.missing,
    });
  }
  return {
    profile,
    assistants: results,
    removedMissingTools: toolProviderState.removed,
    toolVerificationErrors: toolProviderState.errors,
  };
}
