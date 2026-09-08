#!/usr/bin/env node

import "dotenv/config";
import { randomBytes } from "node:crypto";
import path from "node:path";
import platformClient from "purecloud-platform-client-v2";

import {
  color,
  confirm,
  header,
  input,
  password,
  printCheck,
  printProgress,
  searchableCheckboxMenu,
  selectMenu,
  withSpinner,
} from "../lib/genesys/genesys-admin-ui.mjs";
import {
  listAllGroupMembers,
  loadAdminConsoleGenesysContext,
  provisionGenesysAdminConsole,
} from "../lib/genesys/admin-console-installer.mjs";
import { inspectInstallationCollisions } from "../lib/genesys/installation-collisions.mjs";
import {
  installationResourceNames,
  normalizeInstallationKey,
  normalizeInstallationName,
  suggestedInstallationName,
} from "../lib/genesys/installation-scope.mjs";
import {
  deleteInstallerEnvironmentValues,
  saveInstallerEnvironmentValues,
} from "../lib/genesys/installer-environment.mjs";
import {
  ADMIN_SECRETS_MASTER_KEY,
  decodeSecretsMasterKey,
  generateSecretsMasterKey,
  hasEncryptedRuntimeSecrets,
  hydrateRuntimeSecrets,
  MANAGED_RUNTIME_SECRET_NAMES,
  managedSecretsFromEnvironment,
  saveEncryptedRuntimeSecrets,
} from "../lib/genesys/encrypted-secret-store.mjs";
import { normalizePublicApplicationOrigin } from "../lib/genesys/public-origin-manager.mjs";
import {
  verifyGenesysPlatformAccess,
  verifyTelnyxPlatformAccess,
} from "../lib/genesys/platform-preflight.mjs";
import { closePostgresPool, isPostgresConfigured } from "../lib/postgres.mjs";
import { ensurePostgresSchema } from "../lib/postgres-schema.mjs";
import { normalizeTelnyxPublicKey } from "../lib/telnyx/webhooks.mjs";

export const GENESYS_DEPLOY_VARIABLES = Object.freeze([
  "DATABASE_URL",
  ADMIN_SECRETS_MASTER_KEY,
  ...MANAGED_RUNTIME_SECRET_NAMES,
]);

const BOOTSTRAP_ENVIRONMENT_NAMES = Object.freeze([
  "DATABASE_URL",
  ADMIN_SECRETS_MASTER_KEY,
]);

function present(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function nonEmpty(value) {
  return String(value || "").trim() ? true : "A value is required";
}

async function collectValue(name, prompt, {
  secret = false,
  validate = nonEmpty,
  optional = false,
  defaultValue = "",
} = {}) {
  const current = String(process.env[name] || "").trim();
  const existingValueLabel = secret
    ? `${name} value`
    : `${name}=${JSON.stringify(current)}`;
  if (current && await confirm(`Use the existing configured ${existingValueLabel}?`, true)) {
    return { value: current, changed: false };
  }
  const value = secret
    ? await password(prompt, { validate: optional ? undefined : validate })
    : await input(prompt, current || defaultValue, { validate: optional ? undefined : validate });
  const normalized = String(value || "").trim();
  if (!normalized && optional) return { value: "", changed: Boolean(current) };
  return { value: normalized, changed: normalized !== current };
}

function printIntroduction() {
  header(
    "Telnyx / Genesys Admin Console bootstrap",
    "Minimal configuration for the shared web administration application"
  );
  console.log(`
This command only prepares the shared administration console. It does not create
TTS, Audio Connector, or customer Widget deployments. Those remain managed by
their existing installers and by the new web wizards.

Before continuing, prepare:
  • Genesys region — the host from your Genesys login URL, e.g. euw2.pure.cloud.
  • A Genesys OAuth client with grant type Client Credentials — Admin >
    Integrations > OAuth; assign the Integrations, OAuth, Authorization, Groups
    and Organization permissions. Do not use a Code Authorization client here.
    The browser login uses a separate Code Authorization client that this wizard
    creates or reuses later.
  • Telnyx API key — Mission Control Portal > Auth > API Keys; it must access
    account balance, AI Assistants and Text-to-Speech.
  • Telnyx webhook public key — Mission Control Portal > Keys & Credentials >
    Public Key; it is the Ed25519 trust anchor for incoming Telnyx webhooks.
  • Public HTTPS origin — the stable URL serving this Next.js application.
  • PostgreSQL URL — a postgres:// or postgresql:// connection string.

Only the PostgreSQL bootstrap and ADMIN_SECRETS_MASTER_KEY remain in .env.
Genesys, Telnyx and runtime credentials are encrypted in PostgreSQL with
AES-256-GCM. Keep a secure backup of the master key; encrypted values cannot be
recovered without it.
`);
}

async function collectStorageBootstrap() {
  const values = {};
  if (!isPostgresConfigured()) {
    const database = await collectValue("DATABASE_URL", "PostgreSQL connection URL", {
      secret: true,
      validate(value) {
        try {
          const url = new URL(String(value || ""));
          return ["postgres:", "postgresql:"].includes(url.protocol)
            ? true
            : "Use a postgres:// or postgresql:// URL";
        } catch { return "Enter a valid PostgreSQL URL"; }
      },
    });
    values.DATABASE_URL = database.value;
  }
  if (Object.keys(values).length) {
    await saveInstallerEnvironmentValues({
      values,
      allowedNames: BOOTSTRAP_ENVIRONMENT_NAMES,
      replaceNames: BOOTSTRAP_ENVIRONMENT_NAMES,
      envFile: path.resolve(".env"),
    });
    Object.assign(process.env, values);
  }
  await withSpinner("Connecting to PostgreSQL and ensuring the schema", ensurePostgresSchema);
  const existingKey = String(process.env[ADMIN_SECRETS_MASTER_KEY] || "").trim();
  if (!existingKey && await hasEncryptedRuntimeSecrets()) {
    throw new Error(
      `${ADMIN_SECRETS_MASTER_KEY} is missing but PostgreSQL already contains encrypted values. ` +
      "Restore the original key from the deployment secret-manager backup; generating a new key cannot recover them."
    );
  }
  const masterKey = existingKey || generateSecretsMasterKey();
  decodeSecretsMasterKey(masterKey);
  if (!existingKey) {
    if (process.env.INSTALLER_ENV_READ_ONLY === "1") {
      throw new Error(
        `${ADMIN_SECRETS_MASTER_KEY} must be generated by the Docker bootstrap before genesys:deploy`
      );
    }
    await saveInstallerEnvironmentValues({
      values: { [ADMIN_SECRETS_MASTER_KEY]: masterKey },
      allowedNames: BOOTSTRAP_ENVIRONMENT_NAMES,
      replaceNames: BOOTSTRAP_ENVIRONMENT_NAMES,
      envFile: path.resolve(".env"),
    });
  }
  process.env[ADMIN_SECRETS_MASTER_KEY] = masterKey;
  await hydrateRuntimeSecrets({ force: true });
  return { ...values, [ADMIN_SECRETS_MASTER_KEY]: masterKey };
}

async function collectProviderConfiguration() {
  const collected = {};
  const add = async (name, prompt, options) => {
    const result = await collectValue(name, prompt, options);
    if (result.value) collected[name] = result.value;
  };
  await add("GC_INSTALLATION_KEY", "Stable installation key (for example dev or prod)", {
    validate(value) {
      try { normalizeInstallationKey(value, { required: true }); return true; }
      catch (error) { return error.message; }
    },
  });
  process.env.GC_INSTALLATION_KEY = collected.GC_INSTALLATION_KEY || process.env.GC_INSTALLATION_KEY;
  await add("GC_INSTALLATION_NAME", "Unique installation display name", {
    defaultValue: suggestedInstallationName(process.env.GC_INSTALLATION_KEY),
    validate(value) {
      try { normalizeInstallationName(value, { required: true }); return true; }
      catch (error) { return error.message; }
    },
  });
  process.env.GC_INSTALLATION_NAME = collected.GC_INSTALLATION_NAME || process.env.GC_INSTALLATION_NAME;
  const regionLabels = {
    us_east_1: "Americas — US East (Virginia)",
    us_west_2: "Americas — US West (Oregon)",
    ca_central_1: "Americas — Canada",
    sa_east_1: "Americas — São Paulo",
    mx_central_1: "Americas — Mexico",
    eu_west_1: "Europe — Dublin",
    eu_west_2: "Europe — London",
    eu_central_1: "Europe — Frankfurt",
    eu_central_2: "Europe — Zurich",
    eusc_de_east_1: "Europe — EU Sovereign Cloud Germany",
    ap_southeast_2: "Asia Pacific — Sydney",
    ap_southeast_1: "Asia Pacific — Singapore",
    ap_northeast_1: "Asia Pacific — Tokyo",
    ap_northeast_2: "Asia Pacific — Seoul",
    ap_northeast_3: "Asia Pacific — Osaka",
    ap_south_1: "Asia Pacific — Mumbai",
    me_central_1: "Middle East — UAE",
    us_east_2: "US Government — East",
  };
  const currentRegion = String(process.env.GC_ENVIRONMENT || "").trim();
  const regions = Object.entries(platformClient.PureCloudRegionHosts).sort((left, right) => {
    if (left[1] === currentRegion) return -1;
    if (right[1] === currentRegion) return 1;
    return String(regionLabels[left[0]] || left[0]).localeCompare(String(regionLabels[right[0]] || right[0]));
  });
  const region = await selectMenu(
    "Genesys Cloud region",
    regions.map(([key, host]) => ({
      label: `${regionLabels[key] || key} — ${host}${host === currentRegion ? " (current)" : ""}`,
      value: host,
    })),
    { pageSize: 20 }
  );
  collected.GC_ENVIRONMENT = region;
  process.env.GC_ENVIRONMENT = region;
  await add(
    "GC_CLIENT_CRED_CLIENT_ID",
    "Genesys OAuth client ID (grant type: Client Credentials)"
  );
  await add(
    "GC_CLIENT_CRED_CLIENT_SECRET",
    "Genesys OAuth client secret (grant type: Client Credentials)",
    { secret: true }
  );
  await add("TELNYX_API_KEY", "Telnyx API key", { secret: true });
  await add(
    "TELNYX_PUBLIC_KEY",
    "Telnyx webhook public key (Keys & Credentials > Public Key)",
    {
      validate(value) {
        try { normalizeTelnyxPublicKey(value); return true; }
        catch (error) { return error.message; }
      },
    }
  );
  await add("GC_PUBLIC_BASE_URL", "Public HTTPS application origin", {
    validate(value) {
      try { normalizePublicApplicationOrigin(value); return true; }
      catch (error) { return error.message; }
    },
  });
  if (present("GC_CLIENT_ID")) {
    await add("GC_CLIENT_ID", "Existing Genesys Code Authorization client ID");
  } else if (await confirm("Reuse an existing Genesys Code Authorization OAuth client?", false)) {
    await add("GC_CLIENT_ID", "Genesys Code Authorization client ID");
  }
  if (collected.GC_CLIENT_ID && (present("GC_CLIENT_SECRET") || await confirm("Does this Code Authorization client have a client secret?", true))) {
    await add("GC_CLIENT_SECRET", "Genesys Code Authorization client secret", { secret: true });
  }
  Object.assign(process.env, collected);
  const handoffSecret = process.env.GENESYS_HANDOFF_API_KEY || randomBytes(32).toString("hex");
  const generated = {
    ...(!present("WIDGET_SESSION_SIGNING_SECRET") ? { WIDGET_SESSION_SIGNING_SECRET: randomBytes(32).toString("hex") } : {}),
    ...(!present("WIDGET_HANDOFF_API_KEY") ? { WIDGET_HANDOFF_API_KEY: handoffSecret } : {}),
    ...(!present("GENESYS_HANDOFF_API_KEY") ? { GENESYS_HANDOFF_API_KEY: handoffSecret } : {}),
    ...(!present("GC_OPEN_MESSAGING_SECRET") ? { GC_OPEN_MESSAGING_SECRET: randomBytes(32).toString("hex") } : {}),
    ...(!present("GC_AUDIO_CONNECTOR_API_KEY") ? { GC_AUDIO_CONNECTOR_API_KEY: randomBytes(32).toString("hex") } : {}),
    ...(!present("GC_AUDIO_CONNECTOR_CLIENT_SECRET") ? { GC_AUDIO_CONNECTOR_CLIENT_SECRET: randomBytes(32).toString("base64") } : {}),
    ...(!present("GC_AUDIO_HANDOFF_API_KEY") ? { GC_AUDIO_HANDOFF_API_KEY: handoffSecret } : {}),
  };
  Object.assign(collected, generated);
  Object.assign(process.env, generated);
  return collected;
}

async function validateConnections() {
  const genesys = await withSpinner("Validating Genesys Cloud credentials and organization", () =>
    verifyGenesysPlatformAccess({
      environment: process.env.GC_ENVIRONMENT,
      clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
      clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
    })
  );
  printCheck("Genesys Cloud", "ok", `${genesys.organization.name} (${genesys.organization.id})`);
  await withSpinner("Validating Telnyx account and AI Assistant access", () =>
    verifyTelnyxPlatformAccess({ apiKey: process.env.TELNYX_API_KEY, capability: "audio" })
  );
  await withSpinner("Validating Telnyx Text-to-Speech access", () =>
    verifyTelnyxPlatformAccess({ apiKey: process.env.TELNYX_API_KEY, capability: "tts" })
  );
  normalizeTelnyxPublicKey(process.env.TELNYX_PUBLIC_KEY);
  printCheck("Telnyx API", "ok", "account, AI Assistants and TTS are accessible");
  printCheck("Telnyx webhook public key", "ok", "valid 32-byte Ed25519 key");
  const schema = await withSpinner("Checking the PostgreSQL schema", ensurePostgresSchema);
  printCheck("PostgreSQL", "ok", `schema version ${schema.version}`);
  return genesys;
}

async function selectAdministrators(context, groupName) {
  const group = context.groups.find(({ name }) => name === groupName);
  const existingMembers = group
    ? await withSpinner("Loading current administrator group members", () =>
        listAllGroupMembers(context.groupsApi, group.id)
      )
    : [];
  const existingIds = new Set(existingMembers.map(({ id }) => id));
  return searchableCheckboxMenu(
    `Select accounts for ${groupName}`,
    context.users.map((user) => ({
      label: user.name || user.email || user.username || user.id,
      value: user.id,
      description: [user.email, user.username].filter(Boolean).join(" · "),
      checked: existingIds.has(user.id),
    })),
    {
      pageSize: 20,
      searchPlaceholder: "Filter Genesys users by name, email or login",
      validate(values) { return values.length ? true : "Select at least one administrator"; },
    }
  );
}

function printCollisionEntry(prefix, resource) {
  const suffix = [resource.id, resource.url].filter(Boolean).join(" · ");
  console.log(`  ${prefix} ${resource.type}: ${resource.name}${suffix ? ` (${suffix})` : ""}`);
}

async function reviewInstallationCollisions(context, resourceNames) {
  const report = await withSpinner("Scanning Genesys and Telnyx for installation name collisions", () =>
    inspectInstallationCollisions({
      context,
      names: resourceNames,
      baseUrl: process.env.GC_PUBLIC_BASE_URL,
      telnyxApiKey: process.env.TELNYX_API_KEY,
      ownedIds: [
        process.env.GC_WIDGET_ADMIN_GROUP_ID,
        process.env.GC_WIDGET_ADMIN_ROLE_ID,
        process.env.GC_CLIENT_ID,
      ],
    })
  );
  printCheck("Installation collision scan", report.collisions.length ? "warning" : "ok",
    `${report.scanned} named resources checked`);
  if (report.related.length) {
    console.log("\nOther Telnyx Integrations namespaces found (kept separate):");
    report.related.forEach((resource) => printCollisionEntry("•", resource));
  }
  if (!report.collisions.length) return report;
  console.log(color.warning("\nResources already use names reserved for this installation:"));
  report.collisions.forEach((resource) => printCollisionEntry("!", resource));
  const accepted = await confirm(
    "Explicitly adopt and update these matching resources for this installation?",
    false
  );
  return accepted ? report : null;
}

async function runInteractive() {
  printIntroduction();
  await collectStorageBootstrap();
  await collectProviderConfiguration();
  const verified = await validateConnections();
  const stored = await withSpinner("Encrypting runtime credentials in PostgreSQL", () =>
    saveEncryptedRuntimeSecrets(managedSecretsFromEnvironment())
  );
  if (process.env.INSTALLER_ENV_READ_ONLY !== "1") {
    await deleteInstallerEnvironmentValues({
      names: MANAGED_RUNTIME_SECRET_NAMES,
      environment: {},
      envFile: path.resolve(".env"),
    });
  }
  printCheck("Encrypted secret store", "ok", `${stored.saved} values stored; plaintext .env entries removed`);
  const context = await withSpinner("Loading Genesys administration inventory", () =>
    loadAdminConsoleGenesysContext({
      environment: process.env.GC_ENVIRONMENT,
      clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
      clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
      includeUsers: true,
    })
  );
  const resourceNames = installationResourceNames();
  const collisionReport = await reviewInstallationCollisions(context, resourceNames);
  if (!collisionReport) {
    console.log(color.warning("Bootstrap cancelled before any Genesys or Telnyx resource was changed."));
    return;
  }
  const adminUserIds = await selectAdministrators(context, resourceNames.adminGroup);
  const oauthAdoptionCandidates = collisionReport.collisions.filter(
    (resource) => resource.type === "Genesys OAuth client" &&
      resource.name === resourceNames.adminOauthClient
  );
  if (oauthAdoptionCandidates.length > 1) {
    throw new Error(
      `More than one Genesys OAuth client is named ${resourceNames.adminOauthClient}; remove the duplicate before bootstrap`
    );
  }
  if (oauthAdoptionCandidates.length === 1 && !present("GC_CLIENT_SECRET")) {
    const adoptedSecret = await collectValue(
      "GC_CLIENT_SECRET",
      "Existing Genesys Code Authorization client secret required to adopt this OAuth client",
      { secret: true }
    );
    process.env.GC_CLIENT_SECRET = adoptedSecret.value;
  }
  console.log(`
Target organization: ${color.bold(context.organization.name)}
Admin URL: ${color.accent(`${process.env.GC_PUBLIC_BASE_URL}/genesys/widget-admin`)}
Installation: ${resourceNames.installationName} (${resourceNames.installationKey})
Administrator group: ${resourceNames.adminGroup}
Selected administrators: ${adminUserIds.length}
`);
  if (!(await confirm("Create or update the shared Genesys administration application?", false))) {
    console.log(color.warning("Bootstrap cancelled; verified credentials remain encrypted in PostgreSQL."));
    return;
  }
  const result = await provisionGenesysAdminConsole({
    context,
    baseUrl: normalizePublicApplicationOrigin(process.env.GC_PUBLIC_BASE_URL),
    adminUserIds,
    oauthClientId: process.env.GC_CLIENT_ID,
    oauthClientSecret: process.env.GC_CLIENT_SECRET,
    adoptOauthClientId: oauthAdoptionCandidates[0]?.id,
    resourceNames,
    onProgress: ({ status, label }) => printProgress(status, label),
  });
  const environmentValues = {
    GC_ORGANIZATION_ID: verified.organization.id,
    GC_WIDGET_ADMIN_GROUP_ID: result.groups[0].id,
    GC_WIDGET_ADMIN_ROLE_ID: result.role.id,
    GC_CLIENT_ID: result.oauth.id,
    ...(result.oauth.secret ? { GC_CLIENT_SECRET: result.oauth.secret } : {}),
  };
  Object.assign(process.env, environmentValues);
  await withSpinner("Encrypting generated Genesys application credentials", () =>
    saveEncryptedRuntimeSecrets(environmentValues)
  );
  if (process.env.INSTALLER_ENV_READ_ONLY !== "1") {
    await deleteInstallerEnvironmentValues({
      names: MANAGED_RUNTIME_SECRET_NAMES,
      environment: {},
      envFile: path.resolve(".env"),
    });
  }

  console.log(color.success("\nAdministration console is ready."));
  console.log(`
Open it from Genesys Cloud:
  1. Sign out and back in if the role was assigned for the first time.
  2. Open the Apps menu in Genesys Cloud.
  3. Select “${resourceNames.adminClientApplication}”.
  4. Authenticate in the Genesys popup when prompted.

Direct URL: ${result.clientApplication.url}
OAuth callback: ${result.oauth.callbackUrl}
Telnyx insight group webhook: ${process.env.GC_PUBLIC_BASE_URL}/api/webhooks/telnyx/insights

TTS, Audio Connector and Web Chat configuration is now managed exclusively in this Web Admin application.
`);
}

function printHelp() {
  console.log("Usage: npm run genesys:deploy\n\nInteractive bootstrap with AES-256-GCM encrypted PostgreSQL secret storage.");
}

async function main() {
  if (process.argv.slice(2).some((value) => ["help", "--help", "-h"].includes(value))) {
    printHelp();
    return;
  }
  await runInteractive();
}

main()
  .catch((error) => {
    if (error?.name === "ExitPromptError") {
      process.stderr.write("\nBootstrap cancelled.\n");
      process.exitCode = 130;
      return;
    }
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePostgresPool().catch(() => undefined));
