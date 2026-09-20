import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { handleAudioConnectorSession } from "../lib/genesys/audio-connector-handler.js";
import { GENESYS_AUDIOHOOK_MEDIA } from "../lib/genesys/audiohook-protocol.js";

class GenesysSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  messages = [];

  send(raw) {
    const message = JSON.parse(raw);
    this.messages.push(message);
    this.emit("sent", message);
  }

  ping() {}

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

async function rejectedHandshake(t, { statusCode, body = "" }) {
  const previousKey = process.env.TELNYX_API_KEY;
  const previousDebug = process.env.GC_AUDIO_CONNECTOR_DEBUG;
  process.env.TELNYX_API_KEY = "handshake-test-key";
  process.env.GC_AUDIO_CONNECTOR_DEBUG = "false";
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(body);
  });
  const genesys = new GenesysSocket();
  let upstream;
  let upstreamClosed;
  let sentFrames = 0;
  t.after(async () => {
    genesys.close();
    upstream?.terminate();
    if (upstreamClosed) await upstreamClosed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = previousKey;
    if (previousDebug === undefined) delete process.env.GC_AUDIO_CONNECTOR_DEBUG;
    else process.env.GC_AUDIO_CONNECTOR_DEBUG = previousDebug;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await handleAudioConnectorSession(genesys, {
    createTelnyxWebSocket: (_url, options) => {
      upstream = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, options);
      upstreamClosed = new Promise((resolve) => upstream.once("close", resolve));
      const send = upstream.send.bind(upstream);
      upstream.send = (...args) => {
        sentFrames += 1;
        return send(...args);
      };
      return upstream;
    },
  });
  const firstMessage = once(genesys, "sent");
  genesys.emit("message", Buffer.from(JSON.stringify({
    version: "2",
    type: "open",
    seq: 1,
    id: "handshake-session",
    parameters: {
      organizationId: "org-1",
      conversationId: "conversation-1",
      participant: { id: "participant-1" },
      media: [GENESYS_AUDIOHOOK_MEDIA],
      inputVariables: { assistantId: "assistant-unavailable" },
    },
  })), false);
  const [disconnect] = await firstMessage;
  assert.equal(disconnect.type, "disconnect");
  assert.equal(disconnect.parameters.reason, "error");
  return {
    disconnect,
    genesys,
    upstream,
    upstreamClosed,
    get requestCount() { return requestCount; },
    get sentFrames() { return sentFrames; },
  };
}

test("Telnyx HTTP 404 reports both missing and inaccessible assistants", { timeout: 3000 }, async (t) => {
  const { disconnect } = await rejectedHandshake(t, {
    statusCode: 404,
    body: JSON.stringify({ type: "error", error: { code: "assistant_not_found", message: "Assistant not found, or not available to this account" } }),
  });
  assert.match(disconnect.parameters.info, /not found.*not available to this account/i);
  assert.match(disconnect.parameters.info, /HTTP 404/);
});

test("Telnyx HTTP 401 identifies the API key authentication failure", { timeout: 3000 }, async (t) => {
  const { disconnect } = await rejectedHandshake(t, { statusCode: 401 });
  assert.match(disconnect.parameters.info, /authentication.*HTTP 401/i);
  assert.match(disconnect.parameters.info, /API key/i);
});

for (const statusCode of [400, 401, 403, 404, 503]) {
  test(`Telnyx HTTP ${statusCode} aborts the failed upgrade without opening Genesys media`, { timeout: 3000 }, async (t) => {
    const session = await rejectedHandshake(t, { statusCode });
    assert.match(session.disconnect.parameters.info, new RegExp(`HTTP ${statusCode}`));
    let timer;
    try {
      await Promise.race([
        session.upstreamClosed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Rejected Telnyx WebSocket remained CONNECTING")), 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(session.upstream.readyState, WebSocket.CLOSED);
    assert.equal(session.genesys.readyState, WebSocket.OPEN, "Genesys completes its own close transaction");
    assert.equal(session.genesys.messages.length, 1, "Cleanup errors must not send another disconnect");
    assert.equal(session.sentFrames, 0, "Rejected sessions must not send session.update or audio");
    assert.equal(session.requestCount, 1, "Do not retry rejected handshakes");
  });
}
