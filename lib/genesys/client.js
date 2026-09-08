import platformClient from "purecloud-platform-client-v2";

let accessToken = null;
let tokenExpiry = null;

/**
 * Get Genesys Cloud Client Credentials Grant token
 */
export async function getClientGrant() {
  try {
    const clientId = process.env.GC_CLIENT_CRED_CLIENT_ID;
    const clientSecret = process.env.GC_CLIENT_CRED_CLIENT_SECRET;
    const environment = process.env.GC_ENVIRONMENT;

    if (!clientId || !clientSecret || !environment) {
      throw new Error("Missing Genesys Cloud credentials in environment");
    }

    const apiClient = platformClient.ApiClient.instance;
    apiClient.setEnvironment(environment);

    const authData = await apiClient.loginClientCredentialsGrant(
      clientId,
      clientSecret
    );

    // Store token string and calculate expiry
    accessToken = authData.accessToken;
    // Token expires in ~24h, refresh at 12h to be safe
    tokenExpiry = Date.now() + 12 * 60 * 60 * 1000;

    console.log("✓ Genesys Cloud client grant obtained");
    return accessToken;
  } catch (error) {
    console.error("Error obtaining Genesys Cloud client grant:", error.message);
    throw error;
  }
}

/**
 * Ensure we have a valid token and set it on the API client
 */
async function ensureAuthenticated() {
  // Check if token needs refresh
  if (!accessToken || !tokenExpiry || Date.now() >= tokenExpiry) {
    console.log("Refreshing Genesys Cloud token...");
    await getClientGrant();
  }

  // Set the access token on the API client
  const apiClient = platformClient.ApiClient.instance;
  apiClient.setAccessToken(accessToken);
}

export async function getGenesysAccessToken() {
  await ensureAuthenticated();
  return accessToken;
}

/**
 * Get Conversations API instance
 */
export async function getConversationsApi() {
  await ensureAuthenticated();
  return new platformClient.ConversationsApi();
}

/**
 * Get Outbound API instance
 */
export async function getOutboundApi() {
  await ensureAuthenticated();
  return new platformClient.OutboundApi();
}

/**
 * Get Notifications API instance
 */
export async function getNotificationsApi() {
  await ensureAuthenticated();
  return new platformClient.NotificationsApi();
}

/**
 * Get Routing API instance
 */
export async function getRoutingApi() {
  await ensureAuthenticated();
  return new platformClient.RoutingApi();
}

/**
 * Get Users API instance
 */
export async function getUsersApi() {
  await ensureAuthenticated();
  return new platformClient.UsersApi();
}

/**
 * Get Architect API instance
 */
export async function getArchitectApi() {
  await ensureAuthenticated();
  return new platformClient.ArchitectApi();
}

/**
 * Get Groups API instance
 */
export async function getGroupsApi() {
  await ensureAuthenticated();
  return new platformClient.GroupsApi();
}

/**
 * Initialize token refresh interval
 */
export function initTokenRefresh() {
  // Refresh token every 12 hours
  setInterval(
    async () => {
      console.log("Auto-refreshing Genesys Cloud token...");
      await getClientGrant();
    },
    12 * 60 * 60 * 1000
  );

  // Initial token fetch
  return getClientGrant();
}
