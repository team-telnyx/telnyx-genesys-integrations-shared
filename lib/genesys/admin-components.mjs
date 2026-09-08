import { installationResourceNames } from "./installation-scope.mjs";

export const ADMIN_SHARED_TTS_WARNING =
  "Text-to-Speech connectors and Architect test flows are shared by the entire Genesys organization. Changes made here are visible to every DEV and PROD installation connected to this organization.";

export const ADMIN_COMPONENT_CATALOG = Object.freeze({
  tts: Object.freeze({
    id: "tts",
    name: "Text-to-Speech",
    shortName: "TTS",
    description: "Organization-wide Telnyx voices exposed as shared Genesys Cloud TTS Connector providers.",
    steps: [
      "Validate the live organization inventory and connector capacity",
      "Create or reuse the shared credential and apply every selected TTS provider",
      "Publish selected shared Architect test flows",
      "Verify shared connector activation and resulting organization inventory",
    ],
  }),
  audio: Object.freeze({
    id: "audio",
    name: "AI Audio Connector",
    shortName: "Audio",
    description: "Realtime Telnyx AI Assistant calls over Genesys Audio Connector.",
    steps: [
      "Validate the managed Audio Connector deployment, configured DNIS values and global queue policy",
      "Update the shared handoff tool and attach it to selected Telnyx AI assistants",
      "Update the Genesys interaction widget and Audio Connector",
      "Publish grouped DNIS routing, assign the inbound call route and persist the managed manifest",
    ],
  }),
  callbacks: Object.freeze({
    id: "callbacks",
    name: "Callbacks",
    shortName: "Callbacks",
    description: "Scheduled and immediate callback requests delivered to a Telnyx AI Assistant through Genesys Outbound Dialer.",
    steps: [
      "Validate the callback form, scheduling policy, caller ID and handoff queues",
      "Create or attach the selected Telnyx AI Assistant and shared Genesys handoff tool",
      "Publish the managed Genesys outbound call flow",
      "Create the managed Contact List, time filter and Call Analysis Response Set",
      "Create the always-running agentless campaign and verify its managed resource links",
    ],
  }),
  widget: Object.freeze({
    id: "widget",
    name: "Web Chat & Voice Widget",
    shortName: "Widget",
    description: "Embeddable Telnyx AI messaging and WebRTC with Genesys handoff.",
    steps: [
      "Validate the predefined Genesys administrator access and global queue policy",
      "Publish the shared Architect inbound message flow and Agent Experience screen pop",
      "Enable the shared interaction widget for calls and messages",
      "Provision the single Genesys Open Messaging integration and route its recipient",
      "Reuse or create the shared Telnyx Genesys handoff tool",
      "Persist the managed Web Chat infrastructure manifest",
    ],
  }),
});

function csv(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return [...new Set(source.map((entry) => String(entry).trim()).filter(Boolean))];
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function normalizeAdminComponentConfig(component, config = {}) {
  const installationName = installationResourceNames().installationName;
  if (!ADMIN_COMPONENT_CATALOG[component]) throw new Error(`Unsupported component ${component}`);
  if (component === "tts") {
    const profiles = csv(config.profiles);
    const testFlowProfiles = csv(config.testFlowProfiles);
    return { profiles, testFlowProfiles };
  }
  if (component === "audio") {
    const queueIds = csv(config.queueIds);
    if (!queueIds.length) throw new Error("Select at least one Genesys queue");
    const defaultQueueId = required(config.defaultQueueId, "Default Genesys queue");
    if (!queueIds.includes(defaultQueueId)) {
      throw new Error("Default Genesys queue must be selected in the global allowlist");
    }
    const widgetGroupIds = csv(config.widgetGroupIds);
    if (!widgetGroupIds.length) {
      throw new Error("Select at least one Genesys group for Agent Experience access");
    }
    const routes = (Array.isArray(config.routes) ? config.routes : []).map((route) => ({
      dnis: String(route?.dnis || "").trim(),
      assistantId: String(route?.assistantId || "").trim(),
      ...(route?.takeover === true ? {
        takeover: true,
        ...(route?.takeoverOwner?.id ? {
          takeoverOwner: {
            id: String(route.takeoverOwner.id),
            name: String(route.takeoverOwner.name || route.takeoverOwner.id),
            type: String(route.takeoverOwner.type || "UNKNOWN"),
          },
        } : {}),
      } : {}),
    })).filter(({ dnis, assistantId }) => dnis && assistantId);
    if (!routes.length) throw new Error("Add at least one DNIS-to-assistant assignment");
    const uniqueDnis = new Set(routes.map(({ dnis }) => dnis));
    if (uniqueDnis.size !== routes.length) {
      throw new Error("Each Genesys DNIS can be assigned only once");
    }
    const createDefaultAssistant = config.createDefaultAssistant === true;
    if (routes.some(({ assistantId }) => assistantId === "__managed_default__") && !createDefaultAssistant) {
      throw new Error("Enable default AI assistant creation or select an existing assistant");
    }
    const assistantUseCase = String(config.assistantUseCase || "").trim();
    const assistantName = String(config.assistantName || installationName).trim();
    const assistantInstructions = String(config.assistantInstructions || "").trim();
    const assistantGreeting = String(config.assistantGreeting || "").trim();
    const assistantContentGenerated = config.assistantContentGenerated === true;
    if (createDefaultAssistant) {
      if (!assistantName) throw new Error("Enter a name for the new AI assistant");
      if (!assistantUseCase) throw new Error("Describe the default AI assistant use case");
      if (!assistantInstructions) throw new Error("Generate or enter default assistant instructions");
      if (!assistantGreeting) throw new Error("Generate or enter a default assistant greeting");
      if (!assistantContentGenerated) {
        throw new Error("Generate the default assistant content with AI before continuing");
      }
    }
    return {
      applicationName: installationName,
      deploymentId: required(config.deploymentId, "Audio deployment").toUpperCase(),
      queueIds,
      defaultQueueId,
      widgetGroupIds,
      routes,
      createDefaultAssistant,
      assistantName,
      assistantUseCase,
      assistantInstructions,
      assistantGreeting,
      assistantContentGenerated,
    };
  }
  if (component === "callbacks") {
    const queueIds = csv(config.queueIds);
    if (!queueIds.length) throw new Error("Select at least one Genesys queue");
    const defaultQueueId = required(config.defaultQueueId, "Default Genesys queue");
    if (!queueIds.includes(defaultQueueId)) {
      throw new Error("Default Genesys queue must be selected in the callback handoff allowlist");
    }
    const createAssistant = config.createAssistant === true;
    const assistantId = createAssistant ? "__managed_default__" : required(config.assistantId, "Telnyx AI assistant");
    const assistantName = String(config.assistantName || "").trim();
    const assistantUseCase = String(config.assistantUseCase || "").trim();
    const assistantInstructions = String(config.assistantInstructions || "").trim();
    const assistantGreeting = String(config.assistantGreeting || "").trim();
    const assistantContentGenerated = config.assistantContentGenerated === true;
    if (createAssistant) {
      if (!assistantName) throw new Error("Enter a name for the new AI assistant");
      if (!assistantUseCase) throw new Error("Describe the new AI assistant use case");
      if (!assistantInstructions) throw new Error("Generate or enter AI assistant instructions");
      if (!assistantGreeting) throw new Error("Generate or enter an AI assistant greeting");
      if (!assistantContentGenerated) throw new Error("Generate the assistant content with AI before continuing");
    }
    const callerAddress = required(config.callerAddress, "Outbound caller ID");
    if (!/^\+[1-9]\d{7,14}$/.test(callerAddress)) {
      throw new Error("Outbound caller ID must be an E.164 number");
    }
    return {
      applicationName: installationName,
      deploymentId: "CALLBACKS",
      queueIds,
      defaultQueueId,
      assistantId,
      createAssistant,
      assistantName,
      assistantUseCase,
      assistantInstructions,
      assistantGreeting,
      assistantContentGenerated,
      callerAddress,
      callerName: String(config.callerName || installationName).trim() || installationName,
      siteId: required(config.siteId, "Genesys Site"),
      wrapupCodeId: required(config.wrapupCodeId, "Default wrap-up code"),
    };
  }
  const queueIds = csv(config.queueIds);
  if (!queueIds.length) throw new Error("Select at least one Genesys queue");
  const defaultQueueId = required(config.defaultQueueId, "Default Genesys queue");
  if (!queueIds.includes(defaultQueueId)) {
    throw new Error("Default Genesys queue must be selected in the global allowlist");
  }
  return {
    applicationName: installationName,
    deploymentId: "WEBCHAT",
    queueIds,
    defaultQueueId,
  };
}

export function adminComponentPlanSummary(component, installerPlan, config = {}) {
  if (component === "tts") {
    const testFlowProfiles = new Set(config.testFlowProfiles || []);
    return {
      target: installerPlan.organization,
      resources: (installerPlan.operations || []).flatMap((operation) => [
        {
          action: operation.action,
          type: "Genesys TTS Connector",
          name: operation.profileId,
        },
        ...(testFlowProfiles.has(operation.profileId) ? [{
          action: "ENSURE",
          type: "Genesys Architect test flow",
          name: operation.profileId,
        }] : []),
      ]),
      warnings: [
        ADMIN_SHARED_TTS_WARNING,
        ...(installerPlan.warnings || []).filter((warning) => warning !== ADMIN_SHARED_TTS_WARNING),
      ],
    };
  }
  if (component === "audio") {
    const changes = installerPlan.changes || null;
    if (changes) {
      const reassignedDids = [
        ...(installerPlan.callRoute?.takeovers || []).map((takeover) => ({
          ...takeover,
          source: takeover.routeName,
        })),
        ...(installerPlan.callRoute?.ownerTakeovers || []).map((takeover) => ({
          ...takeover,
          source: `${takeover.ownerName} (${takeover.ownerType})`,
        })),
      ];
      return {
        target: installerPlan.organization,
        resources: [
          ...(changes.handoffToolChanged ? [{
            action: installerPlan.telnyxHandoffTool?.action || "ENSURE",
            type: "Shared Telnyx webhook tool",
            name: "request_genesys_human_handoff",
          }] : []),
          ...(changes.addedAssistants || []).map(({ id, name }) => ({
            action: "ATTACH",
            type: "Telnyx AI Assistant",
            name: `${name} · ${id}`,
          })),
          ...(changes.removedAssistants || []).map(({ id, name }) => ({
            action: "DETACH",
            type: "Telnyx AI Assistant",
            name: `${name} · ${id}`,
          })),
          ...(changes.audioConnectorChanged ? [{
            action: installerPlan.audioConnector?.operation === "create-managed" ? "CREATE" : "UPDATE",
            type: "Genesys Audio Connector",
            name: installerPlan.audioConnector.name,
          }] : []),
          ...(changes.architectFlowChanged ? [{
            action: changes.isCreate ? "CREATE" : "UPDATE",
            type: "Genesys Architect flow",
            name: installerPlan.resources.flowName,
          }] : []),
          ...reassignedDids.map((takeover) => ({
            action: "REASSIGN",
            type: "Genesys DID",
            name: `${takeover.dnis} · ${takeover.source} → ${installerPlan.callRoute.name}`,
          })),
          ...(changes.callRouteChanged ? [{
            action: installerPlan.callRoute?.operation || "ENSURE",
            type: "Genesys inbound call route",
            name: installerPlan.callRoute?.name || installerPlan.resources.callRouteName,
          }] : []),
          ...(changes.interactionWidgetChanged ? [{
            action: changes.isCreate ? "CREATE" : "UPDATE",
            type: "Genesys interaction widget",
            name: installerPlan.resources.widgetName,
          }] : []),
          ...(changes.handoffScriptChanged ? [{
            action: changes.isCreate ? "CREATE" : "UPDATE",
            type: "Genesys handoff script",
            name: installerPlan.resources.handoffScriptName,
          }] : []),
        ],
        warnings: [],
      };
    }
    const assistants = new Map(
      (installerPlan.architect?.routes || []).map((route) => [route.assistantId, route.assistantName || route.assistantId])
    );
    return {
      target: installerPlan.organization,
      resources: [
        {
          action: installerPlan.telnyxHandoffTool?.action || "ENSURE",
          type: "Shared Telnyx webhook tool",
          name: "request_genesys_human_handoff",
        },
        ...[...assistants].map(([id, name]) => ({
          action: "ATTACH",
          type: "Telnyx AI Assistant",
          name: `${name} · ${id}`,
        })),
        { action: "ENSURE", type: "Genesys Audio Connector", name: installerPlan.audioConnector.name },
        { action: "ENSURE", type: "Genesys Architect flow", name: installerPlan.resources.flowName },
        ...(installerPlan.callRoute?.takeovers || []).map((takeover) => ({
          action: "REASSIGN",
          type: "Genesys DID",
          name: `${takeover.dnis} · ${takeover.routeName} → ${installerPlan.callRoute.name}`,
        })),
        {
          action: installerPlan.callRoute?.operation || "ENSURE",
          type: "Genesys inbound call route",
          name: installerPlan.callRoute?.name || installerPlan.resources.callRouteName,
        },
        { action: "ENSURE", type: "Genesys interaction widget", name: installerPlan.resources.widgetName },
        { action: "ENSURE", type: "Genesys handoff script", name: installerPlan.resources.handoffScriptName },
      ],
      warnings: [],
    };
  }
  if (component === "callbacks") {
    const resourceName = installationResourceNames().callbacks;
    return {
      target: installerPlan.organization,
      resources: [
        ...(installerPlan.assistant ? [{
          action: installerPlan.assistant.operation === "create" ? "CREATE" : "ATTACH",
          type: "Telnyx AI Assistant",
          name: installerPlan.assistant.name,
        }] : []),
        { action: "ENSURE", type: "Genesys Architect outbound call flow", name: resourceName },
        { action: "ENSURE", type: "Genesys Contact List", name: resourceName },
        { action: "ENSURE", type: "Genesys Contact List filter", name: resourceName },
        { action: "ENSURE", type: "Genesys Call Analysis Response Set", name: resourceName },
        { action: "ENSURE", type: "Genesys agentless campaign", name: resourceName },
      ],
      warnings: installerPlan.warnings || [],
    };
  }
  if (installerPlan.changes) {
    const changes = installerPlan.changes;
    return {
      target: installerPlan.organization,
      hasChanges: changes.hasChanges,
      resources: [
        ...(changes.openMessagingChanged ? [{
          action: installerPlan.resources.openMessaging.id ? "UPDATE" : "CREATE",
          type: "Genesys Open Messaging",
          name: installerPlan.resources.openMessaging.name,
        }] : []),
        ...(changes.architectFlowChanged ? [{
          action: installerPlan.messaging.routingFlow.id ? "UPDATE" : "CREATE",
          type: "Genesys Architect inbound message flow",
          name: installerPlan.messaging.routingFlow.name,
        }] : []),
        ...(changes.agentExperienceChanged ? [{
          action: "ENSURE",
          type: "Genesys handoff script",
          name: installerPlan.resources.handoffScript.name,
        }, {
          action: "ENSURE",
          type: "Genesys interaction widget",
          name: installerPlan.resources.interactionWidget.name,
        }] : []),
        ...(changes.recipientChanged || changes.architectFlowChanged ? [{
          action: "ASSIGN",
          type: "Genesys Open Messaging recipient",
          name: installerPlan.messaging.routingFlow.name,
        }] : []),
        ...(changes.handoffToolChanged ? [{
          action: installerPlan.resources.telnyxHandoffTool.id ? "UPDATE" : "CREATE",
          type: "Shared Telnyx webhook tool",
          name: "request_genesys_human_handoff",
        }] : []),
        ...(changes.manifestChanged ? [{
          action: "SAVE",
          type: "Managed Web Chat manifest",
          name: installerPlan.deployment.name,
        }] : []),
      ],
      warnings: [],
    };
  }
  return {
    target: installerPlan.organization,
    hasChanges: true,
    resources: [
      { action: "REUSE", type: "Genesys access group", name: installerPlan.access.group.name },
      { action: "REUSE", type: "Genesys administrator role", name: installerPlan.access.role.name },
      { action: installerPlan.resources.openMessaging.operation.toUpperCase(), type: "Genesys Open Messaging", name: installerPlan.resources.openMessaging.name },
      { action: installerPlan.messaging.routingFlow.operation === "create-or-update-managed" ? "ENSURE" : "UPDATE", type: "Genesys Architect inbound message flow", name: installerPlan.messaging.routingFlow.name },
      { action: installerPlan.resources.telnyxHandoffTool.operation.toUpperCase(), type: "Shared Telnyx webhook tool", name: "request_genesys_human_handoff" },
    ],
    warnings: [],
  };
}
