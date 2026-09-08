export const GENESYS_DID_INVENTORY_TYPE = "ASSIGNED_AND_UNASSIGNED";

export async function listGenesysDidNumbers(telephonyApi) {
  if (!telephonyApi?.getTelephonyProvidersEdgesDidpoolsDids) {
    throw new Error("Genesys DID Pool inventory API is required to list all DID numbers");
  }

  const byNumber = new Map();
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await telephonyApi.getTelephonyProvidersEdgesDidpoolsDids(
      GENESYS_DID_INVENTORY_TYPE,
      {
        pageNumber,
        pageSize: 100,
        sortOrder: "ascending",
      }
    );
    for (const entry of page.entities || []) {
      const dnis = String(entry.number || entry.phoneNumber || "").trim();
      if (!dnis) continue;
      const current = byNumber.get(dnis);
      if (!current || (!current.owner?.id && entry.owner?.id)) {
        byNumber.set(dnis, {
          id: entry.id || dnis,
          dnis,
          assigned: entry.assigned === true || Boolean(entry.owner?.id),
          owner: entry.owner?.id
            ? {
                id: entry.owner.id,
                name: entry.owner.name || entry.owner.id,
                type: entry.ownerType || "UNKNOWN",
              }
            : null,
          didPool: entry.didPool?.id
            ? { id: entry.didPool.id, name: entry.didPool.name || entry.didPool.id }
            : null,
        });
      }
    }
    if (!page.nextUri || !(page.entities || []).length) break;
    if (pageNumber === 100) throw new Error("Genesys DID Pool inventory pagination exceeded 100 pages");
  }

  return [...byNumber.values()].sort((left, right) => left.dnis.localeCompare(right.dnis));
}
