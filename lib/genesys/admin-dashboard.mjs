import { randomUUID } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";
import { installationResourceNames } from "./installation-scope.mjs";

const MODULES = Object.freeze([
  { id: "audio", label: "Audio Connector", kinds: ["audio_connector", "audio_routing"], target: "ai", section: "audio" },
  { id: "assistants", label: "AI Assistants", kinds: ["assistant", "tool_bundle", "insight_profile"], target: "ai", section: "assistants" },
  { id: "queues", label: "Queue Policies", kinds: ["queue_policy"], target: "ai", section: "queues", configurationOnly: true, expectedObjects: 4 },
  { id: "messaging", label: "Web Chat", kinds: ["messaging_profile"], target: "ai", section: "messaging" },
  { id: "web-voice", label: "Web Calls", kinds: ["voice_profile"], target: "ai", section: "web-voice" },
  { id: "callbacks", label: "Callback Campaigns", kinds: ["callback_campaign"], target: "ai", section: "callbacks" },
  {
    id: "tts",
    label: "Text-to-Speech",
    kinds: ["tts"],
    target: "tts",
    section: null,
    scopeType: "organization",
  },
]);

const STATUS_PRIORITY = Object.freeze({
  error: 7,
  missing: 6,
  drifted: 5,
  updating: 4,
  creating: 3,
  unknown: 2,
  healthy: 1,
  retired: 0,
});

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function adminDashboardResourceStatus(row) {
  if (row.status === "healthy" && row.desired_hash) {
    if (!row.observed_hash) return "unknown";
    if (row.desired_hash !== row.observed_hash) return "drifted";
  }
  return row.status || "unknown";
}

export function adminDashboardAssistantIsManaged(row) {
  return Boolean(row?.has_dnis_route || row?.has_active_tool_assignment);
}

function highestPriorityStatus(resources) {
  return resources.reduce((current, resource) =>
    (STATUS_PRIORITY[resource.status] || 0) > (STATUS_PRIORITY[current] || 0) ? resource.status : current
  , "healthy");
}

export function adminDashboardModuleState(module, aggregates, resources) {
  if (module.scopeType === "organization") {
    if (!resources.length) return "not_configured";
    const status = highestPriorityStatus(resources);
    if (["error", "missing", "drifted", "unknown"].includes(status)) return status;
    if (["creating", "updating"].includes(status)) return "reconciling";
    return "shared";
  }
  if (!aggregates.length) return "not_configured";
  if (!resources.length && module.configurationOnly) {
    const complete = (!module.expectedObjects || aggregates.length >= module.expectedObjects) && aggregates.every((aggregate) => {
      if (module.id !== "queues") return true;
      const queueIds = Array.isArray(aggregate.desiredConfig?.queueIds) ? aggregate.desiredConfig.queueIds : [];
      return queueIds.length > 0 && queueIds.includes(aggregate.desiredConfig?.defaultQueueId);
    });
    return complete ? "configured" : "configuration_required";
  }
  if (!resources.length) return "deployment_required";
  const status = highestPriorityStatus(resources);
  if (["error", "missing", "drifted", "unknown"].includes(status)) return status;
  if (["creating", "updating"].includes(status)) return "reconciling";
  return "deployed";
}

export async function startAdminInventorySync(organizationId) {
  const id = randomUUID();
  await getPostgresPool().query(
    `INSERT INTO integration_inventory_sync_runs
      (id, genesys_organization_id, status)
     VALUES ($1,$2,'running')`,
    [id, required(organizationId, "Genesys organization ID")]
  );
  return id;
}

export async function finishAdminInventorySync(id, { status, summary = {}, error = null }) {
  await getPostgresPool().query(
    `UPDATE integration_inventory_sync_runs
     SET status=$2, summary=$3::jsonb, error=$4, completed_at=NOW()
     WHERE id=$1`,
    [required(id, "Inventory sync run ID"), status, JSON.stringify(summary || {}), error]
  );
}

export async function syncAdminDashboardObservedInventory({
  organizationId,
  ttsDeployments = [],
  ttsFlows = [],
  audioManifests = [],
  widgetManifests = [],
  widgetInfrastructureManifest = null,
}) {
  const organization = required(organizationId, "Genesys organization ID");
  const syncStartedAt = new Date().toISOString();
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    // Only the live organization-scoped TTS inventory participates in
    // missing detection here. A missing local Audio/Web manifest must not
    // mutate the database-owned lifecycle of deployment-registered rows.
    const observedKinds = ["tts"];
    const observedAggregateResult = await client.query(
      `SELECT id FROM integration_configuration_aggregates
       WHERE genesys_organization_id=$1
         AND kind=ANY($2::text[])`,
      [organization, observedKinds]
    );
    const ensureAggregate = async (
      kind,
      name,
      desiredConfig = {},
      { scopeType = "installation" } = {}
    ) => {
      const result = await client.query(
        `INSERT INTO integration_configuration_aggregates
          (id, genesys_organization_id, kind, name, enabled, desired_config, scope_type)
         VALUES ($1,$2,$3,$4,TRUE,$5::jsonb,$6)
         ON CONFLICT (genesys_organization_id, kind, name)
         DO UPDATE SET enabled=TRUE,
           scope_type=EXCLUDED.scope_type,
           desired_config=CASE
             WHEN EXCLUDED.scope_type='organization' THEN EXCLUDED.desired_config
             ELSE integration_configuration_aggregates.desired_config
           END,
           updated_at=NOW()
         RETURNING id`,
        [randomUUID(), organization, kind, name, JSON.stringify(desiredConfig), scopeType]
      );
      return result.rows[0].id;
    };
    const saveResource = async ({ aggregateId, provider, resourceType, remoteId, displayName, observed = {} }) => {
      if (!String(remoteId || "").trim()) return null;
      const snapshot = JSON.stringify({ id: String(remoteId), name: displayName || remoteId, ...observed });
      const result = await client.query(
        `INSERT INTO integration_managed_resources
          (id, aggregate_id, provider, resource_type, remote_id, display_name,
           observed_hash, status, observed_config, metadata, last_observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,md5($7),'healthy',$7::jsonb,
           '{"source":"inventory_sync"}'::jsonb,NOW())
         ON CONFLICT (provider, remote_id)
         DO UPDATE SET aggregate_id=EXCLUDED.aggregate_id,
           resource_type=EXCLUDED.resource_type, display_name=EXCLUDED.display_name,
           observed_hash=EXCLUDED.observed_hash, status='healthy',
           observed_config=EXCLUDED.observed_config,
           metadata=integration_managed_resources.metadata || EXCLUDED.metadata,
           updated_at=NOW(), last_observed_at=NOW()
         RETURNING id`,
        [randomUUID(), aggregateId, provider, resourceType, String(remoteId),
          String(displayName || remoteId), snapshot]
      );
      return result.rows[0].id;
    };
    // Deployment manifests are recovery artifacts, not the resource registry.
    // They may refresh a resource that is already tracked by this installation,
    // but must never recreate a row removed through Danger Zone (or after a DB reset).
    const refreshTrackedResource = async ({
      provider,
      resourceType,
      remoteId,
      displayName,
      observed = {},
      aggregateKinds,
    }) => {
      if (!String(remoteId || "").trim()) return null;
      const snapshot = JSON.stringify({ id: String(remoteId), name: displayName || remoteId, ...observed });
      const result = await client.query(
        `UPDATE integration_managed_resources resource
         SET display_name=COALESCE($5, resource.display_name),
             observed_hash=md5($6), status='healthy',
             observed_config=$6::jsonb, updated_at=NOW(), last_observed_at=NOW()
         FROM integration_configuration_aggregates aggregate
         WHERE resource.aggregate_id=aggregate.id
           AND aggregate.genesys_organization_id=$1
           AND aggregate.kind=ANY($2::text[])
           AND resource.provider=$3
           AND resource.remote_id=$4
           AND resource.resource_type=$7
           AND resource.deleted_at IS NULL
           AND resource.status <> 'retired'
         RETURNING resource.id, resource.aggregate_id`,
        [
          organization,
          aggregateKinds,
          provider,
          String(remoteId),
          String(displayName || remoteId),
          snapshot,
          resourceType,
        ]
      );
      return result.rows[0] || null;
    };
    const syncedAggregateIds = observedAggregateResult.rows.map((row) => row.id);
    const syncedResourceIds = new Set();
    const dependencyRows = [];
    const sharedTtsDeployments = ttsDeployments.filter((entry) => entry.managed === true);
    const externalTtsIds = ttsDeployments
      .filter((entry) => entry.managed !== true)
      .map((entry) => String(entry.integrationId || "").trim())
      .filter(Boolean);
    if (externalTtsIds.length) {
      await client.query(
        `UPDATE integration_managed_resources resource
         SET status='retired', updated_at=NOW()
         FROM integration_configuration_aggregates aggregate
         WHERE resource.aggregate_id=aggregate.id
           AND aggregate.genesys_organization_id=$1
           AND aggregate.kind='tts'
           AND resource.provider='genesys'
           AND resource.remote_id=ANY($2::text[])`,
        [organization, externalTtsIds]
      );
    }
    if (sharedTtsDeployments.length || ttsFlows.length) {
      const ttsAggregateId = await ensureAggregate("tts", "default", {
        profiles: sharedTtsDeployments.map((entry) => entry.profileId),
        source: "genesys_inventory",
      }, { scopeType: "organization" });
      syncedAggregateIds.push(ttsAggregateId);
      const connectorByIntegration = new Map();
      const credentialById = new Map();
      for (const deployment of sharedTtsDeployments) {
        if (deployment.credentialId && !credentialById.has(deployment.credentialId)) {
          const credentialResourceId = await saveResource({
            aggregateId: ttsAggregateId,
            provider: "genesys",
            resourceType: "integration_credential",
            remoteId: deployment.credentialId,
            displayName: deployment.credentialName || deployment.credentialId,
            observed: { sharedByProfiles: sharedTtsDeployments
              .filter((entry) => entry.credentialId === deployment.credentialId)
              .map((entry) => entry.profileId) },
          });
          if (credentialResourceId) {
            credentialById.set(deployment.credentialId, credentialResourceId);
            syncedResourceIds.add(credentialResourceId);
          }
        }
        const id = await saveResource({
          aggregateId: ttsAggregateId,
          provider: "genesys",
          resourceType: "tts_connector",
          remoteId: deployment.integrationId,
          displayName: deployment.name,
          observed: { profileId: deployment.profileId, active: deployment.active, healthy: deployment.healthy },
        });
        if (id) {
          syncedResourceIds.add(id);
          connectorByIntegration.set(deployment.integrationId, id);
          const credentialResourceId = credentialById.get(deployment.credentialId);
          if (credentialResourceId) dependencyRows.push([id, credentialResourceId, "uses_credential"]);
        }
      }
      for (const flow of ttsFlows) {
        const flowId = await saveResource({
          aggregateId: ttsAggregateId,
          provider: "genesys",
          resourceType: "architect_tts_test_flow",
          remoteId: flow.id,
          displayName: flow.name,
          observed: { integrationId: flow.integrationId, version: flow.version },
        });
        const connectorId = connectorByIntegration.get(flow.integrationId);
        if (flowId) syncedResourceIds.add(flowId);
        if (flowId && connectorId) dependencyRows.push([flowId, connectorId, "tests_connector"]);
      }
    }
    for (const manifest of audioManifests) {
      const resources = manifest?.resources || {};
      const names = manifest?.resourceNames || {};
      const applicationName = String(
        manifest?.deployment?.applicationName ||
        manifest?.deployment?.name ||
        installationResourceNames().installationName
      ).trim();
      const connector = await refreshTrackedResource({ provider: "genesys", resourceType: "audio_connector", remoteId: resources.audioConnectorIntegrationId, displayName: applicationName, aggregateKinds: ["audio_connector"] });
      const widget = await refreshTrackedResource({ provider: "genesys", resourceType: "interaction_widget", remoteId: resources.widgetId, displayName: names.widgetName || applicationName, aggregateKinds: ["agent_experience"] });
      const script = await refreshTrackedResource({ provider: "genesys", resourceType: "architect_script", remoteId: resources.scriptId, displayName: names.handoffScriptName || applicationName, aggregateKinds: ["agent_experience"] });
      const flow = await refreshTrackedResource({ provider: "genesys", resourceType: "architect_inbound_flow", remoteId: resources.flowId, displayName: names.flowName || applicationName, aggregateKinds: ["audio_routing"] });
      const callRoute = await refreshTrackedResource({ provider: "genesys", resourceType: "inbound_call_route", remoteId: resources.callRouteId, displayName: names.callRouteName || applicationName, aggregateKinds: ["audio_routing"] });
      const [connectorId, widgetId, scriptId, flowId, callRouteId] = [connector, widget, script, flow, callRoute].map((entry) => entry?.id || null);
      [connector, widget, script, flow, callRoute].filter(Boolean).forEach((entry) => {
        syncedResourceIds.add(entry.id);
      });
      if (flowId && connectorId) dependencyRows.push([flowId, connectorId, "invokes_connector"]);
      if (callRouteId && flowId) dependencyRows.push([callRouteId, flowId, "routes_to_flow"]);
      if (widgetId && scriptId) dependencyRows.push([widgetId, scriptId, "uses_script"]);
      const remoteAssistantIds = [...new Set((manifest?.architect?.routes || [])
        .map((route) => String(route?.assistantId || "").trim()).filter(Boolean))];
      if (flowId && remoteAssistantIds.length) {
        const assistantResources = await client.query(
          `SELECT id FROM integration_managed_resources
           WHERE provider='telnyx' AND resource_type='ai_assistant'
             AND remote_id=ANY($1::text[])`,
          [remoteAssistantIds]
        );
        assistantResources.rows.forEach((assistant) => dependencyRows.push([flowId, assistant.id, "routes_to_assistant"]));
      }
    }
    if (widgetInfrastructureManifest) {
      const resources = widgetInfrastructureManifest.resources || {};
      const names = widgetInfrastructureManifest.resourceNames || {};
      const interactionWidget = await refreshTrackedResource({
        provider: "genesys",
        resourceType: "interaction_widget",
        remoteId: resources.interactionWidgetId,
        displayName: names.interactionWidget || widgetInfrastructureManifest.deployment?.name,
        aggregateKinds: ["agent_experience"],
      });
      const handoffScript = await refreshTrackedResource({
        provider: "genesys",
        resourceType: "architect_script",
        remoteId: resources.scriptId,
        displayName: names.handoffScript || widgetInfrastructureManifest.deployment?.name,
        aggregateKinds: ["agent_experience"],
      });
      [interactionWidget, handoffScript].filter(Boolean).forEach((entry) => {
        syncedResourceIds.add(entry.id);
      });
      if (interactionWidget?.id && handoffScript?.id) {
        dependencyRows.push([interactionWidget.id, handoffScript.id, "uses_script"]);
      }
    }
    for (const manifest of widgetManifests) {
      const resources = manifest?.resources || {};
      const names = manifest?.resourceNames || {};
      const messageFlow = await refreshTrackedResource({ provider: "genesys", resourceType: "architect_inbound_message_flow", remoteId: resources.messageFlowId, displayName: manifest?.messaging?.routingFlow?.name || names.messageFlowName || resources.messageFlowId, aggregateKinds: ["messaging_profile"] });
      const openMessaging = await refreshTrackedResource({ provider: "genesys", resourceType: "open_messaging_integration", remoteId: resources.openMessagingIntegrationId, displayName: names.openMessagingIntegration || manifest?.deployment?.name, aggregateKinds: ["messaging_profile"] });
      const clientApplication = await refreshTrackedResource({ provider: "genesys", resourceType: "client_application", remoteId: resources.clientAppIntegrationId, displayName: names.clientAppIntegration || manifest?.deployment?.name, aggregateKinds: ["messaging_profile"] });
      const oauthClient = await refreshTrackedResource({ provider: "genesys", resourceType: "oauth_client", remoteId: resources.oauthClientId, displayName: names.oauthClient || manifest?.deployment?.name, aggregateKinds: ["messaging_profile"] });
      const [messageFlowId, openMessagingId] = [messageFlow, openMessaging].map((entry) => entry?.id || null);
      [messageFlow, openMessaging, clientApplication, oauthClient].filter(Boolean).forEach((entry) => {
        syncedResourceIds.add(entry.id);
      });
      if (openMessagingId && messageFlowId) dependencyRows.push([openMessagingId, messageFlowId, "routes_to_flow"]);
      if (manifest?.voice?.enabled) {
        const voiceFlow = await refreshTrackedResource({ provider: "genesys", resourceType: "architect_inbound_flow", remoteId: resources.voiceFlowId, displayName: names.voiceFlow || resources.voiceFlowId, aggregateKinds: ["voice_profile"] });
        const voiceIvr = await refreshTrackedResource({ provider: "genesys", resourceType: "inbound_call_route", remoteId: resources.voiceIvrId, displayName: names.voiceIvr || resources.voiceIvrId, aggregateKinds: ["voice_profile"] });
        const voiceScript = await refreshTrackedResource({ provider: "genesys", resourceType: "architect_script", remoteId: resources.genesysHandoffScriptId, displayName: names.genesysHandoffScript || manifest?.deployment?.name, aggregateKinds: ["voice_profile"] });
        const voiceWidget = await refreshTrackedResource({ provider: "genesys", resourceType: "interaction_widget", remoteId: resources.genesysAgentWidgetIntegrationId, displayName: names.genesysAgentWidget || manifest?.deployment?.name, aggregateKinds: ["voice_profile"] });
        const didPool = await refreshTrackedResource({ provider: "genesys", resourceType: "did_pool", remoteId: resources.voiceDidPoolId, displayName: resources.voiceDid || resources.voiceDidPoolId, aggregateKinds: ["voice_profile"] });
        const [voiceFlowId, voiceIvrId, scriptId, widgetId] = [voiceFlow, voiceIvr, voiceScript, voiceWidget].map((entry) => entry?.id || null);
        [voiceFlow, voiceIvr, voiceScript, voiceWidget, didPool].filter(Boolean).forEach((entry) => {
          syncedResourceIds.add(entry.id);
        });
        if (voiceIvrId && voiceFlowId) dependencyRows.push([voiceIvrId, voiceFlowId, "routes_to_flow"]);
        if (widgetId && scriptId) dependencyRows.push([widgetId, scriptId, "uses_script"]);
      }
    }
    const uniqueAggregateIds = [...new Set(syncedAggregateIds)];
    if (uniqueAggregateIds.length) {
      await client.query(
        `UPDATE integration_managed_resources
         SET status='missing', updated_at=NOW()
         WHERE aggregate_id=ANY($1::uuid[])
           AND metadata->>'source'='inventory_sync'
           AND status <> 'retired'
           AND last_observed_at < $2::timestamptz`,
        [uniqueAggregateIds, syncStartedAt]
      );
      await client.query(
        `DELETE FROM integration_resource_dependencies
         WHERE resource_id IN (
           SELECT id FROM integration_managed_resources
           WHERE aggregate_id=ANY($1::uuid[])
             AND metadata->>'source'='inventory_sync'
         )`,
        [uniqueAggregateIds]
      );
    }
    for (const [resourceId, dependencyId, relationship] of dependencyRows) {
      await client.query(
        `INSERT INTO integration_resource_dependencies
          (resource_id, depends_on_resource_id, relationship)
         VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [resourceId, dependencyId, relationship]
      );
    }
    await client.query("COMMIT");
    return { resources: syncedResourceIds.size, aggregates: uniqueAggregateIds.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getAdminDashboardOverview(organizationId) {
  const organization = required(organizationId, "Genesys organization ID");
  const pool = getPostgresPool();
  const [aggregateResult, resourceResult, dependencyResult, syncResult, assistantResult] = await Promise.all([
    pool.query(
      `SELECT id, kind, name, enabled, desired_revision, desired_config,
              scope_type, updated_at
       FROM integration_configuration_aggregates
       WHERE genesys_organization_id=$1 AND enabled=TRUE
       ORDER BY kind, name`,
      [organization]
    ),
    pool.query(
      `SELECT r.id, r.aggregate_id, a.kind AS aggregate_kind, a.name AS aggregate_name,
              r.provider, r.resource_type, r.remote_id, r.display_name,
              r.desired_hash, r.observed_hash, r.status,
              r.last_observed_at, r.updated_at
       FROM integration_managed_resources r
       JOIN integration_configuration_aggregates a ON a.id=r.aggregate_id
       WHERE a.genesys_organization_id=$1 AND a.enabled=TRUE AND r.status <> 'retired'
       ORDER BY a.kind, r.provider, r.resource_type, r.display_name, r.remote_id`,
      [organization]
    ),
    pool.query(
      `SELECT d.resource_id, d.depends_on_resource_id, d.relationship
       FROM integration_resource_dependencies d
       JOIN integration_managed_resources source ON source.id=d.resource_id
       JOIN integration_configuration_aggregates a ON a.id=source.aggregate_id
       WHERE a.genesys_organization_id=$1
       ORDER BY d.relationship, d.resource_id, d.depends_on_resource_id`,
      [organization]
    ),
    pool.query(
      `SELECT status, summary, error, started_at, completed_at
       FROM integration_inventory_sync_runs
       WHERE genesys_organization_id=$1
       ORDER BY started_at DESC LIMIT 1`,
      [organization]
    ),
    pool.query(
      `SELECT aa.aggregate_id, aa.telnyx_assistant_id,
              EXISTS (
                SELECT 1
                FROM integration_audio_dnis_routes dr
                JOIN integration_configuration_aggregates route_aggregate
                  ON route_aggregate.id=dr.aggregate_id
                WHERE dr.assistant_id=aa.id
                  AND route_aggregate.genesys_organization_id=$1
                  AND route_aggregate.enabled=TRUE
              ) AS has_dnis_route,
              EXISTS (
                SELECT 1
                FROM integration_ai_tool_assignments assignment
                JOIN integration_ai_tool_definitions tool
                  ON tool.id=assignment.tool_definition_id
                JOIN integration_configuration_aggregates tool_aggregate
                  ON tool_aggregate.id=tool.aggregate_id
                WHERE assignment.remote_assistant_id=aa.telnyx_assistant_id
                  AND assignment.status='active'
                  AND tool.status <> 'retired'
                  AND tool_aggregate.genesys_organization_id=$1
                  AND tool_aggregate.enabled=TRUE
              ) AS has_active_tool_assignment
       FROM integration_ai_assistants aa
       JOIN integration_configuration_aggregates aggregate
         ON aggregate.id=aa.aggregate_id
       WHERE aggregate.genesys_organization_id=$1
         AND aggregate.enabled=TRUE
       ORDER BY aa.telnyx_assistant_id`,
      [organization]
    ),
  ]);
  const managedAssistantRows = assistantResult.rows.filter(adminDashboardAssistantIsManaged);
  const managedAssistantIds = new Set(managedAssistantRows.map((row) => row.telnyx_assistant_id));
  const managedAssistantAggregateIds = new Set(managedAssistantRows.map((row) => row.aggregate_id));
  const aggregates = aggregateResult.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    scopeType: row.scope_type || "installation",
    desiredRevision: row.desired_revision,
    desiredConfig: row.desired_config || {},
    updatedAt: row.updated_at,
  }));
  const aggregateScopeById = new Map(
    aggregates.map((aggregate) => [aggregate.id, aggregate.scopeType])
  );
  const moduleByKind = new Map(MODULES.flatMap((module) => module.kinds.map((kind) => [kind, module.id])));
  const dependenciesByResource = new Map();
  for (const row of dependencyResult.rows) {
    const entries = dependenciesByResource.get(row.resource_id) || [];
    entries.push({ resourceId: row.depends_on_resource_id, relationship: row.relationship });
    dependenciesByResource.set(row.resource_id, entries);
  }
  const observedResources = resourceResult.rows.map((row) => ({
    id: row.id,
    aggregateId: row.aggregate_id,
    aggregateKind: row.aggregate_kind,
    aggregateName: row.aggregate_name,
    aggregateScope: aggregateScopeById.get(row.aggregate_id) || "installation",
    moduleId: moduleByKind.get(row.aggregate_kind) || "other",
    provider: row.provider,
    resourceType: row.resource_type,
    remoteId: row.remote_id,
    displayName: row.display_name || row.remote_id,
    status: adminDashboardResourceStatus(row),
    hasDesiredSnapshot: Boolean(row.desired_hash),
    hasObservedSnapshot: Boolean(row.observed_hash),
    dependencies: dependenciesByResource.get(row.id) || [],
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at,
  }));
  const resources = observedResources.filter((resource) =>
    resource.resourceType !== "ai_assistant" || managedAssistantIds.has(resource.remoteId)
  );
  const visibleAggregates = aggregates.filter((aggregate) =>
    aggregate.kind !== "assistant" || managedAssistantAggregateIds.has(aggregate.id)
  );
  const installationAggregates = visibleAggregates.filter(
    (aggregate) => aggregate.scopeType === "installation"
  );
  const installationResources = resources.filter(
    (resource) => resource.aggregateScope === "installation"
  );
  const sharedResources = resources.filter(
    (resource) => resource.aggregateScope === "organization"
  );
  const modules = MODULES.map((module) => {
    const moduleAggregates = visibleAggregates.filter((aggregate) =>
      module.kinds.includes(aggregate.kind) &&
      aggregate.scopeType === (module.scopeType || "installation")
    );
    const aggregateIds = new Set(moduleAggregates.map((aggregate) => aggregate.id));
    const moduleResources = resources.filter((resource) => aggregateIds.has(resource.aggregateId));
    const counts = Object.fromEntries([...new Set(moduleResources.map((resource) => resource.status))]
      .map((status) => [status, moduleResources.filter((resource) => resource.status === status).length]));
    return {
      id: module.id,
      label: module.label,
      target: module.target,
      section: module.section,
      scopeType: module.scopeType || "installation",
      configured: Boolean(moduleAggregates.length),
      desiredObjects: module.scopeType === "organization" ? 0 : moduleAggregates.length,
      desiredRevision: module.scopeType === "organization"
        ? 0
        : Math.max(0, ...moduleAggregates.map((aggregate) => aggregate.desiredRevision || 0)),
      observedResources: moduleResources.length,
      state: adminDashboardModuleState(module, moduleAggregates, moduleResources),
      statusCounts: counts,
      ...(module.scopeType === "organization" ? {
        sharedCounts: {
          connectors: moduleResources.filter((resource) => resource.resourceType === "tts_connector").length,
          testFlows: moduleResources.filter(
            (resource) => resource.resourceType === "architect_tts_test_flow"
          ).length,
        },
      } : {}),
      ...(module.id === "assistants" ? {
        assistantCounts: {
          all: assistantResult.rows.length,
          managed: managedAssistantRows.length,
        },
      } : {}),
      updatedAt: moduleAggregates.map((aggregate) => aggregate.updatedAt).filter(Boolean).sort().at(-1) || null,
    };
  });
  const attentionStatuses = new Set(["missing", "drifted", "error", "unknown"]);
  const attentionResources = resources.filter((resource) => attentionStatuses.has(resource.status));
  const installationResourceIds = new Set(installationResources.map((resource) => resource.id));
  const sharedResourceIds = new Set(sharedResources.map((resource) => resource.id));
  const installationDependencies = dependencyResult.rows.filter((dependency) =>
    installationResourceIds.has(dependency.resource_id) &&
    installationResourceIds.has(dependency.depends_on_resource_id)
  );
  const sharedDependencies = dependencyResult.rows.filter((dependency) =>
    sharedResourceIds.has(dependency.resource_id) &&
    sharedResourceIds.has(dependency.depends_on_resource_id)
  );
  const latestSync = syncResult.rows[0] ? {
    status: syncResult.rows[0].status,
    summary: syncResult.rows[0].summary || {},
    error: syncResult.rows[0].error || null,
    startedAt: syncResult.rows[0].started_at,
    completedAt: syncResult.rows[0].completed_at,
  } : null;
  return {
    summary: {
      desiredObjects: installationAggregates.length,
      managedResources: installationResources.length,
      sharedResources: sharedResources.length,
      healthyResources: resources.filter((resource) => resource.status === "healthy").length,
      attentionResources: attentionResources.length,
      dependencies: installationDependencies.length,
      sharedDependencies: sharedDependencies.length,
    },
    modules,
    latestSync,
    generatedAt: new Date().toISOString(),
  };
}
