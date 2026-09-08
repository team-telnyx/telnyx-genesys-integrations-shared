export const DEFAULT_INSTALLATION_KEY = "legacy";
export const DEFAULT_INSTALLATION_NAME = "Telnyx Integrations";

export function normalizeInstallationKey(value, { required = false } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized && !required) return DEFAULT_INSTALLATION_KEY;
  if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(normalized)) {
    throw new Error(
      "GC_INSTALLATION_KEY must be a 2-24 character lowercase slug using letters, numbers and hyphens"
    );
  }
  return normalized;
}

export function normalizeInstallationName(value, { required = false } = {}) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (!normalized && !required) return DEFAULT_INSTALLATION_NAME;
  if (normalized.length < 3 || normalized.length > 50 || /[\r\n]/.test(normalized)) {
    throw new Error("GC_INSTALLATION_NAME must contain 3-50 single-line characters");
  }
  return normalized;
}

export function installationScope(environment = process.env) {
  const configuredKey = String(environment.GC_INSTALLATION_KEY || "").trim();
  const configuredName = String(environment.GC_INSTALLATION_NAME || "").trim();
  const key = normalizeInstallationKey(configuredKey);
  const name = normalizeInstallationName(configuredName);
  return {
    key,
    name,
    legacy: (!configuredKey && !configuredName) ||
      (key === DEFAULT_INSTALLATION_KEY && name === DEFAULT_INSTALLATION_NAME),
  };
}

export function installationResourceNames(scopeOrEnvironment = process.env) {
  const scope = scopeOrEnvironment?.key && scopeOrEnvironment?.name
    ? scopeOrEnvironment
    : installationScope(scopeOrEnvironment);
  return Object.freeze({
    installationKey: scope.key,
    installationName: scope.name,
    adminRole: scope.name,
    adminGroup: scope.name,
    adminClientApplication: scope.name,
    adminOauthClient: scope.name,
    widgetInfrastructure: scope.name,
    widgetMessageFlow: scope.name,
    widgetOpenMessaging: scope.name,
    widgetHandoffTool: scope.name,
    sharedHangupTool: scope.name,
    sharedInviteTool: scope.name,
    sharedSkipTurnTool: scope.name,
    audioHandoffScript: scope.name,
    audioInteractionWidget: scope.name,
    callbacks: scope.name,
  });
}

export function suggestedInstallationName(key) {
  const normalized = normalizeInstallationKey(key, { required: true });
  return normalized === DEFAULT_INSTALLATION_KEY
    ? DEFAULT_INSTALLATION_NAME
    : `${DEFAULT_INSTALLATION_NAME} ${normalized.toUpperCase()}`;
}
