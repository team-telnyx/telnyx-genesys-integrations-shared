import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('video panel recovery state survives failures and serializes concurrent queue changes', { skip: !process.env.VIDEO_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.VIDEO_TEST_DATABASE_URL;
  const { ensurePostgresSchema } = await import('../lib/postgres-schema.mjs');
  const { getPostgresPool, closePostgresPool } = await import('../lib/postgres.mjs');
  const { withVideoPanelState } = await import('../lib/genesys/video-panel-store.mjs');
  await ensurePostgresSchema();
  const org = randomUUID(), panelId = randomUUID();
  try {
    await assert.rejects(withVideoPanelState(org, async ({ save }) => {
      await save({ panelId, queueIds: ['video'] });
      throw new Error('Remote API failed after resource creation');
    }), /Remote API failed/);
    await withVideoPanelState(org, async ({ state }) => assert.equal(state.panelId, panelId));
    await Promise.all(['support', 'sales'].map(queue => withVideoPanelState(org, async ({ state, save }) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      await save({ ...state, queueIds: [...state.queueIds, queue] });
    })));
    await withVideoPanelState(org, async ({ state }) => assert.deepEqual([...state.queueIds].sort(), ['sales', 'support', 'video']));
    const resources = await getPostgresPool().query('SELECT remote_id FROM integration_managed_resources WHERE remote_id=$1', [panelId]);
    assert.equal(resources.rowCount, 1);
  } finally {
    await getPostgresPool().query('DELETE FROM integration_configuration_aggregates WHERE genesys_organization_id=$1', [org]);
    await closePostgresPool();
  }
});
