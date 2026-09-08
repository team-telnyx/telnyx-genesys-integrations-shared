import { randomBytes, randomUUID } from "node:crypto";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  applyWidgetInfrastructure,
  assertPublishableWidgetConfig,
  DEFAULT_WIDGET_CONFIG,
  parseWidgetConfig,
  parseWidgetConfigIfCurrent,
} from "./config.js";
import { copyWidgetPreviewAssets, widgetPreviewAssetUrl } from "./preview-assets.js";
import { installationScope } from "@/lib/genesys/installation-scope.mjs";
import {
  assertWidgetNameIsNotReserved,
  normalizedManagedNameKey,
} from "@/lib/genesys/resource-naming.mjs";

export class WidgetNameConflictError extends Error {
  constructor(name) {
    super(`A widget named ${name} already exists in this deployment`);
    this.name = "WidgetNameConflictError";
    this.status = 409;
  }
}

function widgetName(value) {
  const name = assertWidgetNameIsNotReserved(value);
  if (name.length > 120) throw new Error("Widget name must contain between 1 and 120 characters");
  return { name, key: normalizedManagedNameKey(name) };
}

function rethrowWidgetConflict(error, name) {
  if (error?.code === "23505" && String(error?.constraint || "").includes("widgets_deployment_name")) {
    throw new WidgetNameConflictError(name);
  }
  throw error;
}

function publicId() {
  return `wgt_${randomBytes(18).toString("base64url")}`;
}

function mapRevision(row, prefix) {
  if (!row?.[`${prefix}_id`]) return null;
  const config = parseWidgetConfigIfCurrent(row[`${prefix}_config`]);
  if (!config) return null;
  return {
    id: row[`${prefix}_id`],
    version: row[`${prefix}_version`],
    config,
  };
}

export function mapWidgetRow(row) {
  if (!row) return null;
  const draft = mapRevision(row, "draft");
  const published = mapRevision(row, "published");
  return {
    id: row.id,
    publicId: row.public_id,
    managedDeploymentId: row.managed_deployment_id || null,
    supportedContentProfileId: row.supported_content_profile_id || null,
    supportedContentProfileName: row.supported_content_profile_name || null,
    openMessagingIntegrationId: row.open_messaging_integration_id || null,
    baseOpenMessagingIntegrationId: row.base_open_messaging_integration_id || null,
    infrastructureFingerprint: row.infrastructure_fingerprint || null,
    infrastructureConfig: row.infrastructure_config || null,
    infrastructureSyncedAt: row.infrastructure_synced_at || null,
    name: row.name,
    installationKey: row.installation_key || null,
    enabled: row.enabled,
    genesysOrganizationId: row.genesys_organization_id,
    publishedRevisionId: published ? row.published_revision_id : null,
    draft,
    published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WIDGET_SELECT = `
  SELECT w.*,
    d.id AS draft_id, d.version AS draft_version, d.config AS draft_config,
    p.id AS published_id, p.version AS published_version, p.config AS published_config
  FROM widgets w
  LEFT JOIN widget_revisions d ON d.widget_id=w.id AND d.state='draft'
  LEFT JOIN widget_revisions p ON p.id=w.published_revision_id
`;

async function audit(client, { widgetId, actor, action, details = {} }) {
  await client.query(
    `INSERT INTO widget_admin_audit_events
      (widget_id, genesys_organization_id, genesys_user_id, action, details)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [widgetId, actor.organizationId || null, actor.userId, action, JSON.stringify(details)]
  );
}

export async function listWidgets(organizationId) {
  const values = [];
  const where = organizationId
    ? "WHERE w.genesys_organization_id=$1 OR w.genesys_organization_id IS NULL"
    : "";
  if (organizationId) values.push(organizationId);
  const result = await getPostgresPool().query(
    `${WIDGET_SELECT} ${where} ORDER BY w.updated_at DESC`,
    values
  );
  return result.rows.map(mapWidgetRow).filter((widget) => widget.draft);
}

export async function getWidget(id, organizationId) {
  const result = await getPostgresPool().query(
    `${WIDGET_SELECT}
     WHERE w.id=$1 AND ($2::text IS NULL OR w.genesys_organization_id=$2 OR w.genesys_organization_id IS NULL)
     LIMIT 1`,
    [id, organizationId || null]
  );
  const widget = mapWidgetRow(result.rows[0]);
  return widget?.draft ? widget : null;
}

export async function createWidget({ name, actor }) {
  const parsed = widgetName(name);
  const installationKey = installationScope().key;

  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const widgetId = randomUUID();
    const revisionId = randomUUID();
    await client.query(
      `INSERT INTO widgets
        (id, public_id, name, normalized_name, installation_key, genesys_organization_id,
         created_by_genesys_user_id, updated_by_genesys_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [widgetId, publicId(), parsed.name, parsed.key, installationKey,
        actor.organizationId || null, actor.userId]
    );
    await client.query(
      `INSERT INTO widget_revisions
        (id, widget_id, version, state, config, created_by_genesys_user_id)
       VALUES ($1,$2,1,'draft',$3::jsonb,$4)`,
      [revisionId, widgetId, JSON.stringify(DEFAULT_WIDGET_CONFIG), actor.userId]
    );
    await audit(client, { widgetId, actor, action: "widget.created" });
    await client.query("COMMIT");
    return getWidget(widgetId, actor.organizationId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    rethrowWidgetConflict(error, parsed.name);
  } finally {
    client.release();
  }
}

export async function cloneWidget({ sourceId, name, actor }) {
  const parsed = widgetName(name);
  const installationKey = installationScope().key;
  const source = await getWidget(sourceId, actor.organizationId);
  if (!source) throw new Error("Source widget not found");

  const client = await getPostgresPool().connect();
  const widgetId = randomUUID();
  try {
    await client.query("BEGIN");
    const revisionId = randomUUID();
    const clonedConfig = structuredClone(source.draft.config);
    const copiedVariants = await copyWidgetPreviewAssets(source.id, widgetId);
    const copied = new Set(copiedVariants);
    for (const [variant, background] of Object.entries(clonedConfig.preview?.backgrounds || {})) {
      if (copied.has(variant) && background.backgroundImageUrl?.startsWith(`/api/admin/widgets/${source.id}/preview-background?`)) {
        background.backgroundImageUrl = widgetPreviewAssetUrl(widgetId, variant);
      }
    }

    await client.query(
      `INSERT INTO widgets
        (id, public_id, name, normalized_name, installation_key, enabled,
         genesys_organization_id, created_by_genesys_user_id, updated_by_genesys_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [widgetId, publicId(), parsed.name, parsed.key, installationKey, source.enabled,
        actor.organizationId || null, actor.userId]
    );
    await client.query(
      `INSERT INTO widget_revisions
        (id, widget_id, version, state, config, created_by_genesys_user_id)
       VALUES ($1,$2,1,'draft',$3::jsonb,$4)`,
      [revisionId, widgetId, JSON.stringify(parseWidgetConfig(clonedConfig)), actor.userId]
    );
    await audit(client, {
      widgetId,
      actor,
      action: "widget.cloned",
      details: { sourceWidgetId: source.id, copiedPreviewVariants: copiedVariants },
    });
    await client.query("COMMIT");
    return getWidget(widgetId, actor.organizationId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    rethrowWidgetConflict(error, parsed.name);
  } finally {
    client.release();
  }
}

export async function updateWidget({ id, name, enabled, actor }) {
  const parsed = widgetName(name);
  const installationKey = installationScope().key;
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");

  let result;
  try {
    result = await getPostgresPool().query(
      `UPDATE widgets SET name=$2, normalized_name=$3, installation_key=$4, enabled=$5,
         updated_by_genesys_user_id=$6, updated_at=NOW()
       WHERE id=$1 AND ($7::text IS NULL OR genesys_organization_id=$7 OR genesys_organization_id IS NULL)
       RETURNING id`,
      [id, parsed.name, parsed.key, installationKey, enabled, actor.userId,
        actor.organizationId || null]
    );
  } catch (error) {
    rethrowWidgetConflict(error, parsed.name);
  }
  if (!result.rowCount) return null;
  await audit(getPostgresPool(), {
    widgetId: id,
    actor,
    action: enabled ? "widget.updated" : "widget.disabled",
    details: { name: parsed.name },
  });
  return getWidget(id, actor.organizationId);
}

export async function updateWidgetDraft({ id, config, actor }) {
  const parsed = parseWidgetConfig(config);
  const result = await getPostgresPool().query(
    `UPDATE widget_revisions r SET config=$2::jsonb
     FROM widgets w
     WHERE r.widget_id=w.id AND r.widget_id=$1 AND r.state='draft'
       AND ($3::text IS NULL OR w.genesys_organization_id=$3 OR w.genesys_organization_id IS NULL)
     RETURNING r.id`,
    [id, JSON.stringify(parsed), actor.organizationId || null]
  );
  if (!result.rowCount) return null;
  await getPostgresPool().query(
    `UPDATE widgets SET updated_by_genesys_user_id=$2, updated_at=NOW() WHERE id=$1`,
    [id, actor.userId]
  );
  await audit(getPostgresPool(), {
    widgetId: id,
    actor,
    action: "widget.draft.updated",
  });
  return getWidget(id, actor.organizationId);
}

export async function publishWidget({
  id,
  actor,
  genesysResources = null,
  infrastructureState = null,
  infrastructureSyncReason = null,
}) {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const widgetResult = await client.query(
      `SELECT * FROM widgets WHERE id=$1
       AND ($2::text IS NULL OR genesys_organization_id=$2 OR genesys_organization_id IS NULL)
       FOR UPDATE`,
      [id, actor.organizationId || null]
    );
    if (!widgetResult.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }

    const draftResult = await client.query(
      "SELECT * FROM widget_revisions WHERE widget_id=$1 AND state='draft' FOR UPDATE",
      [id]
    );
    const draft = draftResult.rows[0];
    if (!draft) throw new Error("Widget has no draft revision");
    const publishConfig = applyWidgetInfrastructure(draft.config, {
      integrationId: genesysResources?.integration?.id,
      queues: genesysResources?.queues,
      defaultQueue: genesysResources?.defaultQueue,
    });
    const parsedPublishConfig = assertPublishableWidgetConfig(publishConfig);
    await client.query("UPDATE widget_revisions SET config=$2::jsonb WHERE id=$1", [
      draft.id,
      JSON.stringify(parsedPublishConfig),
    ]);

    await client.query(
      "UPDATE widget_revisions SET state='archived' WHERE widget_id=$1 AND state='published'",
      [id]
    );
    await client.query(
      `UPDATE widget_revisions SET state='published', published_at=NOW() WHERE id=$1`,
      [draft.id]
    );
    await client.query(
      `UPDATE widgets SET published_revision_id=$2, updated_by_genesys_user_id=$3,
         supported_content_profile_id=COALESCE($4, supported_content_profile_id),
         supported_content_profile_name=COALESCE($5, supported_content_profile_name),
         open_messaging_integration_id=COALESCE($6, open_messaging_integration_id),
         base_open_messaging_integration_id=COALESCE($7, base_open_messaging_integration_id),
         infrastructure_fingerprint=COALESCE($8, infrastructure_fingerprint),
         infrastructure_config=COALESCE($9::jsonb, infrastructure_config),
         infrastructure_synced_at=CASE WHEN $8::text IS NOT NULL THEN NOW() ELSE infrastructure_synced_at END,
         updated_at=NOW()
       WHERE id=$1`,
      [
        id,
        draft.id,
        actor.userId,
        genesysResources?.profile?.id || null,
        genesysResources?.profile?.name || null,
        genesysResources?.integration?.id || null,
        genesysResources?.baseIntegrationId || null,
        infrastructureState?.fingerprint || null,
        infrastructureState ? JSON.stringify(infrastructureState.config) : null,
      ]
    );
    await client.query(
      `INSERT INTO widget_revisions
        (id, widget_id, version, state, config, created_by_genesys_user_id)
       VALUES ($1,$2,$3,'draft',$4::jsonb,$5)`,
      [randomUUID(), id, draft.version + 1, JSON.stringify(parsedPublishConfig), actor.userId]
    );
    await audit(client, {
      widgetId: id,
      actor,
      action: "widget.published",
      details: {
        version: draft.version,
        supportedContentProfileId: genesysResources?.profile?.id || null,
        openMessagingIntegrationId: genesysResources?.integration?.id || null,
        infrastructureSynchronized: Boolean(infrastructureState),
        infrastructureSyncReason,
      },
    });
    await client.query("COMMIT");
    return getWidget(id, actor.organizationId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Widgets created outside a Genesys session (the seeded examples) carry no
// organization, so every lookup of central admin desired state resolves against
// the installed organization instead. Sharing one resolver keeps the runtime
// routes from disagreeing about whether a channel is configured.
export function widgetOrganizationId(widget) {
  return String(
    widget?.genesys_organization_id || widget?.genesysOrganizationId || process.env.GC_ORGANIZATION_ID || ""
  ).trim() || null;
}

export async function getPublishedWidget(publicWidgetId) {
  const result = await getPostgresPool().query(
    `SELECT w.id, w.public_id, w.name, w.enabled, w.genesys_organization_id, r.id AS revision_id,
            r.version, r.config
     FROM widgets w
     JOIN widget_revisions r ON r.id=w.published_revision_id
     WHERE w.public_id=$1 AND w.enabled=TRUE AND r.state='published'
     LIMIT 1`,
    [publicWidgetId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const config = parseWidgetConfigIfCurrent(row.config);
  return config ? { ...row, config } : null;
}
