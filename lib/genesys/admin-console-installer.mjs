import platformClient from "purecloud-platform-client-v2";

import {
  ensureWidgetAccessGroup,
  ensureWidgetAdminRole,
  ensureWidgetClientApplication,
  ensureWidgetRoleGroupGrant,
  listAllGenesysGroups,
  listAllGenesysQueues,
  listAllGenesysRoles,
  WIDGET_CLIENT_APP_INTEGRATION_TYPE,
  widgetAdminUrl,
} from "./widget-installer-resources.mjs";
import { registerManagedResourceBatch } from "./managed-resource-registry.mjs";
import {
  hardenGenesysSdkClient,
  normalizeGenesysEnvironment,
} from "./tts-connector-genesys.mjs";
import { ensureWidgetOauthRedirectUri } from "../../scripts/provision-genesys-ai-agent-experience.mjs";
import { installationResourceNames } from "./installation-scope.mjs";
import { GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS } from "./oauth-settings.mjs";

export const ADMIN_CONSOLE_ACCESS_GROUP_NAME = installationResourceNames().adminGroup;
export const ADMIN_CONSOLE_OAUTH_SCOPES = Object.freeze([
  "users",
  "conversations",
  "organization:readonly",
  "authorization:readonly",
]);

async function listClientApplications(integrationsApi) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await integrationsApi.getIntegrations({
      pageSize: 100,
      pageNumber,
      integrationType: WIDGET_CLIENT_APP_INTEGRATION_TYPE,
    });
    entries.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error("Genesys Client Application pagination exceeded 100 pages");
}

export async function listAllGenesysUsers(usersApi) {
  const users = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await usersApi.getUsers({
      pageSize: 100,
      pageNumber,
      state: "active",
      sortOrder: "ASC",
    });
    users.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return users;
  }
  throw new Error("Genesys user pagination exceeded 100 pages");
}

export async function listAllGroupMembers(groupsApi, groupId) {
  const members = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await groupsApi.getGroupMembers(groupId, { pageSize: 100, pageNumber });
    members.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return members;
  }
  throw new Error("Genesys group member pagination exceeded 100 pages");
}

export async function loadAdminConsoleGenesysContext({
  environment,
  clientId,
  clientSecret,
  includeUsers = false,
} = {}) {
  const normalizedEnvironment = normalizeGenesysEnvironment(environment);
  const apiClient = platformClient.ApiClient.instance;
  hardenGenesysSdkClient(apiClient);
  apiClient.setEnvironment(normalizedEnvironment);
  apiClient.timeout = 30_000;
  const auth = await apiClient.loginClientCredentialsGrant(clientId, clientSecret);
  if (!(auth?.accessToken || apiClient.authData?.accessToken)) {
    throw new Error("Genesys access token was not returned");
  }
  const organizationApi = new platformClient.OrganizationApi();
  const authorizationApi = new platformClient.AuthorizationApi();
  const integrationsApi = new platformClient.IntegrationsApi();
  const architectApi = new platformClient.ArchitectApi();
  const groupsApi = new platformClient.GroupsApi();
  const oauthApi = new platformClient.OAuthApi();
  const routingApi = new platformClient.RoutingApi();
  const conversationsApi = new platformClient.ConversationsApi();
  const telephonyApi = new platformClient.TelephonyProvidersEdgeApi();
  const outboundApi = new platformClient.OutboundApi();
  const scriptsApi = new platformClient.ScriptsApi();
  const usersApi = includeUsers ? new platformClient.UsersApi() : null;
  const [organization, homeDivision, groups, queues, roles, clientApplications, users] = await Promise.all([
    organizationApi.getOrganizationsMe(),
    authorizationApi.getAuthorizationDivisionsHome(),
    listAllGenesysGroups(groupsApi),
    listAllGenesysQueues(routingApi),
    listAllGenesysRoles(authorizationApi),
    listClientApplications(integrationsApi),
    includeUsers ? listAllGenesysUsers(usersApi) : Promise.resolve([]),
  ]);
  return {
    accessToken: auth?.accessToken || apiClient.authData?.accessToken,
    environment: normalizedEnvironment,
    organization,
    homeDivision,
    authorizationApi,
    integrationsApi,
    architectApi,
    groupsApi,
    oauthApi,
    telephonyApi,
    outboundApi,
    scriptsApi,
    conversationsApi,
    routingApi,
    usersApi,
    groups,
    queues,
    roles,
    clientApplications,
    users,
  };
}

export async function ensureAdminConsoleOauthClient({
  context,
  baseUrl,
  clientId,
  clientSecret,
  name,
}) {
  if (clientId) {
    const current = await context.oauthApi.getOauthClient(clientId);
    if (current.name !== name) {
      throw new Error(
        `Genesys OAuth client ${clientId} is named ${current.name}; expected ${name}. Use a separate OAuth client for this installation.`
      );
    }
    const ensured = await ensureWidgetOauthRedirectUri(context.oauthApi, clientId, baseUrl, {
      requiredScopes: ADMIN_CONSOLE_OAUTH_SCOPES,
    });
    return {
      id: clientId,
      secret: String(clientSecret || "").trim() || null,
      created: false,
      callbackUrl: ensured.callbackUrl,
    };
  }
  const created = await context.oauthApi.postOauthClients({
    name,
    authorizedGrantType: "CODE",
    registeredRedirectUri: [`${baseUrl}/api/auth/callback`],
    scope: ADMIN_CONSOLE_OAUTH_SCOPES,
    accessTokenValiditySeconds: GENESYS_CODE_ACCESS_TOKEN_VALIDITY_SECONDS,
  });
  if (!created?.id) throw new Error("Genesys did not return the created OAuth client ID");
  return {
    id: created.id,
    secret: created.secret || null,
    created: true,
    callbackUrl: `${baseUrl}/api/auth/callback`,
  };
}

export async function provisionGenesysAdminConsole({
  context,
  baseUrl,
  adminUserIds = [],
  oauthClientId,
  oauthClientSecret,
  adoptOauthClientId,
  resourceNames = installationResourceNames(),
  onProgress = () => {},
} = {}) {
  if (
    adoptOauthClientId &&
    !oauthClientId &&
    !String(oauthClientSecret || "").trim()
  ) {
    throw new Error(
      "The existing Genesys Code Authorization OAuth client secret is required before it can be adopted"
    );
  }
  const names = resourceNames;
  const selectedUsers = [...new Set(adminUserIds)].map((id) =>
    context.users.find((user) => user.id === id)
  );
  if (!selectedUsers.length || selectedUsers.some((user) => !user)) {
    throw new Error("Select at least one active Genesys administrator");
  }
  onProgress({ status: "running", label: `Ensure access group ${names.adminGroup}` });
  const ensuredGroup = await ensureWidgetAccessGroup({
    groupsApi: context.groupsApi,
    existingGroups: context.groups,
    name: names.adminGroup,
  });
  const groups = [ensuredGroup.group];
  const currentMembers = await listAllGroupMembers(context.groupsApi, ensuredGroup.group.id);
  const currentMemberIds = new Set(currentMembers.map(({ id }) => id));
  const missingUsers = selectedUsers.filter(({ id }) => !currentMemberIds.has(id));
  for (let index = 0; index < missingUsers.length; index += 50) {
    await context.groupsApi.postGroupMembers(ensuredGroup.group.id, {
      memberIds: missingUsers.slice(index, index + 50).map(({ id }) => id),
    });
  }
  onProgress({
    status: "success",
    label: `${ensuredGroup.group.name} ready with ${selectedUsers.length} selected administrator(s)`,
  });

  onProgress({ status: "running", label: "Ensure Genesys administrator role" });
  const roleResult = await ensureWidgetAdminRole({
    authorizationApi: context.authorizationApi,
    existingRoles: context.roles,
    roleId: process.env.GC_WIDGET_ADMIN_ROLE_ID,
    name: names.adminRole,
  });
  await ensureWidgetRoleGroupGrant({
    authorizationApi: context.authorizationApi,
    roleId: roleResult.role.id,
    groupIds: groups.map(({ id }) => id),
    divisionId: context.homeDivision.id,
  });
  onProgress({ status: "success", label: "Genesys administrator role and group grant ready" });

  onProgress({ status: "running", label: "Ensure Code Authorization OAuth client" });
  const oauth = await ensureAdminConsoleOauthClient({
    context,
    baseUrl,
    clientId: oauthClientId || adoptOauthClientId,
    clientSecret: oauthClientSecret,
    name: names.adminOauthClient,
  });
  onProgress({ status: "success", label: `OAuth callback ready at ${oauth.callbackUrl}` });

  onProgress({ status: "running", label: "Ensure Genesys Custom Client Application" });
  const clientApplication = await ensureWidgetClientApplication({
    integrationsApi: context.integrationsApi,
    integrations: context.clientApplications,
    baseUrl,
    groupIds: groups.map(({ id }) => id),
    name: names.adminClientApplication,
  });
  onProgress({ status: "success", label: "Genesys Custom Client Application enabled" });

  await registerManagedResourceBatch({
    organizationId: context.organization.id,
    aggregate: {
      kind: "messaging_profile",
      name: "installation:administration",
      desiredConfig: { installationName: names.installationName },
    },
    resources: [
      {
        provider: "genesys", resourceType: "group", remoteId: ensuredGroup.group.id,
        displayName: ensuredGroup.group.name, logicalKey: "admin_group",
      },
      {
        provider: "genesys", resourceType: "role", remoteId: roleResult.role.id,
        displayName: roleResult.role.name, logicalKey: "admin_role",
      },
      {
        provider: "genesys", resourceType: "oauth_client", remoteId: oauth.id,
        displayName: names.adminOauthClient, logicalKey: "admin_oauth_client",
      },
      {
        provider: "genesys", resourceType: "client_application",
        remoteId: clientApplication.integration.id, displayName: clientApplication.integration.name,
        logicalKey: "admin_client_application",
      },
    ],
  });

  return {
    organization: { id: context.organization.id, name: context.organization.name },
    environment: context.environment,
    groups: groups.map(({ id, name }) => ({ id, name })),
    administrators: selectedUsers.map(({ id, name, email, username }) => ({
      id,
      name: name || email || username || id,
      email: email || username || null,
    })),
    role: { id: roleResult.role.id, name: roleResult.role.name, created: roleResult.created },
    oauth,
    clientApplication: {
      id: clientApplication.integration.id,
      name: clientApplication.integration.name,
      created: clientApplication.created,
      url: widgetAdminUrl(baseUrl),
    },
  };
}
