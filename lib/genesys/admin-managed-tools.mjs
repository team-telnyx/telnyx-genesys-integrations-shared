import { randomUUID } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";
import {
  assistantToolIds,
  telnyxToolDefinition,
  telnyxToolDisplayName,
  telnyxToolFunctionName,
} from "./handoff-tool-definition.mjs";
import { normalizeAdminCustomTool } from "./admin-tool-catalog.mjs";

export const ADMIN_SHARED_HANDOFF_TOOL_KEY = "genesys_human_handoff";
export const ADMIN_SHARED_HANGUP_TOOL_KEY = "hangup";
export const ADMIN_SIP_TRANSFER_TOOL_KEY = "genesys_sip_transfer";
export const ADMIN_VOICE_QUEUE_TOOL_KEY = "genesys_voice_queue_selector";
// Invite plus skip turn replace the SIP transfer when the assistant should stay
// on the web call after the Genesys agent joins. Both are shared so they can be
// attached to any assistant later.
export const ADMIN_SHARED_INVITE_TOOL_KEY = "genesys_sip_invite";
export const ADMIN_SHARED_SKIP_TURN_TOOL_KEY = "skip_turn";
export const ADMIN_SHARED_TOOL_SCOPE_ID = "shared";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

const MANAGED_TOOL_SELECT = `
  SELECT d.id, a.genesys_organization_id, d.provider, d.logical_key,
         d.scope_type, d.scope_id, d.remote_tool_id, d.tool_type,
         d.display_name, d.function_name, d.desired_definition, d.status,
         d.metadata, d.created_at, d.updated_at, d.last_verified_at
  FROM integration_ai_tool_definitions d
  JOIN integration_configuration_aggregates a ON a.id=d.aggregate_id
`;

function mapTool(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.genesys_organization_id,
    provider: row.provider,
    logicalKey: row.logical_key,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    remoteToolId: row.remote_tool_id,
    toolType: row.tool_type,
    displayName: row.display_name,
    functionName: row.function_name || null,
    desiredDefinition: row.desired_definition || {},
    status: row.status,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

export async function getAdminManagedTool({
  organizationId,
  logicalKey,
  scopeType = "shared",
  scopeId = ADMIN_SHARED_TOOL_SCOPE_ID,
  provider = "telnyx",
}) {
  const result = await getPostgresPool().query(
    `${MANAGED_TOOL_SELECT}
     WHERE a.genesys_organization_id=$1 AND d.provider=$2 AND d.logical_key=$3
       AND d.scope_type=$4 AND d.scope_id=$5`,
    [
      required(organizationId, "Genesys organization ID"),
      required(provider, "Tool provider"),
      required(logicalKey, "Tool logical key"),
      required(scopeType, "Tool scope type"),
      required(scopeId, "Tool scope ID"),
    ]
  );
  return mapTool(result.rows[0]);
}

export async function getAdminManagedToolById(organizationId, id) {
  const result = await getPostgresPool().query(
    `${MANAGED_TOOL_SELECT}
     WHERE a.genesys_organization_id=$1 AND d.id=$2`,
    [
      required(organizationId, "Genesys organization ID"),
      required(id, "Managed tool registry ID"),
    ]
  );
  return mapTool(result.rows[0]);
}

export async function listAdminManagedTools(organizationId, { includeRetired = false } = {}) {
  const result = await getPostgresPool().query(
    `${MANAGED_TOOL_SELECT}
     WHERE a.genesys_organization_id=$1
       AND ($2::boolean OR d.status NOT IN ('retired', 'missing'))
     ORDER BY d.scope_type, d.scope_id, d.logical_key`,
    [required(organizationId, "Genesys organization ID"), includeRetired]
  );
  return result.rows.map(mapTool);
}

async function removeAdminManagedToolWithClient(client, { organizationId, id }) {
  const tool = await client.query(
    `SELECT d.id, d.aggregate_id, d.remote_tool_id
     FROM integration_ai_tool_definitions d
     JOIN integration_configuration_aggregates a ON a.id=d.aggregate_id
     WHERE a.genesys_organization_id=$1 AND d.id=$2
     LIMIT 1`,
    [organizationId, id]
  );
  if (!tool.rowCount) return { removed: false, id };
  const row = tool.rows[0];
  const selection = await client.query(
    `UPDATE integration_ai_assistants aa
     SET desired_config=jsonb_set(
           COALESCE(aa.desired_config, '{}'::jsonb),
           '{managedToolIds}',
           COALESCE((
             SELECT jsonb_agg(item.value)
             FROM jsonb_array_elements_text(
               COALESCE(aa.desired_config->'managedToolIds', '[]'::jsonb)
             ) AS item(value)
             WHERE item.value <> $2
           ), '[]'::jsonb),
           TRUE
         ),
         updated_at=NOW()
     FROM integration_configuration_aggregates a
     WHERE a.id=aa.aggregate_id AND a.genesys_organization_id=$1
       AND COALESCE(aa.desired_config->'managedToolIds', '[]'::jsonb) ? $2
     RETURNING aa.aggregate_id`,
    [organizationId, id]
  );
  if (selection.rowCount) {
    await client.query(
      `UPDATE integration_configuration_aggregates a
       SET desired_config=jsonb_set(
             COALESCE(a.desired_config, '{}'::jsonb),
             '{managedToolIds}',
             COALESCE((
               SELECT jsonb_agg(item.value)
               FROM jsonb_array_elements_text(
                 COALESCE(a.desired_config->'managedToolIds', '[]'::jsonb)
               ) AS item(value)
               WHERE item.value <> $2
             ), '[]'::jsonb),
             TRUE
           ),
           desired_revision=desired_revision + 1,
           updated_at=NOW()
       WHERE a.id=ANY($1::uuid[])`,
      [[...new Set(selection.rows.map((entry) => entry.aggregate_id))], id]
    );
  }
  const assignments = await client.query(
    `DELETE FROM integration_ai_tool_assignments
     WHERE tool_definition_id=$1
     RETURNING id`,
    [id]
  );
  await client.query(
    `DELETE FROM integration_configuration_aggregates
     WHERE id=$1`,
    [row.aggregate_id]
  );
  return {
    removed: true,
    id,
    remoteToolId: row.remote_tool_id,
    removedAssignments: assignments.rowCount,
    updatedAssistants: selection.rowCount,
  };
}

export async function removeAdminManagedToolMissingFromProvider({ organizationId, id }) {
  const organization = required(organizationId, "Genesys organization ID");
  const managedToolId = required(id, "Managed tool registry ID");
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const result = await removeAdminManagedToolWithClient(client, {
      organizationId: organization,
      id: managedToolId,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function remoteStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

export async function reconcileAdminManagedToolsWithProvider({
  telnyx,
  organizationId,
  tools = [],
}) {
  const active = [];
  const removed = [];
  const errors = [];
  for (const tool of tools) {
    try {
      await telnyx.ai.tools.retrieve(tool.remoteToolId);
      active.push(tool);
    } catch (error) {
      if (remoteStatus(error) !== 404) {
        active.push(tool);
        errors.push({
          id: tool.id,
          remoteToolId: tool.remoteToolId,
          error: error?.message || String(error),
        });
        continue;
      }
      removed.push(await removeAdminManagedToolMissingFromProvider({
        organizationId,
        id: tool.id,
      }));
    }
  }
  return { tools: active, removed, errors };
}

export async function syncAdminManagedToolsToDesiredState({ organizationId, tools = [] }) {
  const organization = required(organizationId, "Genesys organization ID");
  let assignmentGroups = 0;
  for (const tool of tools) {
    const registered = await upsertAdminManagedTool({
      organizationId: organization,
      provider: tool.provider,
      logicalKey: tool.logicalKey,
      scopeType: tool.scopeType,
      scopeId: tool.scopeId,
      remoteToolId: tool.remoteToolId,
      toolType: tool.toolType,
      displayName: tool.displayName,
      functionName: tool.functionName,
      desiredDefinition: tool.desiredDefinition,
      status: tool.status,
      metadata: tool.metadata,
    });
    const assignments = await listAdminManagedToolAssignments(tool.id);
    const groups = new Map();
    for (const assignment of assignments) {
      const key = `${assignment.component}:${assignment.deploymentId}`;
      const group = groups.get(key) || {
        component: assignment.component,
        deploymentId: assignment.deploymentId,
        assistantIds: [],
      };
      group.assistantIds.push(assignment.assistantId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      await replaceAdminManagedToolAssignments({
        organizationId: organization,
        managedToolId: registered.id,
        ...group,
      });
      assignmentGroups += 1;
    }
  }
  return { tools: tools.length, assignmentGroups };
}

export async function upsertAdminManagedTool({
  organizationId,
  provider = "telnyx",
  logicalKey,
  scopeType = "shared",
  scopeId = ADMIN_SHARED_TOOL_SCOPE_ID,
  remoteToolId,
  toolType,
  displayName,
  functionName = null,
  desiredDefinition = {},
  status = "active",
  metadata = {},
}) {
  const organization = required(organizationId, "Genesys organization ID");
  const normalizedProvider = required(provider, "Tool provider");
  const key = required(logicalKey, "Tool logical key");
  const normalizedScopeType = required(scopeType, "Tool scope type");
  const normalizedScopeId = required(scopeId, "Tool scope ID");
  const normalizedRemoteId = required(remoteToolId, "Remote tool ID");
  const normalizedToolType = required(toolType, "Tool type");
  const normalizedDisplayName = required(displayName, "Tool display name");
  const definitionJson = JSON.stringify(desiredDefinition || {});
  const metadataJson = JSON.stringify(metadata || {});
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      `${MANAGED_TOOL_SELECT}
       WHERE a.genesys_organization_id=$1 AND d.provider=$2 AND d.logical_key=$3
         AND d.scope_type=$4 AND d.scope_id=$5`,
      [organization, normalizedProvider, key, normalizedScopeType, normalizedScopeId]
    );
    const aggregateName = `${normalizedScopeType}:${normalizedScopeId}:${key}`;
    const aggregate = await client.query(
      `INSERT INTO integration_configuration_aggregates
        (id, genesys_organization_id, kind, name, enabled, desired_config)
       VALUES ($1,$2,'tool_bundle',$3,TRUE,$4::jsonb)
       ON CONFLICT (genesys_organization_id, kind, name)
       DO UPDATE SET enabled=TRUE,
         desired_revision=CASE
           WHEN integration_configuration_aggregates.desired_config IS DISTINCT FROM EXCLUDED.desired_config
           THEN integration_configuration_aggregates.desired_revision + 1
           ELSE integration_configuration_aggregates.desired_revision
         END,
         desired_config=EXCLUDED.desired_config, updated_at=NOW()
       RETURNING id`,
      [randomUUID(), organization, aggregateName, definitionJson]
    );
    const aggregateId = aggregate.rows[0].id;
    const result = await client.query(
      `INSERT INTO integration_ai_tool_definitions
        (id, aggregate_id, provider, logical_key, scope_type, scope_id,
         remote_tool_id, tool_type, display_name, function_name,
         desired_definition, status, metadata, last_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,NOW())
       ON CONFLICT (aggregate_id, logical_key, scope_type, scope_id)
       DO UPDATE SET provider=EXCLUDED.provider,
         remote_tool_id=EXCLUDED.remote_tool_id, tool_type=EXCLUDED.tool_type,
         display_name=EXCLUDED.display_name, function_name=EXCLUDED.function_name,
         desired_definition=EXCLUDED.desired_definition, status=EXCLUDED.status,
         metadata=EXCLUDED.metadata, updated_at=NOW(), last_verified_at=NOW()
       RETURNING *`,
      [randomUUID(), aggregateId, normalizedProvider, key, normalizedScopeType,
        normalizedScopeId, normalizedRemoteId, normalizedToolType, normalizedDisplayName,
        functionName ? String(functionName).trim() || null : null,
        definitionJson, status, metadataJson]
    );
    const previousRemoteId = previous.rows[0]?.remote_tool_id;
    if (previousRemoteId && previousRemoteId !== normalizedRemoteId) {
      await client.query(
        `UPDATE integration_managed_resources
         SET status='retired', updated_at=NOW()
         WHERE provider=$1 AND remote_id=$2`,
        [normalizedProvider, previousRemoteId]
      );
    }
    const resourceStatus = status === "active" ? "healthy" : status;
    await client.query(
      `INSERT INTO integration_managed_resources
        (id, aggregate_id, provider, resource_type, remote_id, display_name,
         desired_hash, observed_hash, status, observed_config, metadata, last_observed_at,
         logical_key, scope_type, scope_id, ownership)
       VALUES ($1,$2,$3,'ai_tool',$4,$5,md5($6),md5($6),$7,$6::jsonb,$8::jsonb,NOW(),
         $9,$10,$11,'managed')
       ON CONFLICT (provider, remote_id)
       DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id,
         resource_type='ai_tool', display_name=EXCLUDED.display_name,
         desired_hash=EXCLUDED.desired_hash, observed_hash=EXCLUDED.observed_hash,
         status=EXCLUDED.status, observed_config=EXCLUDED.observed_config,
         metadata=EXCLUDED.metadata, logical_key=EXCLUDED.logical_key,
         scope_type=EXCLUDED.scope_type, scope_id=EXCLUDED.scope_id,
         ownership='managed', updated_at=NOW(), last_observed_at=NOW()`,
      [randomUUID(), aggregateId, normalizedProvider, normalizedRemoteId,
        normalizedDisplayName, definitionJson, resourceStatus, metadataJson,
        key, normalizedScopeType === "deployment" ? "widget" : "installation",
        normalizedScopeId]
    );
    await client.query("COMMIT");
    return mapTool({ ...result.rows[0], genesys_organization_id: organization });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function telnyxResource(value) {
  return value?.data || value;
}

export async function createAdminCustomTool({ telnyx, organizationId, input }) {
  const normalized = normalizeAdminCustomTool(input);
  let remote = null;
  try {
    remote = telnyxResource(await telnyx.ai.tools.create(normalized.definition));
    return await upsertAdminManagedTool({
      organizationId,
      logicalKey: `custom_${randomUUID().replaceAll("-", "")}`,
      remoteToolId: required(remote?.id, "Created Telnyx tool ID"),
      toolType: normalized.kind,
      displayName: normalized.displayName,
      functionName: normalized.functionName,
      desiredDefinition: normalized.definition,
      metadata: {
        managedBy: "genesys-web-admin",
        source: "admin_catalog",
        editable: true,
        kind: normalized.kind,
        config: normalized.config,
      },
    });
  } catch (error) {
    if (remote?.id) await telnyx.ai.tools.delete(remote.id).catch(() => undefined);
    throw error;
  }
}

export async function updateAdminCustomTool({ telnyx, organizationId, id, input }) {
  const current = await getAdminManagedToolById(organizationId, id);
  if (!current || current.status === "retired") throw new Error("Managed assistant tool was not found");
  if (current.metadata?.source !== "admin_catalog" || current.metadata?.editable !== true) {
    throw new Error("Channel-required tools are read-only and are reconciled by their deployment");
  }
  const normalized = normalizeAdminCustomTool(input);
  if (normalized.kind !== current.metadata.kind) throw new Error("Assistant tool type cannot be changed after creation");
  await telnyx.ai.tools.update(current.remoteToolId, normalized.definition);
  try {
    return await upsertAdminManagedTool({
      organizationId,
      logicalKey: current.logicalKey,
      scopeType: current.scopeType,
      scopeId: current.scopeId,
      remoteToolId: current.remoteToolId,
      toolType: normalized.kind,
      displayName: normalized.displayName,
      functionName: normalized.functionName,
      desiredDefinition: normalized.definition,
      metadata: { ...current.metadata, kind: normalized.kind, config: normalized.config },
    });
  } catch (error) {
    await telnyx.ai.tools.update(current.remoteToolId, current.desiredDefinition).catch(() => undefined);
    throw error;
  }
}

export async function markAdminManagedToolStatus(id, status) {
  const result = await getPostgresPool().query(
    `UPDATE integration_ai_tool_definitions
     SET status=$2, updated_at=NOW(), last_verified_at=NOW()
     WHERE id=$1 RETURNING *`,
    [required(id, "Managed tool registry ID"), required(status, "Managed tool status")]
  );
  if (!result.rowCount) return null;
  const mapped = await getPostgresPool().query(
    `${MANAGED_TOOL_SELECT} WHERE d.id=$1`,
    [id]
  );
  return mapTool(mapped.rows[0]);
}

export async function replaceAdminManagedToolAssignments({
  organizationId,
  managedToolId,
  component,
  deploymentId,
  assistantIds = [],
}) {
  const organization = required(organizationId, "Genesys organization ID");
  const toolId = required(managedToolId, "Managed tool registry ID");
  const ownerComponent = required(component, "Tool assignment component");
  const ownerDeployment = required(deploymentId, "Tool assignment deployment ID");
  const assistants = [...new Set(
    (Array.isArray(assistantIds) ? assistantIds : [assistantIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )];
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE integration_ai_tool_assignments ma
       SET status='detached', updated_at=NOW()
       FROM integration_ai_tool_definitions d
       JOIN integration_configuration_aggregates a ON a.id=d.aggregate_id
       WHERE ma.tool_definition_id=d.id
         AND a.genesys_organization_id=$1 AND d.id=$2
         AND ma.component=$3 AND ma.deployment_id=$4`,
      [organization, toolId, ownerComponent, ownerDeployment]
    );
    for (const assistantId of assistants) {
      const desiredAssistant = await client.query(
        `SELECT aa.id
         FROM integration_ai_assistants aa
         JOIN integration_configuration_aggregates a ON a.id=aa.aggregate_id
         WHERE a.genesys_organization_id=$1 AND aa.telnyx_assistant_id=$2
         LIMIT 1`,
        [organization, assistantId]
      );
      await client.query(
        `INSERT INTO integration_ai_tool_assignments
          (id, assistant_id, remote_assistant_id, tool_definition_id, required_by,
           component, deployment_id, status, last_verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (tool_definition_id, remote_assistant_id, required_by)
         DO UPDATE SET assistant_id=EXCLUDED.assistant_id,
           component=EXCLUDED.component, deployment_id=EXCLUDED.deployment_id,
           status=EXCLUDED.status, updated_at=NOW(), last_verified_at=NOW()`,
        [randomUUID(), desiredAssistant.rows[0]?.id || null, assistantId, toolId,
          `${ownerComponent}:${ownerDeployment}`, ownerComponent, ownerDeployment,
          desiredAssistant.rowCount ? "active" : "assistant_missing"]
      );
    }
    const resourceLinks = await client.query(
      `SELECT ar.id AS assistant_resource_id, tr.id AS tool_resource_id
       FROM integration_ai_tool_definitions d
       JOIN integration_configuration_aggregates a ON a.id=d.aggregate_id
       JOIN integration_managed_resources tr
         ON tr.provider=d.provider AND tr.remote_id=d.remote_tool_id
       JOIN integration_ai_tool_assignments ma
         ON ma.tool_definition_id=d.id AND ma.status='active'
       JOIN integration_managed_resources ar
         ON ar.provider='telnyx' AND ar.resource_type='ai_assistant'
        AND ar.remote_id=ma.remote_assistant_id
       WHERE a.genesys_organization_id=$1 AND d.id=$2`,
      [organization, toolId]
    );
    const toolResourceId = resourceLinks.rows[0]?.tool_resource_id || (await client.query(
      `SELECT tr.id
       FROM integration_ai_tool_definitions d
       JOIN integration_configuration_aggregates a ON a.id=d.aggregate_id
       JOIN integration_managed_resources tr
         ON tr.provider=d.provider AND tr.remote_id=d.remote_tool_id
       WHERE a.genesys_organization_id=$1 AND d.id=$2`,
      [organization, toolId]
    )).rows[0]?.id;
    if (toolResourceId) {
      await client.query(
        `DELETE FROM integration_resource_dependencies
         WHERE depends_on_resource_id=$1 AND relationship='uses_tool'`,
        [toolResourceId]
      );
      for (const link of resourceLinks.rows) {
        await client.query(
          `INSERT INTO integration_resource_dependencies
            (resource_id, depends_on_resource_id, relationship)
           VALUES ($1,$2,'uses_tool')
           ON CONFLICT DO NOTHING`,
          [link.assistant_resource_id, link.tool_resource_id]
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
}

export async function listAdminManagedToolAssignments(managedToolId, { activeOnly = true } = {}) {
  const result = await getPostgresPool().query(
    `SELECT ma.*, a.genesys_organization_id, d.id AS managed_tool_id
     FROM integration_ai_tool_assignments ma
     JOIN integration_ai_tool_definitions d ON d.id=ma.tool_definition_id
     JOIN integration_configuration_aggregates a ON a.id=d.aggregate_id
     WHERE d.id=$1 AND ($2::boolean = FALSE OR ma.status='active')
     ORDER BY ma.component, ma.deployment_id, ma.remote_assistant_id`,
    [required(managedToolId, "Managed tool registry ID"), activeOnly]
  );
  return result.rows.map((row) => ({
    id: row.id,
    organizationId: row.genesys_organization_id,
    managedToolId: row.managed_tool_id,
    assistantId: row.remote_assistant_id,
    component: row.component,
    deploymentId: row.deployment_id,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
  }));
}

export async function markAdminManagedToolAssignmentStatus(id, status) {
  const result = await getPostgresPool().query(
    `UPDATE integration_ai_tool_assignments
     SET status=$2, updated_at=NOW(), last_verified_at=NOW()
     WHERE id=$1 RETURNING *`,
    [required(id, "Managed tool assignment ID"), required(status, "Tool assignment status")]
  );
  return result.rows[0] || null;
}

function desiredTelnyxToolDefinition(tool) {
  const definition = telnyxToolDefinition(tool);
  const type = String(definition?.type || tool?.type || "").trim();
  return {
    display_name: telnyxToolDisplayName(tool),
    type,
    ...(type && definition?.[type] ? { [type]: definition[type] } : {}),
  };
}

export async function registerAdminManagedTelnyxTool({
  telnyx,
  organizationId,
  logicalKey,
  remoteToolId,
  scopeType = "shared",
  scopeId = ADMIN_SHARED_TOOL_SCOPE_ID,
  component,
  deploymentId,
  assistantIds = [],
  metadata = {},
}) {
  if (!remoteToolId) return null;
  const previous = await getAdminManagedTool({
    organizationId,
    logicalKey,
    scopeType,
    scopeId,
  });
  const previousAssignments = previous
    ? await listAdminManagedToolAssignments(previous.id)
    : [];
  const tool = await telnyx.ai.tools.retrieve(remoteToolId);
  const definition = desiredTelnyxToolDefinition(tool);
  const registered = await upsertAdminManagedTool({
    organizationId,
    logicalKey,
    scopeType,
    scopeId,
    remoteToolId,
    toolType: definition.type,
    displayName: definition.display_name,
    functionName: telnyxToolFunctionName(tool),
    desiredDefinition: definition,
    metadata: { managedBy: "genesys-web-admin", ...metadata },
  });
  if (previous?.remoteToolId && previous.remoteToolId !== remoteToolId) {
    for (const assignment of previousAssignments) {
      try {
        const assistant = await telnyx.ai.assistants.retrieve(assignment.assistantId);
        await telnyx.ai.assistants.update(assignment.assistantId, {
          tool_ids: [...new Set([
            ...assistantToolIds(assistant).filter((id) => id !== previous.remoteToolId),
            remoteToolId,
          ])],
        });
      } catch (error) {
        const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
        if (status !== 404) throw error;
        await markAdminManagedToolAssignmentStatus(assignment.id, "assistant_missing");
      }
    }
  }
  await replaceAdminManagedToolAssignments({
    organizationId,
    managedToolId: registered.id,
    component,
    deploymentId,
    assistantIds,
  });
  return registered;
}
