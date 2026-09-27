import { randomUUID } from 'node:crypto';
import { getPostgresPool } from '../postgres.mjs';
import { installationScope } from './installation-scope.mjs';

export async function withVideoPanelState(organizationId, operation) {
  if (!organizationId) throw new Error('Genesys organization ID is required');
  const client = await getPostgresPool().connect();
  const scope = installationScope();
  const name = `${scope.key}:video-auto-open`;
  let locked = false;
  try {
    // Session lock with autocommit: recovery data survives a later remote failure.
    await client.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [organizationId, name]);
    locked = true;
    const result = await client.query("SELECT desired_config FROM integration_configuration_aggregates WHERE genesys_organization_id=$1 AND kind='agent_experience' AND name=$2", [organizationId, name]);
    const save = async state => {
      const aggregate = await client.query(`INSERT INTO integration_configuration_aggregates (id,genesys_organization_id,kind,name,desired_config)
        VALUES ($1,$2,'agent_experience',$3,$4::jsonb)
        ON CONFLICT (genesys_organization_id,kind,name) DO UPDATE SET desired_config=EXCLUDED.desired_config,updated_at=NOW() RETURNING id`,
      [randomUUID(), organizationId, name, JSON.stringify(state)]);
      if (state.panelId) await client.query(`INSERT INTO integration_managed_resources
        (id,aggregate_id,provider,resource_type,remote_id,display_name,status,logical_key,scope_type,scope_id,ownership)
        VALUES ($1,$2,'genesys','client_application',$3,$4,'healthy','video_auto_open_panel','installation',$5,'managed')
        ON CONFLICT (provider,remote_id) DO UPDATE SET updated_at=NOW(),deleted_at=NULL`,
      [randomUUID(), aggregate.rows[0].id, state.panelId, `${scope.name} - Video Auto Open`, scope.key]);
    };
    return await operation({ state: result.rows[0]?.desired_config || {}, save, name: `${scope.name} - Video Auto Open` });
  } finally {
    let releaseError;
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [organizationId, name]); }
      catch (error) { releaseError = error; }
    }
    client.release(releaseError);
  }
}
