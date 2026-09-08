import { randomUUID } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";

export const ADMIN_COMPONENTS = Object.freeze(["tts", "audio", "callbacks", "widget"]);
const ADMIN_RUN_COMPONENTS = Object.freeze([...ADMIN_COMPONENTS, "settings"]);

function assertComponent(component) {
  const value = String(component || "").trim().toLowerCase();
  if (!ADMIN_COMPONENTS.includes(value)) throw new Error(`Unsupported admin component ${component}`);
  return value;
}

function assertRunComponent(component) {
  const value = String(component || "").trim().toLowerCase();
  if (!ADMIN_RUN_COMPONENTS.includes(value)) throw new Error(`Unsupported admin run component ${component}`);
  return value;
}

function mapComponent(row, component) {
  return {
    component,
    enabled: row?.enabled === true,
    config: row?.config || {},
    updatedAt: row?.updated_at || null,
  };
}

function mapRun(row, steps = []) {
  if (!row) return null;
  return {
    id: row.id,
    component: row.component,
    status: row.status,
    config: row.config,
    plan: row.plan,
    installerPlanPath: row.installer_plan_path,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    steps: steps.map((step) => ({
      ordinal: step.ordinal,
      label: step.label,
      status: step.status,
      detail: step.detail,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
  };
}

export async function getAdminUserPreferences(actor) {
  const result = await getPostgresPool().query(
    `SELECT theme FROM integration_user_preferences
     WHERE genesys_organization_id=$1 AND genesys_user_id=$2`,
    [actor.organizationId, actor.userId]
  );
  return { theme: result.rows[0]?.theme || "light" };
}

export async function saveAdminUserPreferences(actor, { theme }) {
  if (!['light', 'dark', 'system'].includes(theme)) throw new Error("theme must be light, dark, or system");
  await getPostgresPool().query(
    `INSERT INTO integration_user_preferences
      (genesys_organization_id, genesys_user_id, theme)
     VALUES ($1,$2,$3)
     ON CONFLICT (genesys_organization_id, genesys_user_id)
     DO UPDATE SET theme=EXCLUDED.theme, updated_at=NOW()`,
    [actor.organizationId, actor.userId, theme]
  );
  return { theme };
}

export async function listAdminComponentConfigs(organizationId) {
  const result = await getPostgresPool().query(
    `SELECT * FROM integration_deployment_profiles
     WHERE genesys_organization_id=$1`,
    [organizationId]
  );
  const byComponent = new Map(result.rows.map((row) => [row.component, row]));
  return ADMIN_COMPONENTS.map((component) => mapComponent(byComponent.get(component), component));
}

export async function getAdminInventoryCache(organizationId) {
  const result = await getPostgresPool().query(
    `SELECT inventory, refreshed_at FROM integration_inventory_snapshots
     WHERE genesys_organization_id=$1`,
    [organizationId]
  );
  if (!result.rowCount) return null;
  return {
    ...(result.rows[0].inventory || {}),
    cachedAt: result.rows[0].refreshed_at,
  };
}

export async function saveAdminInventoryCache(organizationId, inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("inventory must be an object");
  }
  const result = await getPostgresPool().query(
    `INSERT INTO integration_inventory_snapshots
      (genesys_organization_id, inventory, refreshed_at)
     VALUES ($1,$2::jsonb,NOW())
     ON CONFLICT (genesys_organization_id)
     DO UPDATE SET inventory=EXCLUDED.inventory, refreshed_at=NOW()
     RETURNING refreshed_at`,
    [organizationId, JSON.stringify(inventory)]
  );
  return result.rows[0]?.refreshed_at || null;
}

export async function getAdminAudioQueuePolicy(organizationId = process.env.GC_ORGANIZATION_ID) {
  const id = String(organizationId || "").trim();
  if (!id) return null;
  const deployed = await getPostgresPool().query(
    `SELECT config, plan->>'operation' AS operation
     FROM integration_deployment_runs
     WHERE genesys_organization_id=$1 AND component='audio' AND status='succeeded'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [id]
  );
  if (deployed.rowCount && deployed.rows[0].operation === "destroy") return null;
  let config = deployed.rows[0]?.config || null;
  if (!config) {
    const legacy = await getPostgresPool().query(
      `SELECT config FROM integration_deployment_profiles
       WHERE genesys_organization_id=$1 AND component='audio'`,
      [id]
    );
    config = legacy.rows[0]?.config || {};
  }
  const queues = Array.isArray(config.allowedQueues) ? config.allowedQueues : [];
  const defaultQueue = queues.find(({ id: queueId }) => queueId === config.defaultQueueId) ||
    (config.defaultQueueName ? { id: config.defaultQueueId || "", name: config.defaultQueueName } : null);
  return { queues, defaultQueue };
}

export async function getAdminCallbacksConfig(organizationId) {
  const id = String(organizationId || "").trim();
  if (!id) return null;
  const result = await getPostgresPool().query(
    `SELECT c.enabled, r.config
     FROM integration_deployment_profiles c
     JOIN LATERAL (
       SELECT config
       FROM integration_deployment_runs
       WHERE genesys_organization_id=c.genesys_organization_id
         AND component='callbacks'
         AND status='succeeded'
         AND result ? 'contactList'
         AND result ? 'flow'
         AND result ? 'campaign'
       ORDER BY completed_at DESC NULLS LAST, created_at DESC
       LIMIT 1
     ) r ON TRUE
     WHERE c.genesys_organization_id=$1
       AND c.component='callbacks'
       AND c.enabled=TRUE`,
    [id]
  );
  if (!result.rowCount) return null;
  return result.rows[0].config || null;
}

// The WebRTC caller identity is desired state owned by the Web Calls admin page,
// so the widget runtime reads it from that profile rather than the environment.
export async function getAdminWebCallerNumber(organizationId) {
  const id = String(organizationId || "").trim();
  if (!id) return "";
  const result = await getPostgresPool().query(
    `SELECT cp.config->>'callerNumber' AS caller_number
     FROM integration_widget_channel_profiles cp
     JOIN integration_configuration_aggregates a ON a.id=cp.aggregate_id
     WHERE a.genesys_organization_id=$1 AND a.enabled=TRUE AND cp.channel='voice'
     LIMIT 1`,
    [id]
  );
  return String(result.rows[0]?.caller_number || "").trim();
}

export async function getLatestSuccessfulAdminDeploymentResult(organizationId, component) {
  const normalizedComponent = assertRunComponent(component);
  const normalizedOrganizationId = String(organizationId || "").trim();
  if (!normalizedOrganizationId) throw new Error("Genesys organization ID is required");
  const result = await getPostgresPool().query(
    `SELECT result, completed_at
     FROM integration_deployment_runs
     WHERE genesys_organization_id=$1 AND component=$2 AND status='succeeded'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [normalizedOrganizationId, normalizedComponent]
  );
  if (!result.rowCount) return null;
  return { result: result.rows[0].result || {}, completedAt: result.rows[0].completed_at || null };
}

export async function saveAdminComponentConfig({ actor, component, enabled, config }) {
  const normalizedComponent = assertComponent(component);
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config must be an object");
  }
  const result = await getPostgresPool().query(
    `INSERT INTO integration_deployment_profiles
      (id, genesys_organization_id, component, enabled, config, updated_by_genesys_user_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (genesys_organization_id, component)
     DO UPDATE SET enabled=EXCLUDED.enabled, config=EXCLUDED.config,
       updated_by_genesys_user_id=EXCLUDED.updated_by_genesys_user_id, updated_at=NOW()
     RETURNING *`,
    [randomUUID(), actor.organizationId, normalizedComponent, enabled, JSON.stringify(config), actor.userId]
  );
  return mapComponent(result.rows[0], normalizedComponent);
}

export async function disableAdminComponentAndDiscardPlans({ actor, component, config }) {
  const normalizedComponent = assertComponent(component);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config must be an object");
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const running = await client.query(
      `SELECT id FROM integration_deployment_runs
       WHERE genesys_organization_id=$1 AND component=$2 AND status='running'
       LIMIT 1`,
      [actor.organizationId, normalizedComponent]
    );
    if (running.rowCount) {
      throw new Error("Cannot disable a component while its deployment is running");
    }
    const saved = await client.query(
      `INSERT INTO integration_deployment_profiles
        (id, genesys_organization_id, component, enabled, config, updated_by_genesys_user_id)
       VALUES ($1,$2,$3,FALSE,$4::jsonb,$5)
       ON CONFLICT (genesys_organization_id, component)
       DO UPDATE SET enabled=FALSE, config=EXCLUDED.config,
         updated_by_genesys_user_id=EXCLUDED.updated_by_genesys_user_id, updated_at=NOW()
       RETURNING *`,
      [randomUUID(), actor.organizationId, normalizedComponent, JSON.stringify(config), actor.userId]
    );
    const discarded = await client.query(
      `DELETE FROM integration_deployment_runs
       WHERE genesys_organization_id=$1 AND component=$2 AND status='planned'`,
      [actor.organizationId, normalizedComponent]
    );
    await client.query("COMMIT");
    return {
      component: mapComponent(saved.rows[0], normalizedComponent),
      discardedPlanCount: discarded.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createAdminDeploymentRun({ actor, component, config, plan, steps, installerPlanPath }) {
  const normalizedComponent = assertRunComponent(component);
  const client = await getPostgresPool().connect();
  const runId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO integration_deployment_runs
        (id, genesys_organization_id, component, status, config, plan,
         installer_plan_path, created_by_genesys_user_id)
       VALUES ($1,$2,$3,'planned',$4::jsonb,$5::jsonb,$6,$7)`,
      [
        runId,
        actor.organizationId,
        normalizedComponent,
        JSON.stringify(config),
        JSON.stringify(plan),
        installerPlanPath,
        actor.userId,
      ]
    );
    for (const [ordinal, label] of steps.entries()) {
      await client.query(
        `INSERT INTO integration_deployment_steps(run_id, ordinal, label, status)
         VALUES ($1,$2,$3,'pending')`,
        [runId, ordinal, label]
      );
    }
    await client.query("COMMIT");
    return getAdminDeploymentRun(runId, actor.organizationId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getAdminDeploymentRun(id, organizationId) {
  const runResult = await getPostgresPool().query(
    `SELECT * FROM integration_deployment_runs
     WHERE id=$1 AND genesys_organization_id=$2`,
    [id, organizationId]
  );
  if (!runResult.rowCount) return null;
  const steps = await getPostgresPool().query(
    `SELECT * FROM integration_deployment_steps WHERE run_id=$1 ORDER BY ordinal`,
    [id]
  );
  return mapRun(runResult.rows[0], steps.rows);
}

export async function startAdminDeploymentRun(id, installerPlanPath = null) {
  const result = await getPostgresPool().query(
    `UPDATE integration_deployment_runs
     SET status='running', started_at=NOW(), installer_plan_path=COALESCE($2, installer_plan_path)
     WHERE id=$1 AND status='planned'
     RETURNING id`,
    [id, installerPlanPath]
  );
  return result.rowCount === 1;
}

export async function updateAdminDeploymentStep(id, ordinal, status, detail = null) {
  await getPostgresPool().query(
    `UPDATE integration_deployment_steps SET status=$3, detail=$4,
       started_at=CASE WHEN $3='running' THEN COALESCE(started_at,NOW()) ELSE started_at END,
       completed_at=CASE WHEN $3 IN ('succeeded','failed','skipped') THEN NOW() ELSE completed_at END
     WHERE run_id=$1 AND ordinal=$2`,
    [id, ordinal, status, detail]
  );
}

export async function finishAdminDeploymentRun(id, { status, result = null, error = null }) {
  if (!['succeeded', 'failed', 'cancelled'].includes(status)) {
    throw new Error(`Invalid terminal deployment status ${status}`);
  }
  await getPostgresPool().query(
    `UPDATE integration_deployment_runs
     SET status=$2, result=$3::jsonb, error=$4, completed_at=NOW() WHERE id=$1`,
    [id, status, result ? JSON.stringify(result) : null, error]
  );
}
