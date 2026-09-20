import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureWidgetDedicatedMessagingResources,
  ensureWidgetSupportedContentProfile,
  widgetSupportedContentBody,
  widgetSupportedContentProfileName,
} from "../lib/genesys/widget-supported-content.mjs";

const widget = {
  id: "10000000-0000-4000-8000-000000000001",
  publicId: "wgt_customer_service_123456",
  name: "Customer Service",
};

const attachmentPolicy = {
  inboundMimeTypes: ["image/png", "application/pdf", "image/png"],
  outboundMimeTypes: ["application/pdf", "text/plain"],
};

test("a widget content profile has a stable implementation-specific name and Genesys media access lists", () => {
  assert.match(widgetSupportedContentProfileName(widget), /Customer Service/);
  assert.deepEqual(widgetSupportedContentBody({ widget, attachmentPolicy }), {
    name: widgetSupportedContentProfileName(widget),
    mediaTypes: {
      allow: {
        inbound: [{ type: "application/pdf" }, { type: "image/png" }],
        outbound: [{ type: "application/pdf" }, { type: "text/plain" }],
      },
    },
  });
});

test("a deleted tracked Genesys content profile is recreated and receives a new ID", async () => {
  const calls = [];
  const conversationsApi = {
    async getConversationsMessagingSupportedcontentSupportedContentId(id) {
      calls.push(["get", id]);
      const error = new Error("not found");
      error.status = 404;
      throw error;
    },
    async getConversationsMessagingSupportedcontent() {
      calls.push(["list"]);
      return { entities: [], nextUri: null };
    },
    async postConversationsMessagingSupportedcontent(body) {
      calls.push(["post", body]);
      return { id: "supported-content-new", ...body };
    },
  };
  const result = await ensureWidgetSupportedContentProfile({
    conversationsApi,
    widget,
    attachmentPolicy,
    profileId: "supported-content-deleted",
  });
  assert.equal(result.created, true);
  assert.equal(result.profile.id, "supported-content-new");
  assert.deepEqual(calls.map(([operation]) => operation), ["get", "list", "post"]);
});

test("a tracked Genesys content profile is updated by ID even after an administrator renames it", async () => {
  let patched;
  const conversationsApi = {
    async getConversationsMessagingSupportedcontentSupportedContentId(id) {
      return { id, name: "Renamed in Genesys", mediaTypes: {} };
    },
    async patchConversationsMessagingSupportedcontentSupportedContentId(id, body) {
      patched = { id, body };
      return body;
    },
  };
  const result = await ensureWidgetSupportedContentProfile({
    conversationsApi,
    widget,
    attachmentPolicy,
    profileId: "supported-content-existing",
  });
  assert.equal(result.created, false);
  assert.equal(patched.id, "supported-content-existing");
  assert.equal(patched.body.name, widgetSupportedContentProfileName(widget));
});

test("publishing a widget binds its own content profile and Open Messaging recipient to the shared Architect flow", async () => {
  const calls = [];
  const dedicated = { id: "open-widget-1", name: "dedicated", recipient: { id: "recipient-widget-1" }, createStatus: "complete" };
  const conversationsApi = {
    async getConversationsMessagingSupportedcontent() { return { entities: [], nextUri: null }; },
    async postConversationsMessagingSupportedcontent(body) {
      calls.push(["profile.create", body]);
      return { id: "profile-widget-1", ...body };
    },
    async getConversationsMessagingIntegrationsOpenIntegrationId(id) {
      if (id === "open-shared") return { id, name: "shared", recipient: { id: "recipient-shared" } };
      return dedicated;
    },
    async getConversationsMessagingIntegrationsOpen() { return { entities: [], nextUri: null }; },
    async postConversationsMessagingIntegrationsOpen(body) {
      calls.push(["integration.create", body]);
      return dedicated;
    },
    async patchConversationsMessagingIntegrationsOpenIntegrationId(id, body) {
      calls.push(["integration.patch", id, body]);
      return { ...dedicated, ...body };
    },
  };
  const routingApi = {
    async getRoutingMessageRecipient(id) {
      assert.equal(id, "recipient-shared");
      return { id, flow: { id: "flow-shared", name: "Shared widget routing" } };
    },
    async putRoutingMessageRecipient(id, body) {
      calls.push(["recipient.route", id, body]);
    },
  };

  const result = await ensureWidgetDedicatedMessagingResources({
    context: { conversationsApi, routingApi },
    widget,
    config: {
      channels: { messaging: { genesys: { integrationId: "open-shared" } } },
      features: { attachmentsAfterHandoff: true, attachmentPolicy },
    },
    publicBaseUrl: "https://widgets.example.com",
    secret: "0123456789abcdef0123456789abcdef",
  });

  assert.equal(result.profile.id, "profile-widget-1");
  assert.equal(result.integration.id, "open-widget-1");
  assert.equal(result.baseIntegrationId, "open-shared");
  assert.deepEqual(calls.find(([name]) => name === "integration.create")[1].supportedContent, { id: "profile-widget-1" });
  assert.deepEqual(calls.find(([name]) => name === "recipient.route"), [
    "recipient.route",
    "recipient-widget-1",
    { flow: { id: "flow-shared" } },
  ]);
});
