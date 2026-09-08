import { randomUUID } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export async function registerManagedResourceBatch({
  organizationId,
  aggregate,
  resources = [],
  dependencies = [],
}) {
  const organization = required(organizationId, "Genesys organization ID");
  const entries = resources.filter((resource) => String(resource?.remoteId || "").trim());
  const identities = new Map();
  for (const resource of entries) {
    const provider = resource.provider || "genesys";
    const remoteId = String(resource.remoteId).trim();
    const identity = `${provider}:${remoteId}`;
    const key = resource.key || resource.logicalKey || resource.resourceType;
    const existing = identities.get(identity);
    if (existing && existing !== key) {
      throw new Error(
        `Managed resource ${identity} cannot be registered as both ${existing} and ${key}`
      );
    }
    identities.set(identity, key);
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const aggregateResult = await client.query(
      `INSERT INTO integration_configuration_aggregates
        (id,genesys_organization_id,kind,name,enabled,desired_config,scope_type)
       VALUES ($1,$2,$3,$4,TRUE,$5::jsonb,$6)
       ON CONFLICT (genesys_organization_id,kind,name)
       DO UPDATE SET enabled=TRUE, desired_config=EXCLUDED.desired_config,
         scope_type=EXCLUDED.scope_type, updated_at=NOW()
       RETURNING id`,
      [
        randomUUID(),
        organization,
        required(aggregate?.kind, "Aggregate kind"),
        required(aggregate?.name, "Aggregate name"),
        JSON.stringify(aggregate?.desiredConfig || {}),
        aggregate?.scopeType || "installation",
      ]
    );
    const aggregateId = aggregateResult.rows[0].id;
    const ids = new Map();
    for (const resource of entries) {
      const remoteId = required(resource.remoteId, "Remote resource ID");
      const saved = await client.query(
        `INSERT INTO integration_managed_resources
          (id,aggregate_id,provider,resource_type,remote_id,display_name,status,
           observed_config,metadata,last_observed_at,logical_key,scope_type,scope_id,ownership)
         VALUES ($1,$2,$3,$4,$5,$6,'healthy',$7::jsonb,$8::jsonb,NOW(),$9,$10,$11,$12)
         ON CONFLICT (provider,remote_id)
         DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id,
           resource_type=EXCLUDED.resource_type, display_name=EXCLUDED.display_name,
           status='healthy', observed_config=EXCLUDED.observed_config,
           metadata=integration_managed_resources.metadata || EXCLUDED.metadata,
           last_observed_at=NOW(), updated_at=NOW(), logical_key=EXCLUDED.logical_key,
           scope_type=EXCLUDED.scope_type, scope_id=EXCLUDED.scope_id,
           ownership=EXCLUDED.ownership, deleted_at=NULL
         RETURNING id`,
        [
          randomUUID(), aggregateId, resource.provider || "genesys",
          required(resource.resourceType, "Resource type"), remoteId,
          String(resource.displayName || remoteId),
          JSON.stringify(resource.observed || { id: remoteId, name: resource.displayName || remoteId }),
          JSON.stringify({ source: "deployment", ...(resource.metadata || {}) }),
          resource.logicalKey || resource.resourceType,
          resource.scopeType || aggregate?.scopeType || "installation",
          resource.scopeId || aggregate?.name || "default",
          resource.ownership || "managed",
        ]
      );
      ids.set(resource.key || resource.logicalKey || resource.resourceType, saved.rows[0].id);
    }
    for (const dependency of dependencies) {
      const resourceId = ids.get(dependency.resource);
      const dependsOnId = ids.get(dependency.dependsOn);
      if (!resourceId || !dependsOnId) continue;
      if (resourceId === dependsOnId) {
        throw new Error(
          `Managed resource dependency ${dependency.resource} → ${dependency.dependsOn} resolves to the same resource`
        );
      }
      await client.query(
        `INSERT INTO integration_resource_dependencies
          (resource_id,depends_on_resource_id,relationship)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [resourceId, dependsOnId, dependency.relationship || "depends_on"]
      );
    }
    await client.query("COMMIT");
    return { aggregateId, resources: entries.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function registerManagedAgentExperience({
  organizationId,
  interactionWidget,
  handoffScript,
}) {
  return registerManagedResourceBatch({
    organizationId,
    aggregate: {
      kind: "agent_experience",
      name: "installation:agent-experience",
      desiredConfig: { installationName: interactionWidget.displayName || handoffScript.displayName },
    },
    resources: [
      {
        key: "interaction_widget",
        provider: "genesys",
        resourceType: "interaction_widget",
        remoteId: interactionWidget.remoteId,
        displayName: interactionWidget.displayName,
        logicalKey: "agent_experience_interaction_widget",
      },
      {
        key: "handoff_script",
        provider: "genesys",
        resourceType: "architect_script",
        remoteId: handoffScript.remoteId,
        displayName: handoffScript.displayName,
        logicalKey: "agent_experience_handoff_script",
        metadata: { deletion: "manual" },
      },
    ],
    dependencies: [
      { resource: "interaction_widget", dependsOn: "handoff_script", relationship: "opens_script" },
    ],
  });
}

export async function listDestroyableManagedResources(organizationId) {
  const result = await getPostgresPool().query(
    `SELECT r.id,r.provider,r.resource_type,r.remote_id,r.display_name,r.status,
            r.logical_key,r.scope_type,r.scope_id,r.ownership,r.metadata,
            a.kind AS aggregate_kind,a.name AS aggregate_name,a.scope_type AS aggregate_scope_type,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'resourceId',d.depends_on_resource_id,
                'relationship',d.relationship
              ))
              FROM integration_resource_dependencies d WHERE d.resource_id=r.id
            ),'[]'::jsonb) AS dependencies
     FROM integration_managed_resources r
     JOIN integration_configuration_aggregates a ON a.id=r.aggregate_id
     WHERE a.genesys_organization_id=$1 AND r.deleted_at IS NULL
       AND r.status <> 'retired'
     ORDER BY r.provider,r.resource_type,r.display_name,r.remote_id`,
    [required(organizationId, "Genesys organization ID")]
  );
  return result.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    resourceType: row.resource_type,
    remoteId: row.remote_id,
    displayName: row.display_name || row.remote_id,
    status: row.status,
    logicalKey: row.logical_key,
    scopeType: row.aggregate_scope_type === "organization" ? "organization" : row.scope_type,
    scopeId: row.scope_id,
    ownership: row.ownership,
    aggregateKind: row.aggregate_kind,
    aggregateName: row.aggregate_name,
    metadata: row.metadata || {},
    dependencies: row.dependencies || [],
    selectable: row.ownership === "managed",
  }));
}
