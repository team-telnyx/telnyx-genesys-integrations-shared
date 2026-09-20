// The Genesys Cloud API origin, and validation of caller-supplied URLs against it.
//
// Two routes used to fetch a URL taken straight from the request while
// attaching the signed-in user's Genesys bearer token. Authentication was the
// only barrier: a victim who loaded an attacker's page had their browser issue
// the request with cookies attached, the server fetched the attacker's host,
// and the token arrived there in the Authorization header. CORS does not help —
// the attacker's own server receives it before any response is read.
//
// So a credentialed fetch must never target a host the caller chose.

const DEFAULT_ENVIRONMENT = "usw2.pure.cloud";

// A Genesys region: "usw2.pure.cloud", "mypurecloud.com", "mypurecloud.ie".
// Deliberately narrow — it is a hostname suffix, not a URL, and anything
// carrying a slash, port, credential or wildcard is not one.
const ENVIRONMENT = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function genesysEnvironment(env = process.env) {
  const configured = (env.GC_ENVIRONMENT || "").trim() || DEFAULT_ENVIRONMENT;
  if (!ENVIRONMENT.test(configured)) {
    throw new Error("GC_ENVIRONMENT must be a Genesys region hostname, for example usw2.pure.cloud");
  }
  return configured;
}

export function genesysApiOrigin(env = process.env) {
  return `https://api.${genesysEnvironment(env)}`;
}

/**
 * Validate a URL that will be fetched with the user's access token.
 *
 * Returns the normalized URL string, or throws. The host must be exactly the
 * configured Genesys API host: a suffix check would accept
 * `api.usw2.pure.cloud.attacker.test`, and a "contains" check anything at all.
 *
 * Redirects are left to fetch, which strips Authorization when a redirect
 * crosses origins — that is what lets an export URI hand off to presigned
 * storage without the token following it there.
 */
export function assertGenesysApiUrl(value, env = process.env) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new Error("Not a valid absolute URL");
  }
  if (parsed.protocol !== "https:") throw new Error("URL must use https");
  if (parsed.username || parsed.password) throw new Error("URL must not carry credentials");
  const expected = `api.${genesysEnvironment(env)}`;
  if (parsed.host !== expected) {
    throw new Error(`URL host must be ${expected}`);
  }
  return parsed.toString();
}
