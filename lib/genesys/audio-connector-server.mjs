import { WebSocketServer } from "ws";
import { handleGenesysAudioConnectorUpgrade } from "./audio-connector-handler.js";
import { createGenesysAudioConnectorLogger } from "./audio-connector-logger.js";

export const GENESYS_AUDIO_WEBSOCKET_PATH =
  "/api/genesys/audio-connector/ws";

export const GENESYS_AUDIO_RUNTIME_VARIABLES = Object.freeze([
  "TELNYX_API_KEY",
  "GC_ENVIRONMENT",
  "GC_CLIENT_CRED_CLIENT_ID",
  "GC_CLIENT_CRED_CLIENT_SECRET",
  "GC_AUDIO_CONNECTOR_API_KEY",
  "GC_AUDIO_CONNECTOR_CLIENT_SECRET",
]);

export function missingGenesysAudioRuntimeVariables(environment = process.env) {
  const missing = GENESYS_AUDIO_RUNTIME_VARIABLES.filter(
    (name) => !String(environment[name] || "").trim()
  );
  if (
    !String(environment.GENESYS_HANDOFF_API_KEY || "").trim() &&
    !String(environment.GC_AUDIO_HANDOFF_API_KEY || "").trim()
  ) {
    missing.push("GENESYS_HANDOFF_API_KEY or GC_AUDIO_HANDOFF_API_KEY");
  }
  return missing;
}

export function isGenesysAudioWebSocketPath(requestUrl) {
  try {
    return new URL(String(requestUrl || "/"), "http://localhost").pathname ===
      GENESYS_AUDIO_WEBSOCKET_PATH;
  } catch {
    return false;
  }
}

export function requestForAudioHook(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || "https";
  const authority = forwardedHost || request.headers.host || "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, String(value));
  }
  headers.set("host", authority);
  return {
    url: `${protocol}://${authority}${
      request.url || GENESYS_AUDIO_WEBSOCKET_PATH
    }`,
    headers,
  };
}

function rejectUnavailableUpgrade(socket) {
  const body = "Genesys Audio Connector is not configured\n";
  socket.write(
    "HTTP/1.1 503 Service Unavailable\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body
  );
  socket.destroy();
}

function rejectUnsupportedUpgrade(socket) {
  const body = "WebSocket endpoint not found\n";
  socket.write?.(
    "HTTP/1.1 404 Not Found\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body
  );
  socket.destroy?.();
}

export function attachGenesysAudioConnector(
  server,
  {
    environment = process.env,
    createWebSocketServer = () => new WebSocketServer({ noServer: true }),
    handleUpgrade = handleGenesysAudioConnectorUpgrade,
    handleNonAudioUpgrade = null,
    logger = console,
  } = {}
) {
  const wss = createWebSocketServer();
  const debugLog = createGenesysAudioConnectorLogger({ environment, logger });
  let nonAudioUpgradeHandler = handleNonAudioUpgrade;

  const onUpgrade = (request, socket, head) => {
    if (!isGenesysAudioWebSocketPath(request.url)) {
      if (typeof nonAudioUpgradeHandler === "function") {
        nonAudioUpgradeHandler(request, socket, head);
      } else {
        rejectUnsupportedUpgrade(socket);
      }
      return;
    }

    const missing = missingGenesysAudioRuntimeVariables(environment);
    if (missing.length) {
      debugLog.warn(
        "Rejected WebSocket upgrade; missing runtime configuration:",
        missing.join(", ")
      );
      rejectUnavailableUpgrade(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      void Promise.resolve()
        .then(() => handleUpgrade(websocket, requestForAudioHook(request)))
        .catch((error) => {
          debugLog.error(
            "WebSocket setup failed:",
            error
          );
          websocket.close?.(1011, "Audio Connector setup failed");
        });
    });
  };

  server.on("upgrade", onUpgrade);

  return {
    wss,
    configured: missingGenesysAudioRuntimeVariables(environment).length === 0,
    set handleNonAudioUpgrade(handler) {
      nonAudioUpgradeHandler = typeof handler === "function" ? handler : null;
    },
    async close() {
      server.off("upgrade", onUpgrade);
      for (const client of wss.clients || []) {
        client.close(1001, "Server shutting down");
      }
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
