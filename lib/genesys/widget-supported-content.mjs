import {
  ensureWidgetOpenMessagingIntegration,
  listAllOpenMessagingIntegrations,
} from "./widget-installer-resources.mjs";
import { widgetResourceBaseName } from "./resource-naming.mjs";

function normalizeName(value, maximum = 180) {
  return String(value || "Widget").trim().replace(/\s+/g, " ").slice(0, maximum);
}

export function widgetSupportedContentProfileName(widget) {
  return normalizeName(widgetResourceBaseName(widget));
}

export function widgetOpenMessagingIntegrationName(widget) {
  return normalizeName(widgetResourceBaseName(widget));
}

export function widgetSupportedContentBody({ widget, attachmentPolicy }) {
  const mediaTypes = (values) => [...new Set(values || [])].sort().map((type) => ({ type }));
  return {
    name: widgetSupportedContentProfileName(widget),
    mediaTypes: {
      allow: {
        inbound: mediaTypes(attachmentPolicy.inboundMimeTypes),
        outbound: mediaTypes(attachmentPolicy.outboundMimeTypes),
      },
    },
  };
}

async function listSupportedContent(conversationsApi) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await conversationsApi.getConversationsMessagingSupportedcontent({
      pageNumber,
      pageSize: 100,
    });
    entries.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error("Genesys Supported Content Profile pagination exceeded 100 pages");
}

export async function ensureWidgetSupportedContentProfile({
  conversationsApi,
  widget,
  attachmentPolicy,
  profileId,
}) {
  const desired = widgetSupportedContentBody({ widget, attachmentPolicy });
  let current = null;
  if (profileId) {
    try {
      current = await conversationsApi.getConversationsMessagingSupportedcontentSupportedContentId(profileId);
    } catch (error) {
      const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
      if (status !== 404) throw error;
    }
  }
  if (!current) {
    const matches = (await listSupportedContent(conversationsApi)).filter((entry) => entry.name === desired.name);
    if (matches.length > 1) throw new Error(`More than one Genesys Supported Content Profile is named ${desired.name}`);
    current = matches[0] || null;
  }
  if (!current) {
    const profile = await conversationsApi.postConversationsMessagingSupportedcontent(desired);
    return { profile, created: true };
  }
  const profile = await conversationsApi.patchConversationsMessagingSupportedcontentSupportedContentId(
    current.id,
    { ...desired, id: current.id }
  );
  return { profile: profile || { ...current, ...desired }, created: false };
}

export async function ensureWidgetDedicatedMessagingResources({
  context,
  widget,
  config,
  publicBaseUrl,
  secret,
  baseIntegrationId: suppliedBaseIntegrationId,
}) {
  const profileResult = await ensureWidgetSupportedContentProfile({
    conversationsApi: context.conversationsApi,
    widget,
    attachmentPolicy: config.features.attachmentsAfterHandoff
      ? config.features.attachmentPolicy
      : { ...config.features.attachmentPolicy, inboundMimeTypes: [], outboundMimeTypes: [] },
    profileId: widget.supportedContentProfileId,
  });
  const baseIntegrationId = String(
    suppliedBaseIntegrationId ||
      widget.baseOpenMessagingIntegrationId ||
      config.channels.messaging.genesys.integrationId ||
      ""
  ).trim();
  if (!baseIntegrationId) throw new Error("Configure Web Chat Infrastructure before publishing this widget");
  const baseIntegration = await context.conversationsApi.getConversationsMessagingIntegrationsOpenIntegrationId(
    baseIntegrationId
  );
  const recipient = baseIntegration.recipient?.id
    ? await context.routingApi.getRoutingMessageRecipient(baseIntegration.recipient.id)
    : null;
  if (!recipient?.flow?.id) {
    throw new Error("The source Open Messaging integration is not assigned to an Architect inbound message flow");
  }
  const integrations = await listAllOpenMessagingIntegrations(context.conversationsApi);
  const integrationResult = await ensureWidgetOpenMessagingIntegration({
    conversationsApi: context.conversationsApi,
    integrations,
    integrationId: widget.openMessagingIntegrationId,
    baseUrl: publicBaseUrl,
    secret,
    name: widgetOpenMessagingIntegrationName(widget),
    supportedContent: { id: profileResult.profile.id },
    allowRename: true,
  });
  const integrationRecipientId = String(integrationResult.integration.recipient?.id || "").trim();
  if (!integrationRecipientId) throw new Error("Genesys did not return the dedicated Open Messaging recipient");
  await context.routingApi.putRoutingMessageRecipient(integrationRecipientId, {
    flow: { id: recipient.flow.id },
  });
  return {
    profile: profileResult.profile,
    profileCreated: profileResult.created,
    integration: integrationResult.integration,
    integrationCreated: integrationResult.created,
    flow: { id: recipient.flow.id, name: recipient.flow.name },
    baseIntegrationId,
  };
}
