import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { parse as parseDotenv } from "dotenv";

import { isCloudflareQuickTunnelUrl } from "./cloudflare-quick-tunnel.mjs";
import { saveInstallerEnvironmentValues } from "./installer-environment.mjs";
import {
  deleteEncryptedRuntimeSecrets,
  encryptedSecretStoreConfigured,
  saveEncryptedRuntimeSecrets,
} from "./encrypted-secret-store.mjs";

export const GENESYS_SHARED_STATE_DIRECTORY = ".genesys-shared";
export const PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE = "GC_PUBLIC_BASE_URL";

export function normalizePublicApplicationOrigin(value) {
  const configured = String(value || "").trim();
  if (!configured) throw new Error("GC_PUBLIC_BASE_URL is required");
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("GC_PUBLIC_BASE_URL must be a valid absolute URL");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== configured.replace(/\/$/, "") ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("GC_PUBLIC_BASE_URL must contain only a public HTTPS origin");
  }
  return url.origin;
}

export function managedPublicOriginWriteOptions(currentUrl) {
  const configured = String(currentUrl || "").trim();
  return {
    replaceManagedPublicBaseUrl: true,
    replaceNames:
      configured && !isCloudflareQuickTunnelUrl(configured)
        ? [PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE]
        : [],
  };
}

export async function savePublicOriginEnvironmentValue({
  publicBaseUrl,
  environment = process.env,
  envFile = path.resolve(".env"),
  replaceManagedPublicBaseUrl = false,
  replaceNames = [],
} = {}) {
  const normalized = normalizePublicApplicationOrigin(publicBaseUrl);
  if (encryptedSecretStoreConfigured(environment)) {
    await saveEncryptedRuntimeSecrets({ [PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE]: normalized });
    environment[PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE] = normalized;
    return {
      saved: [PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE],
      envFile: "encrypted PostgreSQL secret store",
    };
  }
  return saveInstallerEnvironmentValues({
    values: { [PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE]: normalized },
    allowedNames: [PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE],
    replaceNames,
    mayReplace(name, current) {
      return name === PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE &&
        replaceManagedPublicBaseUrl &&
        isCloudflareQuickTunnelUrl(current);
    },
    environment,
    envFile,
  });
}

async function readEnvironmentFile(envFile) {
  try {
    const metadata = await lstat(envFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${envFile} must be a regular file, not a symlink`);
    }
    return await readFile(envFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function clearManagedPublicOrigin({
  expectedUrl,
  environment = process.env,
  envFile = path.resolve(".env"),
} = {}) {
  if (encryptedSecretStoreConfigured(environment)) {
    const current = String(environment.GC_PUBLIC_BASE_URL || "").trim();
    if (!current || current !== String(expectedUrl || "").trim()) {
      return { cleared: false, envFile: "encrypted PostgreSQL secret store" };
    }
    if (!isCloudflareQuickTunnelUrl(current)) {
      throw new Error("Refusing to clear a non-Quick-Tunnel GC_PUBLIC_BASE_URL");
    }
    await deleteEncryptedRuntimeSecrets([PUBLIC_ORIGIN_ENVIRONMENT_VARIABLE]);
    delete environment.GC_PUBLIC_BASE_URL;
    return { cleared: true, envFile: "encrypted PostgreSQL secret store" };
  }
  const source = await readEnvironmentFile(envFile);
  const lines = source.split(/\r?\n/);
  const pattern = /^\s*(?:export\s+)?GC_PUBLIC_BASE_URL\s*=(.*)$/;
  const matches = lines
    .map((line, index) => ({ line, index, match: line.match(pattern) }))
    .filter(({ match }) => match);
  if (matches.length > 1) {
    throw new Error("Refusing to update duplicate GC_PUBLIC_BASE_URL entries in .env");
  }
  if (!matches.length) return { cleared: false, envFile };
  const current = String(parseDotenv(matches[0].line).GC_PUBLIC_BASE_URL || "").trim();
  if (!current || current !== String(expectedUrl || "").trim()) {
    return { cleared: false, envFile };
  }
  if (!isCloudflareQuickTunnelUrl(current)) {
    throw new Error("Refusing to clear a non-Quick-Tunnel GC_PUBLIC_BASE_URL");
  }
  lines[matches[0].index] = "GC_PUBLIC_BASE_URL=";
  const output = `${lines.join("\n").replace(/\n+$/, "")}\n`;
  const temporary = `${envFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, envFile);
    await chmod(envFile, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  delete environment.GC_PUBLIC_BASE_URL;
  return { cleared: true, envFile };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function withPublicOriginMutationLock(
  operation,
  { stateDirectory = path.resolve(GENESYS_SHARED_STATE_DIRECTORY) } = {}
) {
  if (typeof operation !== "function") throw new Error("operation must be a function");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDirectory, "public-origin.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
    );
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw new Error(
        `Another public URL mutation is already running (${lockPath}). ` +
          "Remove the lock only after verifying that no installer process is active."
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function defaultAudioSynchronizer(options) {
  const { syncManagedDeploymentUrls } = await import(
    "../../scripts/manage-genesys-audio.mjs"
  );
  return syncManagedDeploymentUrls(options);
}

async function defaultWidgetSynchronizer(options) {
  const { syncManagedWidgetDeploymentUrls } = await import(
    "../../scripts/manage-genesys-widget.mjs"
  );
  return syncManagedWidgetDeploymentUrls(options);
}

async function defaultInsightsSynchronizer({ baseUrl, onProgress = () => {} } = {}) {
  const organizationId = String(process.env.GC_ORGANIZATION_ID || "").trim();
  if (!organizationId) return [];
  const [{ default: Telnyx }, insights] = await Promise.all([
    import("telnyx"),
    import("./admin-managed-insights.mjs"),
  ]);
  const tracked = await insights.getAdminManagedInsightProfile(organizationId);
  if (!tracked.group.id) return [];
  onProgress({
    status: "running",
    label: "Synchronize the managed Telnyx Insights Group webhook",
  });
  const result = await insights.ensureAdminManagedInsightProfile({
    telnyx: new Telnyx({ apiKey: process.env.TELNYX_API_KEY }),
    organizationId,
    environment: { ...process.env, GC_PUBLIC_BASE_URL: baseUrl },
  });
  onProgress({
    status: "succeeded",
    label: "Synchronize the managed Telnyx Insights Group webhook",
    detail: result.group.id,
  });
  return [{ id: result.group.id, name: result.group.name, webhookUrl: result.group.webhookUrl }];
}

export async function synchronizeAllManagedDeploymentUrls({
  baseUrl = process.env.GC_PUBLIC_BASE_URL,
  onProgress = () => {},
  syncAudio = defaultAudioSynchronizer,
  syncWidget = defaultWidgetSynchronizer,
  syncInsights = defaultInsightsSynchronizer,
  audioOptions = {},
  widgetOptions = {},
  insightOptions = {},
} = {}) {
  const publicBaseUrl = normalizePublicApplicationOrigin(baseUrl);
  let audio = [];
  let widgets = [];
  let insights = [];
  try {
    audio = await syncAudio({
      ...audioOptions,
      baseUrl: publicBaseUrl,
      onProgress,
    });
    widgets = await syncWidget({
      ...widgetOptions,
      baseUrl: publicBaseUrl,
      onProgress,
    });
    insights = await syncInsights({
      ...insightOptions,
      baseUrl: publicBaseUrl,
      onProgress,
    });
  } catch (error) {
    error.publicOriginSynchronization = {
      publicBaseUrl,
      audio: Array.isArray(audio) ? audio : [],
      widgets: Array.isArray(widgets) ? widgets : [],
      insights: Array.isArray(insights) ? insights : [],
    };
    throw error;
  }
  return {
    publicBaseUrl,
    audio: Array.isArray(audio) ? audio : [],
    widgets: Array.isArray(widgets) ? widgets : [],
    insights: Array.isArray(insights) ? insights : [],
    total: (Array.isArray(audio) ? audio.length : 0) +
      (Array.isArray(widgets) ? widgets.length : 0) +
      (Array.isArray(insights) ? insights.length : 0),
  };
}

export async function updateManagedPublicOrigin({
  baseUrl,
  previousBaseUrl = process.env.GC_PUBLIC_BASE_URL,
  environment = process.env,
  envFile = path.resolve(".env"),
  stateDirectory = path.resolve(GENESYS_SHARED_STATE_DIRECTORY),
  onProgress = () => {},
  syncAudio,
  syncWidget,
  syncInsights,
  audioOptions,
  widgetOptions,
  insightOptions,
} = {}) {
  const publicBaseUrl = normalizePublicApplicationOrigin(baseUrl);
  return withPublicOriginMutationLock(async () => {
    const operationId = randomUUID();
    const journalPath = path.join(
      stateDirectory,
      "public-origin-runs",
      `${operationId}.json`
    );
    const journal = {
      schemaVersion: 1,
      operationId,
      status: "running",
      startedAt: new Date().toISOString(),
      previousBaseUrl: String(previousBaseUrl || "").trim() || null,
      publicBaseUrl,
      remoteSynchronization: null,
      rollback: null,
      environmentUpdated: false,
    };
    await writeJsonAtomic(journalPath, journal);
    try {
      journal.remoteSynchronization = await synchronizeAllManagedDeploymentUrls({
        baseUrl: publicBaseUrl,
        onProgress,
        syncAudio,
        syncWidget,
        syncInsights,
        audioOptions,
        widgetOptions,
        insightOptions,
      });
      await savePublicOriginEnvironmentValue({
        publicBaseUrl,
        environment,
        envFile,
        ...managedPublicOriginWriteOptions(previousBaseUrl),
      });
      journal.environmentUpdated = true;
      journal.status = "completed";
      journal.completedAt = new Date().toISOString();
      await writeJsonAtomic(journalPath, journal);
      return { ...journal.remoteSynchronization, journalPath };
    } catch (error) {
      const previous = String(previousBaseUrl || "").trim();
      if (previous) {
        journal.rollback = { status: "running", startedAt: new Date().toISOString() };
        await writeJsonAtomic(journalPath, journal);
        try {
          const rollback = await synchronizeAllManagedDeploymentUrls({
            baseUrl: previous,
            onProgress,
            syncAudio,
            syncWidget,
            syncInsights,
            audioOptions,
            widgetOptions,
            insightOptions,
          });
          journal.rollback = {
            status: "completed",
            completedAt: new Date().toISOString(),
            result: rollback,
          };
        } catch (rollbackError) {
          journal.rollback = {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: String(rollbackError?.message || rollbackError),
          };
        }
      }
      journal.status = "failed";
      journal.completedAt = new Date().toISOString();
      journal.error = String(error?.message || error);
      await writeJsonAtomic(journalPath, journal);
      throw error;
    }
  }, { stateDirectory });
}
