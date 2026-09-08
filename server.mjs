#!/usr/bin/env node

import "dotenv/config";
import { createServer } from "node:http";
import { closePostgresPool, isPostgresConfigured } from "./lib/postgres.mjs";
import { ensurePostgresSchema } from "./lib/postgres-schema.mjs";
import { hydrateRuntimeSecrets } from "./lib/genesys/encrypted-secret-store.mjs";
import { stopInsightNotificationHub } from "./lib/telnyx/insight-notification-hub.mjs";
import {
  startGenesysWidgetVoiceNotifications,
  stopGenesysWidgetVoiceNotifications,
} from "./lib/genesys/widget-voice-notifications.mjs";
import {
  cleanupExpiredWidgetRuntimeData,
  startWidgetRuntimeCleanup,
} from "./lib/widgets/cleanup.mjs";

const development = process.argv.includes("--dev");
process.env.NODE_ENV = development ? "development" : "production";

const hostname = "0.0.0.0";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const widgetRuntimeConfigured = isPostgresConfigured();
let stopWidgetRuntimeCleanup = () => {};
if (widgetRuntimeConfigured) {
  console.log("[server] Ensuring PostgreSQL schema...");
  const postgresSchema = await ensurePostgresSchema();
  console.log(`[server] PostgreSQL schema ready at version ${postgresSchema.version}`);
  const runtimeSecrets = await hydrateRuntimeSecrets({ required: false, force: true });
  console.log(
    `[server] Encrypted runtime configuration loaded: ${Object.keys(runtimeSecrets).length} values`
  );
  const initialCleanup = await cleanupExpiredWidgetRuntimeData();
  console.log(
    `[server] Expired widget runtime cleanup: ${initialCleanup.sessions} sessions, ` +
      `${initialCleanup.handoffs} handoffs, ${initialCleanup.webhookEvents} webhook events, ` +
      `${initialCleanup.insightEvents} insight events`
  );
  stopWidgetRuntimeCleanup = startWidgetRuntimeCleanup();
} else {
  console.log("[server] Widget runtime disabled: PostgreSQL is not configured");
}

const [
  { default: next },
  { attachGenesysAudioConnector },
  { checkTunnelHealth, isCloudflareQuickTunnelUrl },
] = await Promise.all([
  import("next"),
  import("./lib/genesys/audio-connector-server.mjs"),
  import("./lib/genesys/cloudflare-quick-tunnel.mjs"),
]);

const app = next({ dev: development, hostname, port });
const handleNextRequest = app.getRequestHandler();
await app.prepare();
const handleNextUpgrade = app.getUpgradeHandler?.();

const server = createServer((request, response) => {
  void handleNextRequest(request, response).catch((error) => {
    console.error("[server] Next.js request failed:", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    if (!response.writableEnded) response.end("Internal Server Error");
  });
});

const audioConnector = attachGenesysAudioConnector(server);
audioConnector.handleNonAudioUpgrade = handleNextUpgrade;

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, hostname, () => {
    server.off("error", reject);
    resolve();
  });
});

const localUrl = `http://127.0.0.1:${port}`;
const publicUrl = String(process.env.GC_PUBLIC_BASE_URL || "").trim();
console.log(`[server] Local URL: ${localUrl}`);
console.log(`[server] Listening on http://${hostname}:${port}`);
console.log("[server] Telephone target normalization: enabled (leading tel: is stripped)");
console.log(
  `[server] Genesys Audio Connector WebSocket ${
    audioConnector.configured ? "enabled" : "disabled (configuration incomplete)"
  } on /api/genesys/audio-connector/ws`
);
if (widgetRuntimeConfigured) {
  void startGenesysWidgetVoiceNotifications().then((result) => {
    console.log(
      `[server] Genesys Widget voice notifications ${
        result.configured ? `enabled (${result.subscriptions} queue topics)` : "disabled"
      }`
    );
  }).catch((error) => {
    console.error("[server] Failed to start Genesys Widget voice notifications:", error.message);
  });
}
if (publicUrl) {
  const publicMode = isCloudflareQuickTunnelUrl(publicUrl)
    ? "Cloudflare Quick Tunnel"
    : "static HTTPS origin";
  console.log(`[server] Public URL (${publicMode}): ${publicUrl}`);
  console.log(`[server] Checking public availability via ${publicMode}...`);
  void checkTunnelHealth(publicUrl, { timeoutMs: 7_000 }).then((health) => {
    if (health.ok) {
      console.log(
        `[server] Public access available via ${publicMode}: ${publicUrl} (HTTP ${health.status})`
      );
      return;
    }
    const detail = health.error ||
      (health.status
        ? `HTTP ${health.status}; application health response is not ready`
        : "no response");
    console.warn(
      `[server] Public access unavailable via ${publicMode}: ${publicUrl} — ${detail}`
    );
  });
} else {
  console.log("[server] Public URL: not configured; application is available locally only");
}

let shutdownPromise;
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[server] Received ${signal}; shutting down`);
    stopWidgetRuntimeCleanup();
    const forcedExit = setTimeout(() => {
      console.error("[server] Graceful shutdown timed out");
      process.exit(1);
    }, 10_000);
    forcedExit.unref();

    await stopInsightNotificationHub().catch((error) => {
      console.error("[server] Failed to stop insight notification hub", error);
    });
    await Promise.allSettled([
      stopGenesysWidgetVoiceNotifications(),
      audioConnector.close(),
      new Promise((resolve) => server.close(resolve)),
      app.close(),
      closePostgresPool(),
    ]);
    clearTimeout(forcedExit);
    process.exit(signal === "SIGINT" ? 130 : 143);
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
