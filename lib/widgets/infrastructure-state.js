import { createHash } from "node:crypto";

import { parseWidgetConfig } from "./config.js";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function normalizedQueues(queues = []) {
  return queues
    .map((queue) => ({
      id: String(queue?.id || "").trim(),
      name: String(queue?.name || queue?.id || "").trim(),
    }))
    .filter((queue) => queue.id)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function widgetInfrastructureSecretFingerprint(value) {
  const secret = String(value || "");
  return secret ? createHash("sha256").update(secret).digest("hex") : "";
}

export function createWidgetInfrastructureState({
  widget,
  config: inputConfig,
  publicBaseUrl = "",
  baseIntegrationId = "",
  messagingQueues = [],
  messagingDefaultQueueId = "",
  voiceQueues = [],
  voiceDefaultQueueId = "",
  openMessagingSecret = "",
  handoffApiKey = "",
}) {
  const config = parseWidgetConfig(inputConfig);
  const messaging = config.channels.messaging;
  const voice = config.channels.voice;
  const state = stableValue({
    schemaVersion: 1,
    widget: {
      id: String(widget?.id || "").trim(),
      name: String(widget?.name || "").trim(),
      installationKey: String(widget?.installationKey || "").trim(),
    },
    endpoint: String(publicBaseUrl || "").trim().replace(/\/$/, ""),
    messaging: {
      enabled: messaging.enabled,
      assistantId: messaging.enabled ? messaging.assistantId : "",
      baseIntegrationId: messaging.enabled ? String(baseIntegrationId || "").trim() : "",
      queues: messaging.enabled ? normalizedQueues(messagingQueues) : [],
      defaultQueueId: messaging.enabled ? String(messagingDefaultQueueId || "").trim() : "",
      attachmentsAfterHandoff: messaging.enabled && config.features.attachmentsAfterHandoff,
      inboundMimeTypes: messaging.enabled && config.features.attachmentsAfterHandoff
        ? [...new Set(config.features.attachmentPolicy.inboundMimeTypes)].sort()
        : [],
      outboundMimeTypes: messaging.enabled && config.features.attachmentsAfterHandoff
        ? [...new Set(config.features.attachmentPolicy.outboundMimeTypes)].sort()
        : [],
    },
    voice: {
      enabled: voice.enabled,
      assistantId: voice.enabled ? voice.assistantId : "",
      genesysTrunkId: voice.enabled ? voice.genesysTrunkId : "",
      destination: voice.enabled
        ? voice.genesysSipUriManaged !== false
          ? { mode: "managed" }
          : { mode: "fixed", sipUri: voice.genesysSipUri }
        : { mode: "disabled" },
      keepAssistantOnCall: voice.enabled && voice.keepAssistantOnCall,
      queues: voice.enabled ? normalizedQueues(voiceQueues) : [],
      defaultQueueId: voice.enabled ? String(voiceDefaultQueueId || "").trim() : "",
    },
    credentials: {
      openMessagingSecret: messaging.enabled
        ? widgetInfrastructureSecretFingerprint(openMessagingSecret)
        : "",
      handoffApiKey: messaging.enabled
        ? widgetInfrastructureSecretFingerprint(handoffApiKey)
        : "",
    },
  });
  const serialized = JSON.stringify(state);
  return {
    config: state,
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function widgetInfrastructureSyncReason(widget, desired, { force = false } = {}) {
  if (force) return "forced";
  if (!widget?.published) return "first_publish";
  if (!widget?.infrastructureFingerprint) return "untracked";
  if (widget.infrastructureFingerprint !== desired.fingerprint) return "configuration_changed";
  if (desired.config.messaging.enabled && (
    !widget.supportedContentProfileId || !widget.openMessagingIntegrationId
  )) return "messaging_resources_untracked";
  return null;
}
