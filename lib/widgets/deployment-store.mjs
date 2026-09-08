import { randomBytes, randomUUID } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig } from "./config.js";
import { installationScope } from "../genesys/installation-scope.mjs";
import {
  assertWidgetNameIsNotReserved,
  normalizedManagedNameKey,
} from "../genesys/resource-naming.mjs";

function publicId() {
  return `wgt_${randomBytes(18).toString("base64url")}`;
}

function deploymentConfig({ assistantId, integrationId, queues, allowedOrigins, voice }) {
  const config = structuredClone(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = [...new Set(allowedOrigins)];
  config.channels.messaging.assistantId = assistantId;
  config.channels.messaging.genesys = {
    integrationId,
    queueId: queues[0].id,
    queueName: queues[0].name,
    queues: queues.map(({ id, name }) => ({ id, name })),
  };
  if (voice?.enabled) {
    config.channels.voice.enabled = true;
    config.channels.voice.assistantId = voice.assistantId;
    config.channels.voice.assistantVersionId = voice.assistantVersionId || "main";
    config.channels.voice.genesysSipUri = voice.genesysSipUri;
    config.channels.voice.region = voice.region || "auto";
  }
  return parseWidgetConfig(config);
}

export async function ensureManagedWidgetRecord({
  deploymentId,
  name,
  organizationId,
  assistantId,
  integrationId,
  queues,
  allowedOrigins,
  voice,
}) {
  if (!queues?.length) throw new Error("At least one queue is required for the managed widget record");
  if (!allowedOrigins?.length) throw new Error("At least one embedding origin is required");
  const config = deploymentConfig({ assistantId, integrationId, queues, allowedOrigins, voice });
  const normalizedName = assertWidgetNameIsNotReserved(name);
  const nameKey = normalizedManagedNameKey(normalizedName);
  const installationKey = installationScope().key;
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    let widget = (
      await client.query(
        "SELECT * FROM widgets WHERE managed_deployment_id=$1 FOR UPDATE",
        [deploymentId]
      )
    ).rows[0];
    const created = !widget;
    if (!widget) {
      widget = (
        await client.query(
          `INSERT INTO widgets
            (id,public_id,name,normalized_name,installation_key,enabled,genesys_organization_id,managed_deployment_id,
             created_by_genesys_user_id,updated_by_genesys_user_id)
           VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,'genesys-widget-cli','genesys-widget-cli')
           RETURNING *`,
          [randomUUID(), publicId(), normalizedName, nameKey, installationKey,
            organizationId, deploymentId]
        )
      ).rows[0];
    } else {
      widget = (
        await client.query(
          `UPDATE widgets SET name=$2, normalized_name=$3, installation_key=$4,
             enabled=TRUE, genesys_organization_id=$5,
             updated_by_genesys_user_id='genesys-widget-cli', updated_at=NOW()
           WHERE id=$1 RETURNING *`,
          [widget.id, normalizedName, nameKey, installationKey, organizationId]
        )
      ).rows[0];
    }

    await client.query(
      "UPDATE widget_revisions SET state='archived' WHERE widget_id=$1 AND state IN ('draft','published')",
      [widget.id]
    );
    const nextVersion = Number((
      await client.query(
        "SELECT COALESCE(MAX(version),0)+1 AS version FROM widget_revisions WHERE widget_id=$1",
        [widget.id]
      )
    ).rows[0].version);
    const publishedId = randomUUID();
    await client.query(
      `INSERT INTO widget_revisions
        (id,widget_id,version,state,config,created_by_genesys_user_id,published_at)
       VALUES ($1,$2,$3,'published',$4::jsonb,'genesys-widget-cli',NOW())`,
      [publishedId, widget.id, nextVersion, JSON.stringify(config)]
    );
    await client.query(
      `INSERT INTO widget_revisions
        (id,widget_id,version,state,config,created_by_genesys_user_id)
       VALUES ($1,$2,$3,'draft',$4::jsonb,'genesys-widget-cli')`,
      [randomUUID(), widget.id, nextVersion + 1, JSON.stringify(config)]
    );
    await client.query(
      "UPDATE widgets SET published_revision_id=$2, updated_at=NOW() WHERE id=$1",
      [widget.id, publishedId]
    );
    await client.query(
      `INSERT INTO widget_admin_audit_events
        (widget_id,genesys_organization_id,genesys_user_id,action,details)
       VALUES ($1,$2,'genesys-widget-cli',$3,$4::jsonb)`,
      [
        widget.id,
        organizationId,
        created ? "widget.deployment.created" : "widget.deployment.reconciled",
        JSON.stringify({ deploymentId, queues: queues.map(({ id }) => id) }),
      ]
    );
    await client.query("COMMIT");
    return {
      id: widget.id,
      publicId: widget.public_id,
      publishedRevisionId: publishedId,
      created,
      config,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteManagedWidgetRecord({ deploymentId, widgetId }) {
  const result = await getPostgresPool().query(
    `DELETE FROM widgets
     WHERE managed_deployment_id=$1 AND id=$2
     RETURNING id, public_id`,
    [deploymentId, widgetId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Managed widget ${widgetId} does not match deployment ${deploymentId}`);
  }
  return { id: result.rows[0].id, publicId: result.rows[0].public_id };
}
