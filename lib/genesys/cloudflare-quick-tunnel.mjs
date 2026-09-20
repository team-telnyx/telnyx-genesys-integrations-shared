import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_TUNNEL_ATTEMPTS = 2;
const POLL_INTERVAL_MS = 500;
const WAIT_PROGRESS_INTERVAL_MS = 10_000;

export const SHARED_QUICK_TUNNEL_STATE_ROOT = path.resolve(
  ".genesys-shared",
  "tunnel"
);
export const LEGACY_AUDIO_QUICK_TUNNEL_STATE_ROOT = path.resolve(
  ".genesys-audio",
  "tunnel"
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isCloudflareQuickTunnelUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname) &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function parseCloudflareQuickTunnelUrl(output) {
  const match = String(output || "").match(QUICK_TUNNEL_URL_PATTERN);
  return match ? new URL(match[0]).origin : null;
}

export function quickTunnelPaths(
  stateRoot = SHARED_QUICK_TUNNEL_STATE_ROOT
) {
  const root = path.resolve(stateRoot);
  return {
    root,
    state: path.join(root, "state.json"),
    serverLog: path.join(root, "server.log"),
    cloudflaredLog: path.join(root, "cloudflared.log"),
    cloudflaredPid: path.join(root, "cloudflared.pid"),
  };
}

async function readQuickTunnelStateFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read Quick Tunnel state: ${error.message}`);
  }
}

export async function migrateLegacyQuickTunnelState({
  sharedStateRoot = SHARED_QUICK_TUNNEL_STATE_ROOT,
  legacyStateRoot = LEGACY_AUDIO_QUICK_TUNNEL_STATE_ROOT,
} = {}) {
  const shared = quickTunnelPaths(sharedStateRoot);
  const legacy = quickTunnelPaths(legacyStateRoot);
  if (shared.root === legacy.root) return { migrated: false, state: null };

  const current = await readQuickTunnelStateFile(shared.state);
  if (current) return { migrated: false, state: current };

  const previous = await readQuickTunnelStateFile(legacy.state);
  if (!previous) return { migrated: false, state: null };
  if (previous.schemaVersion !== 1 || previous.mode !== "quick-tunnel-demo") {
    throw new Error(
      `Refusing to migrate unsupported legacy Quick Tunnel state ${legacy.state}`
    );
  }

  // Keep legacy log paths in a running-process snapshot. Renaming a log that is
  // currently open by cloudflared would make diagnostics misleading. A newly
  // started tunnel will use the shared directory for all files.
  const migrated = {
    ...previous,
    migratedAt: new Date().toISOString(),
    migratedFrom: legacy.root,
  };
  await writeJsonAtomic(shared.state, migrated);
  return { migrated: true, state: migrated, from: legacy.root, to: shared.root };
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

export async function readQuickTunnelState({ stateRoot } = {}) {
  if (stateRoot === undefined) await migrateLegacyQuickTunnelState();
  const paths = quickTunnelPaths(stateRoot);
  return readQuickTunnelStateFile(paths.state);
}

export function processIsRunning(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 1) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function processCommand(pid, execFileImpl = execFileAsync) {
  if (!processIsRunning(pid)) return "";
  try {
    const result = await execFileImpl("ps", ["-p", String(pid), "-o", "command="]);
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

async function processMatches(pid, markers, execFileImpl = execFileAsync) {
  const command = await processCommand(pid, execFileImpl);
  return Boolean(command) && markers.every((marker) => command.includes(marker));
}

async function terminateManagedProcess(pid, markers, execFileImpl = execFileAsync) {
  if (!processIsRunning(pid)) return { pid, stopped: false, alreadyStopped: true };
  if (!(await processMatches(pid, markers, execFileImpl))) {
    return { pid, stopped: false, refused: true };
  }
  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return { pid, stopped: false, alreadyStopped: true };
    throw error;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processIsRunning(pid)) return { pid, stopped: true };
    await delay(250);
  }
  if (await processMatches(pid, markers, execFileImpl)) {
    process.kill(target, "SIGKILL");
    return { pid, stopped: true, forced: true };
  }
  return { pid, stopped: false, refused: true };
}

export async function checkTunnelHealth(
  baseUrl,
  { fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}
) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch API is required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/api/health`, {
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return {
      ok:
        response.ok &&
        body?.status === "ok" &&
        body?.service === "telnyx-genesys-integrations",
      status: response.status,
      service: body?.service || null,
      audioConnectorConfigured: body?.audioConnector?.configured === true,
      widgetDatabaseReady: body?.database?.ready === true,
    };
  } catch (error) {
    const cause = error?.cause;
    const causeDetail = [cause?.code, cause?.message].filter(Boolean).join(": ");
    return {
      ok: false,
      status: 0,
      error: `${error?.message || String(error)}${causeDetail ? ` (${causeDetail})` : ""}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function healthFailureDetail(result) {
  if (!result) return "no response";
  if (result.error) return result.error;
  if (result.status) {
    const contract = result.status === 200
      ? "response did not match the expected application health payload"
      : `HTTP ${result.status}`;
    return contract;
  }
  return "no response";
}

async function waitForHealth(baseUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_START_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let nextProgressAt = startedAt + WAIT_PROGRESS_INTERVAL_MS;
  let result;
  while (Date.now() < deadline) {
    result = await checkTunnelHealth(baseUrl, options);
    if (result.ok) return result;
    if (typeof options.onWait === "function" && Date.now() >= nextProgressAt) {
      options.onWait({
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
        result,
      });
      nextProgressAt += WAIT_PROGRESS_INTERVAL_MS;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Health check did not become ready at ${baseUrl}/api/health` +
      `; last check: ${healthFailureDetail(result)}`
  );
}

async function spawnLogged(spawnImpl, command, args, { cwd, env, logPath }) {
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const log = await open(logPath, "a", 0o600);
  try {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return child;
  } finally {
    await log.close();
  }
}

async function waitForQuickTunnelUrl({ logPath, pid, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  while (Date.now() < deadline) {
    output = await readFile(logPath, "utf8").catch(() => "");
    const url = parseCloudflareQuickTunnelUrl(output);
    if (url) return url;
    if (!processIsRunning(pid)) {
      const tail = output.slice(-2_000).trim();
      throw new Error(`cloudflared stopped before returning a Quick Tunnel URL${tail ? `: ${tail}` : ""}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    "cloudflared did not return a Quick Tunnel URL before timeout. " +
      "Check cloudflared.log and remove any default .cloudflared/config.yml or config.yaml, " +
      "which Cloudflare does not support with Quick Tunnels."
  );
}

function normalizedPort(value) {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Quick Tunnel port must be an integer between 1 and 65535");
  }
  return port;
}

export async function getQuickTunnelStatus({ stateRoot, fetchImpl, execFileImpl } = {}) {
  const state = await readQuickTunnelState({ stateRoot });
  if (!state) return { running: false, healthy: false, state: null };
  const tunnelRunning = await processMatches(
    state.cloudflaredPid,
    [state.cloudflaredMarker || "cloudflared", "tunnel"],
    execFileImpl
  );
  const serverRunning = state.serverManaged
    ? await processMatches(state.serverPid, ["server.mjs"], execFileImpl)
    : (await checkTunnelHealth(state.localBaseUrl, { fetchImpl })).ok;
  const [localHealth, publicHealth] = await Promise.all([
    checkTunnelHealth(state.localBaseUrl, { fetchImpl }),
    state.publicBaseUrl
      ? checkTunnelHealth(state.publicBaseUrl, { fetchImpl })
      : { ok: false, status: 0, error: "Quick Tunnel URL is not available yet" },
  ]);
  return {
    running: tunnelRunning,
    healthy: tunnelRunning && localHealth.ok && publicHealth.ok,
    state,
    processes: {
      cloudflared: { pid: state.cloudflaredPid, running: tunnelRunning },
      server: {
        pid: state.serverPid || null,
        managed: Boolean(state.serverManaged),
        running: serverRunning,
      },
    },
    health: { local: localHealth, public: publicHealth },
  };
}

export function managedQuickTunnelCanBeReused(status, { port } = {}) {
  const expectedPort = port == null ? null : normalizedPort(port);
  const compatible =
    status?.processes?.cloudflared?.running === true &&
    isCloudflareQuickTunnelUrl(status?.state?.publicBaseUrl) &&
    (expectedPort == null || status?.state?.port === expectedPort);
  if (!compatible) return false;
  if (status.healthy) return true;
  return (
    status?.health?.local?.ok === false &&
    Number(status?.health?.public?.status || 0) > 0
  );
}

export async function stopCloudflareQuickTunnel({ stateRoot, execFileImpl } = {}) {
  const paths = quickTunnelPaths(stateRoot);
  const state = await readQuickTunnelState({ stateRoot });
  if (!state) return { stopped: false, alreadyStopped: true, state: null };
  const cloudflared = await terminateManagedProcess(
    state.cloudflaredPid,
    [state.cloudflaredMarker || "cloudflared", "tunnel"],
    execFileImpl
  );
  const server = state.serverManaged
    ? await terminateManagedProcess(state.serverPid, ["server.mjs"], execFileImpl)
    : { stopped: false, external: true };
  if (cloudflared.refused || server.refused) {
    throw new Error(
      "Refusing to stop a PID whose command no longer matches the managed Quick Tunnel state"
    );
  }
  await Promise.all([
    unlink(paths.state).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
    unlink(paths.cloudflaredPid).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    }),
  ]);
  return { stopped: true, state, processes: { cloudflared, server } };
}

export async function startCloudflareQuickTunnel({
  stateRoot,
  projectRoot = process.cwd(),
  port = process.env.PORT || 3000,
  development = true,
  cloudflaredBinary = process.env.CLOUDFLARED_BIN || "cloudflared",
  environment = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = nodeSpawn,
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
  // How long to wait for cloudflared to print its Quick Tunnel URL. Separate
  // from timeoutMs because the two waits have nothing in common: this one is a
  // local process writing a line to its log, bounded by how fast the machine
  // can start it, and timeoutMs bounds a remote endpoint becoming reachable —
  // the wait whose exhaustion deliberately triggers another tunnel attempt.
  // Sharing one budget meant a slow spawn was indistinguishable from an
  // unreachable endpoint, and on a loaded machine the URL wait lost the race
  // and failed the whole start.
  urlTimeoutMs = timeoutMs,
  tunnelAttempts = DEFAULT_TUNNEL_ATTEMPTS,
  retainBootstrapServer = false,
  onProgress = () => {},
} = {}) {
  if (typeof onProgress !== "function") throw new Error("onProgress must be a function");
  const maximumTunnelAttempts = Number(tunnelAttempts);
  if (!Number.isInteger(maximumTunnelAttempts) || maximumTunnelAttempts < 1 || maximumTunnelAttempts > 3) {
    throw new Error("Quick Tunnel attempts must be an integer between 1 and 3");
  }
  const report = (status, stage, label, detail = "") => {
    onProgress({ status, stage, label, detail });
  };
  const paths = quickTunnelPaths(stateRoot);
  const resolvedPort = normalizedPort(port);
  const localBaseUrl = `http://127.0.0.1:${resolvedPort}`;
  report("active", "existing-state", "Checking existing managed tunnel state");
  const current = await getQuickTunnelStatus({ stateRoot, fetchImpl, execFileImpl });
  const compatibleTunnel =
    current.processes?.cloudflared?.running &&
    current.state?.port === resolvedPort &&
    isCloudflareQuickTunnelUrl(current.state?.publicBaseUrl);
  if (managedQuickTunnelCanBeReused(current, { port: resolvedPort })) {
    report(
      current.healthy ? "success" : "warning",
      "existing-state",
      current.healthy
        ? "Reusing healthy managed Quick Tunnel"
        : "Reusing reachable managed Quick Tunnel; start the local application to restore health",
      current.state.publicBaseUrl
    );
    return {
      ...current.state,
      reused: true,
      applicationRunning: current.health?.local?.ok === true,
      health: current.health,
    };
  }
  if (current.state) {
    report(
      "warning",
      "existing-state",
      compatibleTunnel
        ? "Managed Quick Tunnel is unavailable and will be replaced"
        : "Removing stale managed tunnel state",
      current.state.publicBaseUrl || ""
    );
    await stopCloudflareQuickTunnel({ stateRoot, execFileImpl });
  } else {
    report("success", "existing-state", "No reusable managed tunnel found");
  }

  try {
    report("active", "cloudflared", "Checking cloudflared executable");
    const version = await execFileImpl(cloudflaredBinary, ["--version"]);
    report(
      "success",
      "cloudflared",
      "cloudflared executable is available",
      String(version?.stdout || "").trim().split("\n", 1)[0]
    );
  } catch (error) {
    throw new Error(
      `cloudflared is required for Quick Tunnel mode but could not be executed: ${error.message}`
    );
  }

  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await Promise.all([
    writeFile(paths.serverLog, "", { mode: 0o600 }),
    writeFile(paths.cloudflaredLog, "", { mode: 0o600 }),
  ]);
  await Promise.all([
    chmod(paths.serverLog, 0o600),
    chmod(paths.cloudflaredLog, 0o600),
  ]);

  let serverPid = null;
  let serverManaged = false;
  let cloudflaredPid = null;
  const stateSnapshot = (overrides = {}) => ({
    schemaVersion: 1,
    mode: "quick-tunnel-demo",
    status: "starting",
    createdAt: new Date().toISOString(),
    projectRoot: path.resolve(projectRoot),
    port: resolvedPort,
    localBaseUrl,
    publicBaseUrl: null,
    serverManaged,
    serverPid,
    cloudflaredPid,
    cloudflaredMarker: path.basename(cloudflaredBinary),
    logs: {
      server: paths.serverLog,
      cloudflared: paths.cloudflaredLog,
    },
    ...overrides,
  });
  try {
    report("active", "local-health", `Checking local application at ${localBaseUrl}`);
    const existingHealth = await checkTunnelHealth(localBaseUrl, { fetchImpl });
    if (!existingHealth.ok) {
      report("active", "local-server", `Starting local application on port ${resolvedPort}`);
      const server = await spawnLogged(
        spawnImpl,
        process.execPath,
        ["server.mjs", ...(development ? ["--dev"] : [])],
        {
          cwd: path.resolve(projectRoot),
          env: {
            ...environment,
            PORT: String(resolvedPort),
          },
          logPath: paths.serverLog,
        }
      );
      serverPid = server.pid;
      serverManaged = true;
      await writeJsonAtomic(paths.state, stateSnapshot({ status: "starting-server" }));
      await waitForHealth(localBaseUrl, {
        fetchImpl,
        timeoutMs,
        onWait: ({ elapsedSeconds, result }) => report(
          "active",
          "local-health",
          `Waiting for local application (${elapsedSeconds}s)`,
          healthFailureDetail(result)
        ),
      });
      report("success", "local-health", "Local application health check passed", localBaseUrl);
    } else {
      report("success", "local-health", "Reusing healthy local application", localBaseUrl);
    }

    let publicBaseUrl;
    let publicHealth;
    let state;
    for (let attempt = 1; attempt <= maximumTunnelAttempts; attempt += 1) {
      await writeFile(paths.cloudflaredLog, "", { mode: 0o600 });
      report(
        "active",
        "tunnel-process",
        `Starting Cloudflare Quick Tunnel (attempt ${attempt}/${maximumTunnelAttempts})`
      );
      const cloudflared = await spawnLogged(
        spawnImpl,
        cloudflaredBinary,
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          localBaseUrl,
          "--loglevel",
          "info",
          "--pidfile",
          paths.cloudflaredPid,
        ],
        {
          cwd: path.resolve(projectRoot),
          env: environment,
          logPath: paths.cloudflaredLog,
        }
      );
      cloudflaredPid = cloudflared.pid;
      await writeJsonAtomic(paths.state, stateSnapshot({ status: "starting-tunnel" }));
      report("active", "public-url", "Waiting for the temporary trycloudflare.com URL");
      publicBaseUrl = await waitForQuickTunnelUrl({
        logPath: paths.cloudflaredLog,
        pid: cloudflaredPid,
        timeoutMs: Math.max(Number(urlTimeoutMs) || 0, POLL_INTERVAL_MS),
      });
      report("success", "public-url", "Cloudflare assigned a temporary public URL", publicBaseUrl);
      state = stateSnapshot({
        status: "validating-public-health",
        publicBaseUrl,
      });
      await writeJsonAtomic(paths.state, state);
      report("active", "public-health", "Validating public application health", publicBaseUrl);
      try {
        publicHealth = await waitForHealth(publicBaseUrl, {
          fetchImpl,
          timeoutMs,
          onWait: ({ elapsedSeconds, result }) => report(
            "active",
            "public-health",
            `Waiting for public endpoint (${elapsedSeconds}s)`,
            healthFailureDetail(result)
          ),
        });
        report("success", "public-health", "Public application health check passed", publicBaseUrl);
        break;
      } catch (error) {
        if (attempt >= maximumTunnelAttempts) throw error;
        report(
          "warning",
          "public-health",
          "Public endpoint did not become ready; requesting a new Quick Tunnel URL",
          error.message
        );
        const stopped = await terminateManagedProcess(
          cloudflaredPid,
          [path.basename(cloudflaredBinary), "tunnel"],
          execFileImpl
        );
        if (stopped.refused) {
          throw new Error(
            "Refusing to replace a Quick Tunnel process whose command no longer matches managed state"
          );
        }
        cloudflaredPid = null;
        await unlink(paths.cloudflaredPid).catch(() => {});
      }
    }
    let readyState = { ...state, status: "healthy", readyAt: new Date().toISOString() };
    await writeJsonAtomic(paths.state, readyState);
    report("success", "ready", "Cloudflare Quick Tunnel is ready", publicBaseUrl);
    if (serverManaged && !retainBootstrapServer) {
      report(
        "active",
        "local-server-stop",
        "Stopping the temporary local application"
      );
      const stopped = await terminateManagedProcess(
        serverPid,
        ["server.mjs"],
        execFileImpl
      );
      if (stopped.refused) {
        throw new Error(
          "Refusing to stop the temporary local server because its process identity changed"
        );
      }
      readyState = {
        ...readyState,
        status: "waiting-for-local-server",
        serverManaged: false,
        serverPid: null,
        bootstrapServerStoppedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(paths.state, readyState);
      serverManaged = false;
      serverPid = null;
      report(
        "success",
        "local-server-stop",
        "Temporary local application stopped",
        "Start it in the foreground with npm run dev"
      );
    }
    return {
      ...readyState,
      reused: false,
      applicationRunning: readyState.status === "healthy",
      health: {
        local: readyState.status === "healthy"
          ? await checkTunnelHealth(localBaseUrl, { fetchImpl })
          : { ok: false, status: 0, error: "Local application is intentionally stopped" },
        public: publicHealth,
      },
    };
  } catch (error) {
    report(
      "failure",
      "cleanup",
      "Cloudflare Quick Tunnel startup failed",
      `${error.message}; logs: ${paths.serverLog}, ${paths.cloudflaredLog}`
    );
    if (cloudflaredPid) {
      await terminateManagedProcess(
        cloudflaredPid,
        [path.basename(cloudflaredBinary), "tunnel"],
        execFileImpl
      ).catch(() => {});
    }
    if (serverManaged && serverPid) {
      await terminateManagedProcess(serverPid, ["server.mjs"], execFileImpl).catch(() => {});
    }
    await Promise.all([
      unlink(paths.state).catch(() => {}),
      unlink(paths.cloudflaredPid).catch(() => {}),
    ]);
    throw error;
  }
}
