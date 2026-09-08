export const GENESYS_REAUTH_REQUIRED_EVENT = "genesys-admin-reauth-required";

let reauthNotificationPending = false;
let refreshRequestPending = null;

async function refreshGenesysBrowserSession() {
  if (refreshRequestPending) return refreshRequestPending;
  refreshRequestPending = fetch("/api/auth/refresh", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshRequestPending = null;
    });
  return refreshRequestPending;
}

export async function genesysAuthenticatedFetch(input, init) {
  const response = await fetch(input, init);
  if (response.status !== 401 || input === "/api/auth/refresh") return response;
  if (!(await refreshGenesysBrowserSession())) return response;
  return fetch(input, init);
}

export function clearGenesysReauthRequired() {
  reauthNotificationPending = false;
}

export function notifyGenesysReauthRequired(message) {
  if (typeof window === "undefined" || reauthNotificationPending) return;
  reauthNotificationPending = true;
  window.dispatchEvent(new CustomEvent(GENESYS_REAUTH_REQUIRED_EVENT, {
    detail: { message: message || "Your Genesys Cloud session has expired." },
  }));
}

export function createGenesysAdminApiError(response, body = {}) {
  const error = new Error(body.error || `Request returned ${response.status}`);
  error.status = response.status;
  error.reauthRequired = Boolean(body.reauthRequired || response.status === 401);
  error.issues = body.issues;
  if (error.reauthRequired) notifyGenesysReauthRequired(error.message);
  return error;
}

export function shouldShowGenesysApiError(error) {
  return !error?.reauthRequired;
}
