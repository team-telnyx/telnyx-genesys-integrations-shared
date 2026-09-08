import { randomUUID } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";

export const WIDGET_VOICE_DID_NAMESPACE_START = "+11009999000";
export const WIDGET_VOICE_DID_NAMESPACE_END = "+11009999999";
export const WIDGET_VOICE_DID_NAMESPACE_SIZE = 1000;

function digits(value) {
  const normalized = String(value || "").trim();
  if (!/^\+\d+$/.test(normalized)) throw new Error(`Invalid synthetic DID: ${value || "(missing)"}`);
  return BigInt(normalized.slice(1));
}

export function isWidgetVoiceDid(value) {
  try {
    const number = digits(value);
    return number >= digits(WIDGET_VOICE_DID_NAMESPACE_START) &&
      number <= digits(WIDGET_VOICE_DID_NAMESPACE_END);
  } catch {
    return false;
  }
}

export function widgetVoiceDidCandidates() {
  const start = digits(WIDGET_VOICE_DID_NAMESPACE_START);
  const end = digits(WIDGET_VOICE_DID_NAMESPACE_END);
  const values = [];
  for (let current = start; current <= end; current += 1n) values.push(`+${current}`);
  return values;
}

export function firstAvailableWidgetVoiceDid(usedNumbers = []) {
  const used = new Set([...usedNumbers].map((value) => String(value || "").trim()));
  const candidate = widgetVoiceDidCandidates().find((value) => !used.has(value));
  if (!candidate) {
    throw new Error(
      `The Widget synthetic DID namespace ${WIDGET_VOICE_DID_NAMESPACE_START}-${WIDGET_VOICE_DID_NAMESPACE_END} is exhausted`
    );
  }
  return candidate;
}

export async function getWidgetVoiceDidAllocation({ organizationId, deploymentId }) {
  const result = await getPostgresPool().query(
    `SELECT * FROM widget_voice_did_allocations
     WHERE genesys_organization_id=$1 AND deployment_id=$2`,
    [organizationId, deploymentId]
  );
  return result.rows[0] || null;
}

export async function reserveWidgetVoiceDid({
  organizationId,
  deploymentId,
  genesysUsedNumbers = [],
}) {
  if (!organizationId || !deploymentId) {
    throw new Error("Genesys organization ID and Widget deployment ID are required for DID allocation");
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [847221, organizationId]);
    const existing = (
      await client.query(
        `SELECT * FROM widget_voice_did_allocations
         WHERE genesys_organization_id=$1 AND deployment_id=$2
         FOR UPDATE`,
        [organizationId, deploymentId]
      )
    ).rows[0];
    if (existing) {
      await client.query("COMMIT");
      return { allocation: existing, created: false };
    }
    const reserved = await client.query(
      `SELECT phone_number FROM widget_voice_did_allocations
       WHERE genesys_organization_id=$1`,
      [organizationId]
    );
    const phoneNumber = firstAvailableWidgetVoiceDid([
      ...genesysUsedNumbers,
      ...reserved.rows.map((row) => row.phone_number),
    ]);
    const allocation = (
      await client.query(
        `INSERT INTO widget_voice_did_allocations
          (id,genesys_organization_id,deployment_id,phone_number,status)
         VALUES ($1,$2,$3,$4,'reserved')
         RETURNING *`,
        [randomUUID(), organizationId, deploymentId, phoneNumber]
      )
    ).rows[0];
    await client.query("COMMIT");
    return { allocation, created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateWidgetVoiceDidAllocation({
  organizationId,
  deploymentId,
  status,
  trunkId,
  didPoolId,
  flowId,
  ivrId,
  sipUri,
  error,
}) {
  const fields = [];
  const values = [organizationId, deploymentId];
  const add = (column, value) => {
    if (value === undefined) return;
    values.push(value);
    fields.push(`${column}=$${values.length}`);
  };
  add("status", status);
  add("genesys_trunk_id", trunkId);
  add("genesys_did_pool_id", didPoolId);
  add("genesys_flow_id", flowId);
  add("genesys_ivr_id", ivrId);
  add("genesys_sip_uri", sipUri);
  add("last_error", error == null ? null : String(error).slice(0, 4000));
  if (!fields.length) return getWidgetVoiceDidAllocation({ organizationId, deploymentId });
  const result = await getPostgresPool().query(
    `UPDATE widget_voice_did_allocations
     SET ${fields.join(", ")}, updated_at=NOW()
     WHERE genesys_organization_id=$1 AND deployment_id=$2
     RETURNING *`,
    values
  );
  if (result.rowCount !== 1) throw new Error(`Widget voice DID allocation ${deploymentId} was not found`);
  return result.rows[0];
}

export async function deleteWidgetVoiceDidAllocation({ organizationId, deploymentId }) {
  const result = await getPostgresPool().query(
    `DELETE FROM widget_voice_did_allocations
     WHERE genesys_organization_id=$1 AND deployment_id=$2
     RETURNING *`,
    [organizationId, deploymentId]
  );
  return result.rows[0] || null;
}
