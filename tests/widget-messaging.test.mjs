import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addTelnyxWidgetHandoffContext,
  createTelnyxWidgetConversation,
  disableTelnyxConversationAi,
  listTelnyxConversationMessages,
  normalizeTelnyxMessage,
  sendTelnyxAssistantMessage,
} from "../lib/telnyx/widget-messaging.js";

test("normalizes Assistant Chat API response", () => {
  const result = normalizeTelnyxMessage({ content: "Dzień dobry" });
  assert.equal(result.role, "assistant");
  assert.equal(result.content, "Dzień dobry");
});

test("normalizes Telnyx conversation message text and role", () => {
  const result = normalizeTelnyxMessage({
    id: "message-1",
    role: "user",
    text: "Potrzebuję pomocy",
    created_at: "2026-08-13T10:00:00.000Z",
  });
  assert.deepEqual(result, {
    id: "message-1",
    role: "user",
    content: "Potrzebuję pomocy",
    createdAt: "2026-08-13T10:00:00.000Z",
  });
});

test("uses the documented Telnyx Conversations and Assistant Chat endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TELNYX_API_KEY;
  const originalOrigin = process.env.TELNYX_API_ORIGIN;
  process.env.TELNYX_API_KEY = "test-api-key";
  process.env.TELNYX_API_ORIGIN = "https://telnyx.test";
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v2/ai/conversations")) {
      return Response.json({ id: "conversation-1" });
    }
    if (String(url).includes("/v2/ai/assistants/assistant-1/chat")) {
      return Response.json({ content: "Odpowiedź" });
    }
    if (String(url).endsWith("/v2/ai/conversations/conversation-1") && !init.method) {
      return Response.json({ data: { metadata: { source: "widget" } } });
    }
    return Response.json({
      data: [
        { id: "user-1", role: "user", text: "Pytanie" },
        { id: "tool-1", role: "tool", text: "tajny wynik narzędzia" },
        { id: "assistant-1", role: "assistant", text: "Odpowiedź" },
      ],
    });
  };

  try {
    const conversationId = await createTelnyxWidgetConversation({
      widget: { public_id: "wgt_test" },
      sessionId: "session-1",
      origin: "https://shop.example.eu",
    });
    assert.equal(conversationId, "conversation-1");
    await addTelnyxWidgetHandoffContext({ conversationId, sessionId: "session-1" });
    const response = await sendTelnyxAssistantMessage({
      assistantId: "assistant-1",
      conversationId,
      content: "Pytanie",
    });
    assert.equal(response.content, "Odpowiedź");
    await disableTelnyxConversationAi(conversationId);
    const history = await listTelnyxConversationMessages(conversationId);
    assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
    assert.equal(calls[0].url, "https://telnyx.test/v2/ai/conversations");
    assert.equal(
      JSON.parse(calls[0].init.body).metadata.telnyx_conversation_channel,
      "web_chat"
    );
    assert.match(JSON.parse(calls[1].init.body).content, /session-1/);
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      content: "Pytanie",
      name: "User",
      conversation_id: "conversation-1",
    });
    assert.deepEqual(JSON.parse(calls[4].init.body), {
      metadata: { source: "widget", ai_disabled: true },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalKey;
    if (originalOrigin === undefined) delete process.env.TELNYX_API_ORIGIN;
    else process.env.TELNYX_API_ORIGIN = originalOrigin;
  }
});

test("customer attachments are signed, MIME-checked and delivered to Genesys as Attachment content", async () => {
  process.env.WIDGET_SESSION_SIGNING_SECRET = "x".repeat(48);
  process.env.WIDGET_ASSET_DIR = await mkdtemp(path.join(tmpdir(), "widget-attachments-"));
  const {
    attachmentDownloadPath,
    genesysMediaType,
    readSessionAttachment,
    verifyAttachmentDownload,
    writeSessionAttachment,
    deleteOrphanedSessionAttachments,
  } = await import("../lib/widgets/session-attachments.js");

  const sessionId = randomUUID();
  const record = await writeSessionAttachment({
    sessionId,
    filename: "return-form.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from("%PDF-1.4 sample"),
  });
  assert.equal(record.size, 15);
  const stored = await readSessionAttachment(sessionId, record.id);
  assert.equal(stored.bytes.toString(), "%PDF-1.4 sample");

  const link = attachmentDownloadPath(sessionId, record.id);
  const query = new URLSearchParams(link.slice(link.indexOf("?") + 1));
  assert.ok(verifyAttachmentDownload({
    sessionId, attachmentId: record.id, expires: query.get("expires"), token: query.get("token"),
  }));
  // A link for one attachment must not unlock another one in the same session.
  assert.equal(verifyAttachmentDownload({
    sessionId, attachmentId: randomUUID(), expires: query.get("expires"), token: query.get("token"),
  }), false);
  assert.equal(verifyAttachmentDownload({
    sessionId, attachmentId: record.id, expires: query.get("expires"), token: "tampered",
  }), false);
  // An expired signature is refused even though it is otherwise valid.
  const expired = attachmentDownloadPath(sessionId, record.id, Date.now() - 48 * 60 * 60 * 1000);
  const expiredQuery = new URLSearchParams(expired.slice(expired.indexOf("?") + 1));
  assert.equal(verifyAttachmentDownload({
    sessionId, attachmentId: record.id, expires: expiredQuery.get("expires"), token: expiredQuery.get("token"),
  }), false);

  assert.equal(genesysMediaType("image/png"), "Image");
  assert.equal(genesysMediaType("video/mp4"), "Video");
  assert.equal(genesysMediaType("audio/mpeg"), "Audio");
  assert.equal(genesysMediaType("application/pdf"), "File");

  // Files belonging to sessions that no longer exist are swept from disk.
  assert.equal(await deleteOrphanedSessionAttachments([sessionId], 0), 0);
  assert.equal(await deleteOrphanedSessionAttachments([], 0), 1);
  await rm(process.env.WIDGET_ASSET_DIR, { recursive: true, force: true });
  delete process.env.WIDGET_ASSET_DIR;
});

test("the widget composer uploads real files and previews them in a modal", async () => {
  const [frame, uploadRoute, downloadRoute, openMessaging] = await Promise.all([
    readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/attachments/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-attachments/[attachmentId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/genesys/widget-open-messaging.js", import.meta.url), "utf8"),
  ]);
  assert.match(frame, /function AttachmentPreviewModal/);
  assert.match(frame, /event\.key === "Escape"/);
  assert.match(frame, /type="file"/);
  assert.match(frame, /fetch\("\/api\/widget-sessions\/attachments"/);
  // Uploading is gated on a live agent, which is the only channel that carries files.
  assert.match(frame, /\["waiting", "assigned", "connected"\]\.includes\(handoff\?\.status\)/);
  assert.match(uploadRoute, /\["waiting", "assigned", "connected"\]\.includes\(handoff\.status\)/);
  assert.match(uploadRoute, /policy\.inboundMimeTypes\.includes\(mimeType\)/);
  assert.match(uploadRoute, /policy\.maximumFileSizeMb \* 1_048_576/);
  assert.match(downloadRoute, /verifyAttachmentDownload/);
  assert.match(openMessaging, /contentType: "Attachment"/);
});

test("chat and voice composers restore input focus after sending a message", async () => {
  const [chatRuntime, voiceRuntime] = await Promise.all([
    readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/widget/VoiceWidgetRuntime.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(chatRuntime, /const messageInputRef = useRef\(null\)/);
  assert.match(chatRuntime, /restoreMessageInputFocusRef\.current = true/);
  assert.match(chatRuntime, /messageInput\.focus\(\{ preventScroll: true \}\)/);
  assert.match(chatRuntime, /ref=\{messageInputRef\}[\s\S]*disabled=\{mode !== "messaging" \|\| !chatReady\}/);

  assert.match(voiceRuntime, /const messageInputRef = useRef\(null\)/);
  assert.match(voiceRuntime, /sendConversationMessage\(value\)[\s\S]*messageInputRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(voiceRuntime, /ref=\{messageInputRef\}[\s\S]*disabled=\{!active\}/);
});

test("attachment responses stay inert while still letting the browser render a PDF", async () => {
  const { attachmentResponseHeaders, resolveAttachmentResponseMimeType } =
    await import("../lib/widgets/attachment-headers.js");
  assert.equal(resolveAttachmentResponseMimeType({ filename: "reply.mp3", mediaType: "Audio" }, "application/octet-stream"), "audio/mpeg");
  assert.equal(resolveAttachmentResponseMimeType({ filename: "reply.wav" }, "application/octet-stream"), "audio/wav");
  const pdf = attachmentResponseHeaders({ mimeType: "application/pdf", filename: 'a"b\\c.pdf' }, 12);
  assert.equal(pdf["x-content-type-options"], "nosniff");
  assert.match(pdf["content-disposition"], /^inline; filename="a_b_c\.pdf"$/);
  // A bare CSP sandbox stops Chrome rendering the PDF, which showed as a blank frame.
  assert.doesNotMatch(pdf["content-security-policy"], /sandbox/);
  assert.match(pdf["content-security-policy"], /default-src 'none'/);
  assert.equal(pdf["content-length"], "12");

  // Everything else keeps the opaque-origin sandbox.
  for (const mimeType of ["image/svg+xml", "text/plain", "image/png", "application/octet-stream"]) {
    const headers = attachmentResponseHeaders({ mimeType, filename: "x" });
    assert.match(headers["content-security-policy"], /^sandbox;/, mimeType);
    assert.equal(headers["x-content-type-options"], "nosniff", mimeType);
    assert.equal(headers["content-length"], undefined, mimeType);
  }
});

test("agent attachments are proxied so Genesys download URLs never reach the customer", async () => {
  const [handoffs, proxyRoute, frame] = await Promise.all([
    readFile(new URL("../lib/widgets/handoffs.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/agent-attachment/[messageId]/[index]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(handoffs, /if \(row\.sender !== "agent" \|\| !sessionId\) return attachments;/);
  assert.match(handoffs, /agentAttachmentDownloadPath\(sessionId, row\.id, index, \{ expiresAt: row\.expires_at \}\)/);
  assert.match(handoffs, /export async function getHandoffMessageAttachment/);
  // The proxy is scoped to the caller's own session and to agent-sent messages.
  assert.match(handoffs, /h\.session_id=\$1 AND m\.id::text=\$2 AND m\.sender='agent'/);
  // A media element cannot send an Authorization header, so the link is signed.
  assert.match(proxyRoute, /verifyAgentAttachmentDownload/);
  assert.doesNotMatch(proxyRoute, /bearerToken/);
  // Seeking through audio and video needs range requests to reach Genesys.
  assert.match(proxyRoute, /request\.headers\.get\("range"\)/);
  assert.match(proxyRoute, /"accept-ranges": "bytes"/);
  assert.match(proxyRoute, /parseAttachmentByteRange/);
  assert.doesNotMatch(frame, /useAuthorizedAttachmentUrl/);
});

test("agent attachment links are signed per message and attachment", async () => {
  process.env.WIDGET_SESSION_SIGNING_SECRET = "x".repeat(48);
  const { agentAttachmentDownloadPath, verifyAgentAttachmentDownload } =
    await import("../lib/widgets/session-attachments.js");
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const link = agentAttachmentDownloadPath(sessionId, messageId, 0);
  const query = new URLSearchParams(link.slice(link.indexOf("?") + 1));
  const claim = { sessionId, messageId, index: "0", expires: query.get("expires"), token: query.get("token") };
  assert.ok(verifyAgentAttachmentDownload(claim));
  // One signature must not unlock a different attachment, message or session.
  assert.equal(verifyAgentAttachmentDownload({ ...claim, index: "1" }), false);
  assert.equal(verifyAgentAttachmentDownload({ ...claim, messageId: randomUUID() }), false);
  assert.equal(verifyAgentAttachmentDownload({ ...claim, sessionId: randomUUID() }), false);
  assert.equal(verifyAgentAttachmentDownload({ ...claim, token: "forged" }), false);
  const stale = agentAttachmentDownloadPath(sessionId, messageId, 0, Date.now() - 48 * 60 * 60 * 1000);
  const staleQuery = new URLSearchParams(stale.slice(stale.indexOf("?") + 1));
  assert.equal(verifyAgentAttachmentDownload({
    ...claim, expires: staleQuery.get("expires"), token: staleQuery.get("token"),
  }), false);

  const expiresAt = new Date("2026-08-26T10:00:00.000Z");
  assert.equal(
    agentAttachmentDownloadPath(sessionId, messageId, 0, { expiresAt }),
    agentAttachmentDownloadPath(sessionId, messageId, 0, { expiresAt })
  );
});

test("attachment byte ranges support browser audio playback", async () => {
  const { parseAttachmentByteRange } = await import("../lib/widgets/attachment-ranges.js");
  assert.deepEqual(parseAttachmentByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseAttachmentByteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseAttachmentByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.equal(parseAttachmentByteRange("bytes=1000-", 1000), null);
  assert.equal(parseAttachmentByteRange("bytes=0-1,4-5", 1000), null);
});

test("audio, video and images preview inline in the transcript and in the viewer", async () => {
  const frame = await readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8");
  assert.match(frame, /function attachmentKind\(attachment\)/);
  // Inline in the bubble: a real image preview, a video player and an audio player.
  assert.match(frame, /if \(displayUrl && kind === "image"\)/);
  assert.match(frame, /if \(displayUrl && kind === "video"\)/);
  assert.match(frame, /if \(displayUrl && kind === "audio"\)/);
  assert.match(frame, /<audio src=\{displayUrl\} controls preload="metadata"/);
  assert.match(frame, /<video src=\{displayUrl\} controls preload="metadata"/);
  // And the same media open in the modal viewer.
  assert.match(frame, /displayUrl && kind === "audio" && \(/);
  assert.match(frame, /displayUrl && kind === "video" && \(/);
});

test("the widget exchanges ephemeral typing events with Genesys in both directions", async () => {
  const [frame, typingRoute, webhook, schema, sessions, store] = await Promise.all([
    readFile(new URL("../components/widget/WidgetFrame.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widget-sessions/typing/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/webhooks/genesys/open-messaging/[integrationId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/widgets/sessions.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/widgets/store.js", import.meta.url), "utf8"),
  ]);
  assert.match(frame, /function AgentTypingBadge/);
  assert.match(frame, /fetch\("\/api\/widget-sessions\/typing"/);
  assert.match(typingRoute, /sendGenesysCustomerTyping/);
  assert.match(webhook, /genesysOutboundTypingDuration/);
  assert.match(webhook, /markMessagingHandoffAgentTyping/);
  assert.match(schema, /agent_typing_until TIMESTAMPTZ/);
  assert.match(schema, /customer_typing_sent_at TIMESTAMPTZ/);
  // Published revisions predate optional presentation fields, so both new and
  // resumed sessions must normalize the stored config before runtime access.
  assert.match(sessions, /parseWidgetConfigIfCurrent\(row\.config\)/);
  assert.match(store, /parseWidgetConfigIfCurrent\(row\.config\)/);
});

test("page context becomes Telnyx dynamic variables on both widget channels", async () => {
  const {
    dynamicVariableHeaderName,
    dynamicVariableName,
    widgetDynamicVariables,
    widgetDynamicVariableHeaders,
  } = await import("../lib/widgets/dynamic-variables.js");

  const context = {
    title: "Solutions Engineer",
    "customer.name": "Anna Kowalska",
    "customer.segment": "vip",
    "customer.authenticated": true,
    "routing.queue": "Premium Support",
    "page.path": "/pricing",
  };
  assert.deepEqual(widgetDynamicVariables(context), {
    title: "Solutions Engineer",
    customer_name: "Anna Kowalska",
    customer_segment: "vip",
    customer_authenticated: "true",
    routing_queue: "Premium Support",
    page_path: "/pricing",
  });
  assert.deepEqual(widgetDynamicVariableHeaders({ "customer.name": "Anna" }), [
    { name: "X-Customer-Name", value: "Anna" },
  ]);
  assert.equal(dynamicVariableName("customer.name"), "customer_name");
  assert.equal(dynamicVariableHeaderName("customer_name"), "X-Customer-Name");

  // A host page must not be able to forge the identifiers the handoff trusts.
  assert.deepEqual(widgetDynamicVariables({
    widget_session_id: "forged", "Widget Session Id": "forged", telnyx_conversation_channel: "sms",
    widget_id: "other", widget_origin: "https://evil.example", source: "spoof",
  }), {});

  // Values that cannot appear as {{name}} are dropped rather than mangled.
  assert.deepEqual(widgetDynamicVariables({
    "123numeric": "x", nested: { a: 1 }, list: [1], blank: "   ", missing: null, "!!!": "x",
  }), {});
  assert.equal(dynamicVariableName("123numeric"), null);
  assert.equal(widgetDynamicVariables(null).title, undefined);

  // Long values are capped and the variable count is bounded.
  assert.equal(widgetDynamicVariables({ note: "a".repeat(900) }).note.length, 512);
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, "v"]));
  assert.equal(Object.keys(widgetDynamicVariables(many)).length, 50);
});

test("dynamic variables travel with the conversation and the WebRTC invite", async () => {
  const [messaging, sessionRoute, voice, loader] = await Promise.all([
    readFile(new URL("../lib/telnyx/widget-messaging.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/widgets/[publicId]/sessions/route.js", import.meta.url), "utf8"),
    readFile(new URL("../components/widget/VoiceWidgetRuntime.jsx", import.meta.url), "utf8"),
    readFile(new URL("../public/widget/v1/loader.js", import.meta.url), "utf8"),
  ]);
  // Conversation metadata is what Telnyx resolves as {{variable}} in web chat.
  assert.match(messaging, /\.\.\.dynamicVariables,\s*\n\s*source: "telnyx-genesys-widget"/);
  assert.match(sessionRoute, /dynamicVariables: widgetDynamicVariables\(input\.context \|\| \{\}\)/);
  assert.match(
    voice,
    /\.\.\.widgetDynamicVariableHeaders\(freshWidget\.decisionContext \|\| widget\.decisionContext \|\| \{\}\)/
  );
  // The loader must forward every published key, not only declared decision variables.
  assert.match(loader, /Object\.keys\(hostContext\)\.forEach/);
});

test("an Assistant greeting template is resolved before the customer sees it", async () => {
  const { interpolateDynamicVariables, widgetDynamicVariables } =
    await import("../lib/widgets/dynamic-variables.js");
  const variables = widgetDynamicVariables({ "customer.name": "Anna Kowalska", title: "VIP" });
  assert.equal(
    interpolateDynamicVariables("Hello {{customer_name}}, how can I help?", variables),
    "Hello Anna Kowalska, how can I help?"
  );
  // Telnyx resolves placeholders inside a conversation, but the greeting is read
  // straight from the Assistant, so an unknown one would reach the customer raw.
  assert.equal(
    interpolateDynamicVariables("Hello {{unknown_thing}}, how can I help?", variables),
    "Hello, how can I help?"
  );
  assert.equal(interpolateDynamicVariables("{{ customer.name }} hi", variables), "Anna Kowalska hi");
  assert.equal(interpolateDynamicVariables("", variables), "");

  const sessionRoute = await readFile(
    new URL("../app/api/widgets/[publicId]/sessions/route.js", import.meta.url), "utf8"
  );
  assert.match(sessionRoute, /interpolateDynamicVariables\(greeting, dynamicVariables\)/);
  assert.match(sessionRoute, /messagingGreeting\(widget, widgetDynamicVariables\(input\.context \|\| \{\}\)\)/);
});
