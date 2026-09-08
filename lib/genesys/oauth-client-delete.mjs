function status(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}
async function readClient(api, id) {
  try { return await api.getOauthClient(id); }
  catch (error) { if (status(error) === 404) return null; throw error; }
}

export async function deleteGenesysOauthClient(api, id) {
  const client = await readClient(api, id);
  if (!client) return { alreadyMissing: true };
  if (client.state !== 'inactive') {
    // OAuthClientRequest fields only: never resend secrets or read-only metadata.
    const body = { state: 'inactive' };
    for (const key of ['name', 'authorizedGrantType', 'accessTokenValiditySeconds', 'description',
      'registeredRedirectUri', 'roleIds', 'scope', 'roleDivisions']) {
      if (client[key] !== undefined) body[key] = client[key];
    }
    try { await api.putOauthClient(id, body); }
    catch (error) { if (status(error) === 404) return { alreadyMissing: true }; throw error; }
    const inactive = await readClient(api, id);
    if (!inactive) return { alreadyMissing: true };
    if (inactive.state !== 'inactive') throw new Error('OAuth client did not become inactive; deletion was not attempted');
  }
  try { await api.deleteOauthClient(id); }
  catch (error) { if (status(error) !== 404) throw error; }
  if (await readClient(api, id)) throw new Error('OAuth client still exists after deletion; retry after checking Genesys');
  return { deleted: true };
}
