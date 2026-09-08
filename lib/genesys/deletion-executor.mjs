const ACCESS_KEYS = new Set(['admin_client_application', 'admin_oauth_client', 'admin_role', 'admin_group']);
export function isAdministrationAccess(resource) {
  return resource.provider === 'genesys' && ACCESS_KEYS.has(resource.logicalKey);
}

// Keep the administration resources until every other registered resource is gone.
export async function executeDeletionPlan({ plan, selected, remove, markDeleted, markFailed }) {
  const accessOrder = { admin_role: 4, admin_group: 3, admin_oauth_client: 2, admin_client_application: 1 };
  const ordered = [
    ...selected.filter(r => !isAdministrationAccess(r)),
    ...selected.filter(isAdministrationAccess).sort((a, b) => accessOrder[b.logicalKey] - accessOrder[a.logicalKey]),
  ];
  const results = [];
  const deleted = new Set();
  for (const resource of ordered) {
    const access = isAdministrationAccess(resource);
    const remaining = plan.some(r => r.ownership !== "external" && r.scopeType !== "organization" && !isAdministrationAccess(r) && !deleted.has(r.id));
    const failed = results.some(r => r.status !== 'deleted');
    const dependent = plan.find(r => r.id !== resource.id && !deleted.has(r.id) &&
      (r.dependencies || []).some(d => d.resourceId === resource.id));
    if ((access && (remaining || failed)) || dependent) {
      results.push({ id: resource.id, name: resource.displayName, status: 'skipped', error: dependent
        ? `Retained because ${dependent.displayName} still depends on this resource.`
        : 'Administration access retained. Remove the remaining resources and resolve failures before deleting access.' });
      continue;
    }
    try {
      const outcome = await remove(resource);
      await markDeleted(resource.id);
      deleted.add(resource.id);
      results.push({ id: resource.id, name: resource.displayName, status: 'deleted', administrationAccess: access, outcome: outcome || null });
    } catch (error) {
      let trackingError;
      try { await markFailed(resource.id, error); }
      catch (failure) { trackingError = failure?.message || String(failure); }
      results.push({ id: resource.id, name: resource.displayName, status: 'failed', error: error?.message || String(error), ...(trackingError ? { trackingError } : {}) });
    }
  }
  return { results, deleted: deleted.size, failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    administrationAccessDeleted: results.some(r => r.status === 'deleted' && r.administrationAccess) };
}
