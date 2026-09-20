import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  genesysOutboundAgentName,
  genesysOutboundAttachments,
  genesysOutboundRemoteAddress,
  genesysOutboundTypingDuration,
  genesysCustomerTypingBody,
  openMessagingSecret,
  resolveGenesysConversationAgent,
  verifyGenesysOpenMessagingSignature,
} from "../lib/genesys/widget-open-messaging.js";
import {
  downloadGenesysProfileImage,
  selectGenesysProfileImage,
} from "../lib/genesys/profile-images.js";

test("verifies a Genesys Open Messaging signature over the exact raw body", () => {
  const rawBody = '{"type":"Text","text":"Dzień dobry"}';
  const secret = "test-open-messaging-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("base64")}`;
  assert.equal(verifyGenesysOpenMessagingSignature({ rawBody, signature, secret }), true);
  assert.equal(
    verifyGenesysOpenMessagingSignature({ rawBody: `${rawBody} `, signature, secret }),
    false
  );
});

test("selects an integration-scoped webhook secret before the fallback", () => {
  const beforeJson = process.env.GC_OPEN_MESSAGING_SECRETS_JSON;
  const beforeFallback = process.env.GC_OPEN_MESSAGING_SECRET;
  process.env.GC_OPEN_MESSAGING_SECRETS_JSON = JSON.stringify({
    "integration-1": "scoped-secret-value",
  });
  process.env.GC_OPEN_MESSAGING_SECRET = "fallback-secret-value";
  try {
    assert.equal(openMessagingSecret("integration-1"), "scoped-secret-value");
    assert.equal(openMessagingSecret("integration-2"), "fallback-secret-value");
  } finally {
    if (beforeJson === undefined) delete process.env.GC_OPEN_MESSAGING_SECRETS_JSON;
    else process.env.GC_OPEN_MESSAGING_SECRETS_JSON = beforeJson;
    if (beforeFallback === undefined) delete process.env.GC_OPEN_MESSAGING_SECRET;
    else process.env.GC_OPEN_MESSAGING_SECRET = beforeFallback;
  }
});

test("maps only the widget remote address and HTTPS agent attachments", () => {
  const body = {
    channel: {
      from: { id: "integration-1", nickname: "Anna Kowalska" },
      to: { id: "telnyx-widget:handoff-1" },
    },
    content: [
      { attachment: { id: "a1", filename: "safe.pdf", url: "https://files.example.eu/a1" } },
      { attachment: { id: "a2", filename: "unsafe.html", url: "javascript:alert(1)" } },
    ],
  };
  assert.equal(genesysOutboundRemoteAddress(body), "telnyx-widget:handoff-1");
  assert.equal(genesysOutboundAgentName(body), "Anna Kowalska");
  const attachments = genesysOutboundAttachments(body);
  assert.equal(attachments[0].url, "https://files.example.eu/a1");
  assert.equal(attachments[1].url, null);
});

test("maps Genesys typing events in both Open Messaging directions", () => {
  assert.equal(genesysOutboundTypingDuration({
    type: "Event",
    events: [{ eventType: "Typing", typing: { type: "On", duration: 5000 } }],
  }), 5000);
  assert.equal(genesysOutboundTypingDuration({ type: "Text", events: [] }), null);
  assert.equal(genesysOutboundTypingDuration({
    type: "Event",
    events: [{ eventType: "Typing", typing: { type: "Off" } }],
  }), null);

  const now = new Date("2026-08-25T10:00:00.000Z");
  assert.deepEqual(genesysCustomerTypingBody({
    genesys_remote_address: "telnyx-widget:handoff-1",
  }, now), {
    channel: {
      from: {
        id: "telnyx-widget:handoff-1",
        idType: "Opaque",
        nickname: "Web customer",
      },
      time: now.toISOString(),
    },
    events: [{ eventType: "Typing", typing: { type: "On" } }],
  });
});

test("selects a suitable HTTPS Genesys profile image and rejects unsafe image URIs", () => {
  assert.equal(
    selectGenesysProfileImage([
      { resolution: "x48", imageUri: "https://images.example.test/small.jpg" },
      { resolution: "x300", imageUri: "https://images.example.test/large.jpg" },
      { resolution: "x128", imageUri: "https://images.example.test/medium.jpg" },
      { resolution: "x256", imageUri: "javascript:alert(1)" },
    ]),
    "https://images.example.test/large.jpg"
  );
  assert.equal(selectGenesysProfileImage([{ resolution: "x300", imageUri: "http://example.test/a.jpg" }]), null);
  assert.equal(
    selectGenesysProfileImage({ entities: [{ resolution: "128x128", imageUrl: "https://images.example.test/entity.jpg" }] }),
    "https://images.example.test/entity.jpg"
  );
});

test("resolves the assigned Genesys agent with the explicitly expanded image collection", async () => {
  const getUserCalls = [];
  const result = await resolveGenesysConversationAgent({
    conversationId: "conversation-1",
    conversationsApi: {
      async getConversation(conversationId) {
        assert.equal(conversationId, "conversation-1");
        return {
          participants: [{
            purpose: "agent",
            userId: "user-1",
            name: "Fallback participant",
            messages: [{ state: "connected" }],
          }],
        };
      },
    },
    usersApi: {
      async getUser(userId, options) {
        getUserCalls.push({ userId, options });
        return {
          id: userId,
          name: "Alex Rivera",
          images: [{ resolution: "x300", imageUri: "https://images.example.test/agent.jpg" }],
        };
      },
    },
  });

  assert.deepEqual(getUserCalls, [{ userId: "user-1", options: { expand: ["images"] } }]);
  assert.deepEqual(result, {
    name: "Alex Rivera",
    userId: "user-1",
    imageUri: "https://images.example.test/agent.jpg",
    state: "connected",
  });
});

test("downloads a Genesys JPEG even when api-downloads reports binary/octet-stream", async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
  const result = await downloadGenesysProfileImage({
    imageUri: "https://api-downloads.usw2.pure.cloud/image-files/profile.jpg",
    accessToken: "token",
    environment: "usw2.pure.cloud",
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer token");
      return new Response(jpeg, {
        status: 200,
        headers: { "content-type": "binary/octet-stream", "content-length": String(jpeg.length) },
      });
    },
  });
  assert.equal(result.contentType, "image/jpeg");
  assert.deepEqual(result.body, jpeg);
});

test("retries a signed Genesys profile image without OAuth and rejects untrusted hosts", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const calls = [];
  const result = await downloadGenesysProfileImage({
    imageUri: "https://api-downloads.usw2.pure.cloud/image-files/profile.png",
    accessToken: "token",
    environment: "usw2.pure.cloud",
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return calls.length === 1
        ? new Response(null, { status: 403 })
        : new Response(png, { status: 200, headers: { "content-type": "binary/octet-stream" } });
    },
  });
  assert.equal(result.contentType, "image/png");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers, undefined);

  await assert.rejects(
    downloadGenesysProfileImage({
      imageUri: "https://attacker.example.test/profile.jpg",
      accessToken: "token",
      environment: "usw2.pure.cloud",
      fetchImpl: async () => new Response(png),
    }),
    /URI is not allowed/
  );
});
