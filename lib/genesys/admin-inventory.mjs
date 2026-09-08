import {
  listAllGenesysCredentials,
  loadTtsInventory,
} from "./tts-connector-genesys.mjs";
import {
  configMatchesProfile,
  inventorySnapshotHash,
  isTelnyxTtsInventoryEntry,
  markerForInventoryEntry,
  profilePayloadMatches,
} from "./tts-connector-manager.mjs";
import {
  getTtsConnectorProfile,
  verifiedTtsConnectorProfiles,
} from "./tts-connector-profiles.mjs";
import { listManagedGenesysTtsTestFlows } from "./tts-connector-architect.mjs";
import { listGenesysDidNumbers } from "./did-inventory.mjs";
import { installationResourceNames } from "./installation-scope.mjs";

const AGENT_EXPERIENCE_WIDGET_TYPE = "embedded-client-app-interaction-widget";
const AGENT_EXPERIENCE_WIDGET_PATH = "/genesys/ai-conversation-widget?conversationId={{gcConversationId}}";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function byName(left, right) {
  return String(left.name || "").localeCompare(String(right.name || ""));
}

function errorMessage(error) {
  return error?.body?.message || error?.message || String(error);
}

function publishedFlowVersion(flow) {
  const version = flow?.publishedVersion;
  return version?.commitVersion || version?.configurationVersion || version?.name || version?.id || null;
}

export async function listArchitectIvrs(architectApi) {
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await architectApi.getArchitectIvrs({
      pageNumber,
      pageSize: 100,
      sortBy: "name",
      sortOrder: "ASC",
      expand: ["dnis"],
    });
    entries.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entries;
  }
  throw new Error("Genesys inbound call route pagination exceeded 100 pages");
}

export async function listConfiguredGenesysDnis(architectApi, suppliedIvrs) {
  const ivrs = suppliedIvrs || await listArchitectIvrs(architectApi);
  const byDnis = new Map();
  for (const ivr of ivrs) {
    for (const value of ivr.dnis || []) {
      const dnis = String(value || "").trim();
      if (!dnis) continue;
      const entry = byDnis.get(dnis) || { dnis, routes: [] };
      entry.routes.push({ id: ivr.id, name: ivr.name || ivr.id });
      byDnis.set(dnis, entry);
    }
  }
  return [...byDnis.values()].sort((left, right) => left.dnis.localeCompare(right.dnis));
}

export async function listAllGenesysDids(telephonyApi, configuredDnis = []) {
  const routeByDnis = new Map((configuredDnis || []).map((entry) => [entry.dnis, entry.routes || []]));
  return (await listGenesysDidNumbers(telephonyApi))
    .map((entry) => {
      const dnis = entry.dnis;
      const routes = routeByDnis.get(dnis) || [];
      return {
        id: entry.id,
        dnis,
        assignee: entry.owner,
        didPool: entry.didPool,
        routes,
        used: Boolean(entry.assigned || routes.length),
      };
    })
    .sort((left, right) => left.dnis.localeCompare(right.dnis));
}

function architectDependencyFlowType(flowType) {
  const normalized = String(flowType || "INBOUNDCALL").trim().toUpperCase();
  if (normalized.endsWith("FLOW")) return normalized;
  return `${normalized}FLOW`;
}

async function listArchitectFlowConsumers(architectApi, flowId, flowType) {
  const dependencyType = architectDependencyFlowType(flowType);
  const dependency = await architectApi.getArchitectDependencytrackingObject(flowId, {
    objectType: dependencyType,
  });
  const objectType = dependency?.type || dependencyType;
  const entries = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await architectApi.getArchitectDependencytrackingConsumingresources(
      flowId,
      objectType,
      { pageNumber, pageSize: 100 }
    );
    entries.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) break;
  }
  return entries
    .filter((entry) => entry?.id && entry.id !== flowId && !entry.deleted)
    .map((entry) => ({
      id: entry.id,
      name: entry.name || entry.id,
      type: entry.type || "FLOW",
      version: entry.version || null,
    }));
}

function isArchitectFlowConsumer(entry) {
  return String(entry?.type || "").trim().toUpperCase().endsWith("FLOW");
}

function flowCallRouteReferences(flowId, ivrs) {
  const schedules = [
    ["Open hours", "openHoursFlow"],
    ["Closed hours", "closedHoursFlow"],
    ["Holiday hours", "holidayHoursFlow"],
  ];
  return ivrs.flatMap((ivr) => schedules.flatMap(([schedule, property]) =>
    ivr?.[property]?.id === flowId
      ? [{
          id: ivr.id,
          name: ivr.name || ivr.id,
          schedule,
          dnis: ivr.dnis || [],
        }]
      : []
  ));
}

export async function loadAudioArchitectFlowInventory({ manifests = [], architectApi } = {}) {
  if (!architectApi) return {};
  const flowTargets = unique(manifests.map((entry) => entry.resources?.flowId));
  if (!flowTargets.length) return {};

  let ivrs = [];
  let callRoutesError = null;
  try {
    ivrs = await listArchitectIvrs(architectApi);
  } catch (error) {
    callRoutesError = errorMessage(error);
  }

  const entries = await Promise.all(flowTargets.map(async (flowId) => {
    const manifest = manifests.find((entry) => entry.resources?.flowId === flowId);
    let flow = null;
    let flowError = null;
    let consumers = [];
    let consumersError = null;
    try {
      flow = await architectApi.getFlow(flowId);
    } catch (error) {
      flowError = errorMessage(error);
    }
    try {
      consumers = await listArchitectFlowConsumers(architectApi, flowId, flow?.type);
    } catch (error) {
      consumersError = errorMessage(error);
    }
    return [flowId, {
      id: flowId,
      name: flow?.name || manifest?.resourceNames?.flowName || manifest?.deployment?.name || flowId,
      type: flow?.type || null,
      version: publishedFlowVersion(flow),
      published: Boolean(flow?.publishedVersion),
      active: flow?.active !== false && !flow?.deleted,
      references: {
        // Dependency tracking also reports inbound call routes as
        // IVRCONFIGURATION consumers. Those are rendered from getArchitectIvrs
        // below, where schedule and DNIS information is available, and must not
        // be presented as another Architect flow.
        flows: consumers.filter(isArchitectFlowConsumer),
        callRoutes: flowCallRouteReferences(flowId, ivrs),
        complete: !consumersError && !callRoutesError,
        errors: [consumersError, callRoutesError].filter(Boolean),
      },
      error: flowError,
    }];
  }));
  return Object.fromEntries(entries);
}

function sameStringSet(left = [], right = []) {
  const normalized = (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
  return normalized(left).join("\n") === normalized(right).join("\n");
}

function expectedAgentExperienceUrl(manifest) {
  const baseUrl = String(manifest?.publicBaseUrl || "").replace(/\/$/, "");
  return baseUrl ? `${baseUrl}${AGENT_EXPERIENCE_WIDGET_PATH}` : null;
}

export async function loadAudioAgentExperienceInventory({
  manifests = [],
  integrationsApi,
  scriptsApi,
  groups = [],
  queues = [],
} = {}) {
  if (!integrationsApi) return {};
  const groupNames = new Map(groups.map((entry) => [entry.id, entry.name || entry.id]));
  const queueNames = new Map(queues.map((entry) => [entry.id, entry.name || entry.id]));
  const entries = await Promise.all(manifests.map(async (manifest) => {
    const deploymentId = String(manifest?.deployment?.id || "").toUpperCase();
    const widgetId = manifest?.resources?.widgetId;
    const scriptId = manifest?.resources?.scriptId;
    if (!deploymentId || (!widgetId && !scriptId)) return null;

    let widget = null;
    let widgetConfig = null;
    let widgetError = null;
    if (widgetId) {
      try {
        [widget, widgetConfig] = await Promise.all([
          integrationsApi.getIntegration(widgetId),
          integrationsApi.getIntegrationConfigCurrent(widgetId),
        ]);
      } catch (error) {
        widgetError = errorMessage(error);
      }
    }

    let script = null;
    let publishedScript = null;
    let scriptError = null;
    if (scriptId && scriptsApi) {
      try {
        script = await scriptsApi.getScript(scriptId);
        if (typeof scriptsApi.getScriptsPublished === "function") {
          const page = await scriptsApi.getScriptsPublished({
            pageSize: 100,
            pageNumber: 1,
            name: manifest?.resourceNames?.handoffScriptName || manifest?.deployment?.name,
          });
          publishedScript = (page.entities || []).find((entry) => entry.id === scriptId) || null;
        }
      } catch (error) {
        scriptError = errorMessage(error);
      }
    }

    const properties = widgetConfig?.properties || {};
    const expectedUrl = expectedAgentExperienceUrl(manifest);
    const expectedGroupIds = (manifest?.groups || []).map((entry) => entry.id);
    const expectedQueueIds = (manifest?.queues || []).map((entry) => entry.id);
    const actualGroupIds = properties.groups || [];
    const actualQueueIds = properties.queueIdFilterList || [];
    const drift = [];
    if (widget && widget.integrationType?.id !== AGENT_EXPERIENCE_WIDGET_TYPE) drift.push("integration type");
    if (widget && String(widget.intendedState || "").toUpperCase() !== "ENABLED") drift.push("intended state");
    if (expectedUrl && properties.url !== expectedUrl) drift.push("widget URL");
    if (!sameStringSet(actualGroupIds, expectedGroupIds)) drift.push("access groups");
    if (!sameStringSet(actualQueueIds, expectedQueueIds)) drift.push("queue filters");
    const reportedState = String(widget?.reportedState?.code || "UNKNOWN").toUpperCase();
    const widgetStatus = !widgetId ? "untracked"
      : widgetError || !widget ? "missing"
        : drift.length ? "drift"
          : reportedState === "ERROR" ? "error" : "healthy";
    const scriptStatus = !scriptId ? "untracked"
      : scriptError || !script ? "missing"
        : publishedScript || typeof scriptsApi?.getScriptsPublished !== "function" ? "healthy" : "unpublished";

    return [deploymentId, {
      status: widgetStatus === "healthy" && scriptStatus === "healthy" ? "healthy"
        : [widgetStatus, scriptStatus].includes("missing") ? "missing"
          : [widgetStatus, scriptStatus].includes("error") ? "error" : "drift",
      widget: {
        id: widgetId || null,
        name: widget?.name || manifest?.resourceNames?.widgetName || null,
        integrationType: widget?.integrationType?.id || null,
        intendedState: widget?.intendedState || null,
        reportedState,
        status: widgetStatus,
        drift,
        error: widgetError,
        url: properties.url || expectedUrl,
        communicationType: properties.communicationTypeFilter || null,
        groups: actualGroupIds.map((id) => ({ id, name: groupNames.get(id) || id })),
        queues: actualQueueIds.map((id) => ({ id, name: queueNames.get(id) || id })),
      },
      script: {
        id: scriptId || null,
        name: script?.name || manifest?.resourceNames?.handoffScriptName || null,
        status: scriptStatus,
        published: Boolean(publishedScript),
        versionId: publishedScript?.versionId || publishedScript?.publishedVersion?.id || null,
        error: scriptError,
      },
    }];
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

export async function resolveAdminTtsCredential(integrationsApi, suppliedInventory) {
  const inventory = suppliedInventory || await loadTtsInventory(integrationsApi);
  let credentialIds = unique(
    inventory
      .filter(isTelnyxTtsInventoryEntry)
      .map((entry) => entry.config?.credentials?.basicAuth?.id)
  );
  const credentials = await listAllGenesysCredentials(integrationsApi);
  if (!credentialIds.length) {
    credentialIds = credentials
      .filter((entry) =>
        entry.type?.name === "userDefined" &&
        (/^Telnyx TTS managed\b/.test(entry.name || "") || entry.name === "Telnyx TTS credential")
      )
      .map((entry) => entry.id);
  }
  if (credentialIds.length > 1) {
    return {
      mode: "conflict",
      label: `${credentialIds.length} credentials used by managed Telnyx TTS connectors`,
      credentialIds,
      connectorCount: inventory.length,
    };
  }
  if (!credentialIds.length) {
    return {
      mode: "create",
      label: "A managed credential will be created on first deployment",
      connectorCount: inventory.length,
    };
  }
  const credential = credentials.find((entry) => entry.id === credentialIds[0]);
  return {
    mode: "existing",
    id: credentialIds[0],
    name: credential?.name || "Existing Telnyx TTS credential",
    label: credential?.name || "Existing Telnyx TTS credential",
    connectorCount: inventory.length,
  };
}

function classifyTtsInventoryEntry(entry) {
  const marker = markerForInventoryEntry(entry);
  const staticMatches = verifiedTtsConnectorProfiles().filter((profile) =>
    profilePayloadMatches(entry.config, profile)
  );
  const profile = marker?.profileId ? getTtsConnectorProfile(marker.profileId) : staticMatches[0];
  const credentialId = entry.config?.credentials?.basicAuth?.id || null;
  const configHealthy = Boolean(marker && !marker.invalid && profile?.status === "verified") &&
    configMatchesProfile(entry, profile, credentialId);
  const active = String(entry.integration.reportedState?.code || "").toUpperCase() === "ACTIVE";
  const managed = Boolean(marker && !marker.invalid);
  return {
    integrationId: entry.integration.id,
    name: entry.integration.name,
    profileId: profile?.id || null,
    profileName: profile?.displayName || profile?.id || "Unknown Telnyx provider",
    managed,
    scope: "genesys_organization",
    ownership: managed ? "shared_managed" : "shared_external",
    active,
    healthy: configHealthy && active,
    reportedState: entry.integration.reportedState?.code || "UNKNOWN",
    observedSnapshotHash: inventorySnapshotHash(entry),
  };
}

export async function buildTtsDeploymentInventory({ inventory = [], architectApi } = {}) {
  const deployments = inventory
    .filter(isTelnyxTtsInventoryEntry)
    .map(classifyTtsInventoryEntry)
    .filter((entry) => entry.profileId);
  const flowLookup = await listManagedGenesysTtsTestFlows(
    architectApi,
    verifiedTtsConnectorProfiles()
  );
  const flowsByIntegration = new Map();
  for (const flow of flowLookup.flows) {
    const list = flowsByIntegration.get(flow.integrationId) || [];
    list.push(flow);
    flowsByIntegration.set(flow.integrationId, list);
  }
  return {
    deployments: deployments.sort(byName).map((entry) => ({
      ...entry,
      testFlows: flowsByIntegration.get(entry.integrationId) || [],
    })),
    flows: flowLookup.flows.map((flow) => ({
      ...flow,
      scope: "genesys_organization",
      ownership: "shared_managed",
    })),
    conflicts: flowLookup.conflicts,
  };
}

export function buildAudioDeploymentInventory({
  integrations = [],
  manifests = [],
  flowInventory = {},
  agentExperienceInventory = {},
} = {}) {
  const manifestById = new Map(
    manifests.map((entry) => [String(entry.deployment?.id || "").toUpperCase(), entry])
  );
  return integrations.flatMap((integration) => {
    const resourceManifest = manifests.find((entry) =>
      entry.resources?.audioConnectorIntegrationId === integration.id
    );
    const id = resourceManifest?.deployment?.id;
    if (!id) return [];
    const manifest = resourceManifest || manifestById.get(id);
    const flowId = manifest?.resources?.flowId;
    const routes = Array.isArray(manifest?.architect?.routes) && manifest.architect.routes.length
      ? manifest.architect.routes
      : (manifest?.architect?.dnis || []).map((dnis) => ({
          dnis,
          assistantId: manifest?.resources?.assistantId || "",
          assistantName: manifest?.resourceNames?.assistantName || "",
        }));
    return [{
      id,
      name: integration.name,
      connector: {
        id: integration.id,
        name: integration.name,
        integrationType: integration.integrationType?.id || "audio-connector",
        state: String(integration.reportedState?.code || "UNKNOWN").toUpperCase(),
        active: String(integration.reportedState?.code || "").toUpperCase() === "ACTIVE",
      },
      publicBaseUrl: manifest?.publicBaseUrl || null,
      updatedAt: manifest?.updatedAt || null,
      queues: Array.isArray(manifest?.queues) ? manifest.queues : [],
      defaultQueue: manifest?.defaultQueue || null,
      agentExperience: agentExperienceInventory[id] || null,
      resources: {
        audioConnectorIntegrationId: integration.id,
        flowId: manifest?.resources?.flowId || null,
        callRouteId: manifest?.resources?.callRouteId || null,
        widgetId: manifest?.resources?.widgetId || null,
        scriptId: manifest?.resources?.scriptId || null,
      },
      architectFlow: flowId ? flowInventory[flowId] || {
        id: flowId,
        name: manifest?.resourceNames?.flowName || manifest?.deployment?.name || flowId,
        type: null,
        version: null,
        published: false,
        active: false,
        references: { flows: [], callRoutes: [], complete: false, errors: ["Architect inventory was not loaded"] },
      } : null,
      config: {
        deploymentId: id,
        applicationName:
          manifest?.deployment?.applicationName ||
          integration.name,
        ...(manifest?.queues ? { queueIds: manifest.queues.map((entry) => entry.id) } : {}),
        ...(manifest?.defaultQueue?.id ? { defaultQueueId: manifest.defaultQueue.id } : {}),
        ...(manifest?.groups?.length ? { widgetGroupIds: manifest.groups.map((entry) => entry.id) } : {}),
        routes,
      },
    }];
  }).sort(byName);
}

export function buildWidgetDeploymentInventory({
  widgets = [],
  manifests = [],
  messageFlows = [],
  assistants = [],
} = {}) {
  const manifestById = new Map(
    manifests.map((entry) => [String(entry.deployment?.id || "").toUpperCase(), entry])
  );
  return widgets.flatMap((widget) => {
    if (!widget.published?.config) return [];
    const managedDeploymentId = String(widget.managedDeploymentId || "").toUpperCase();
    const id = String(
      widget.id || widget.publicId || widget.publishedRevisionId || widget.published.id || managedDeploymentId
    );
    if (!id) return [];
    const manifest = managedDeploymentId ? manifestById.get(managedDeploymentId) : null;
    const saved = widget.published.config;
    const messaging = saved.channels?.messaging || {};
    const voice = saved.channels?.voice || {};
    const deploymentName = widget.name || manifest?.deployment?.name || managedDeploymentId || id;
    const flow = manifest?.messaging?.routingFlow || messageFlows.find(
      (entry) => entry.name === deploymentName
    );
    const assistantId = manifest?.messaging?.assistant?.id || messaging.assistantId || "";
    const assistant = assistants.find((entry) => entry.id === assistantId);
    const queues = messaging.genesys?.queues || manifest?.messaging?.queues || [];
    return [{
      id,
      name: deploymentName,
      publicId: widget.publicId || null,
      managedDeploymentId: managedDeploymentId || null,
      publishedRevisionId: widget.publishedRevisionId || widget.published.id || null,
      publishedVersion: widget.published.version || null,
      enabled: widget.enabled !== false,
      config: {
        deploymentId: managedDeploymentId || null,
        name:
          manifest?.deployment?.applicationName ||
          deploymentName,
        ...(queues.length ? { queueIds: queues.map((entry) => entry.id) } : {}),
        ...(manifest?.access?.groups?.length
          ? { groupIds: manifest.access.groups.map((entry) => entry.id) }
          : {}),
        ...(saved.allowedOrigins?.length
          ? { allowedOrigins: saved.allowedOrigins }
          : manifest?.messaging?.allowedOrigins?.length
            ? { allowedOrigins: manifest.messaging.allowedOrigins }
            : {}),
        messageFlowId: flow?.id || manifest?.resources?.messageFlowId || "",
        messageFlowManaged: manifest?.messaging?.routingFlow?.managed === true,
        messagingAssistantId: assistantId,
        messagingAssistantManaged: manifest?.messaging?.assistant?.managed === true,
        voiceEnabled: Boolean(voice.enabled || manifest?.voice?.enabled),
        voiceAssistantId: voice.assistantId || manifest?.voice?.assistantId || "",
        voiceAssistantVersionId:
          voice.assistantVersionId || manifest?.voice?.assistantVersionId || "main",
        genesysSipUri: voice.genesysSipUri || manifest?.voice?.genesysSipUri || "",
        genesysTrunkId:
          voice.genesysTrunkId || manifest?.voice?.genesysTrunkId ||
          manifest?.voice?.sipDestination?.trunk?.id || "",
        callerNumber: manifest?.voice?.callerNumber || process.env.TELNYX_WIDGET_CALLER_NUMBER || "",
        voiceRegion: voice.region || manifest?.voice?.region || "auto",
        keepAssistantOnCall: voice.keepAssistantOnCall === true,
      },
      resources: {
        messageFlowName: flow?.name || "",
        messagingAssistantName: assistant?.name || manifest?.messaging?.assistant?.name || "",
      },
    }];
  }).sort(byName);
}

function managedResourceStatus(found, healthy = true) {
  if (!found) return "missing";
  return healthy ? "healthy" : "drifted";
}

export function buildWebChatInfrastructureInventory({
  manifest = null,
  messageFlows = [],
  openMessagingIntegrations = [],
  recipient = null,
  managedTools = [],
  desiredProfile = null,
  publicBaseUrl = "",
} = {}) {
  if (!manifest) {
    return {
      configured: false,
      status: "not_configured",
      updatedAt: null,
      flow: { status: "missing" },
      openMessaging: { status: "missing" },
      recipient: { status: "missing" },
      handoffTool: { status: "missing" },
      queues: { status: "not_configured", entries: [], defaultQueue: null },
      access: { group: null, role: null },
      allowedOrigins: [],
      publicBaseUrl: publicBaseUrl || null,
    };
  }
  const expectedFlow = manifest.messaging?.routingFlow || {};
  const flow = messageFlows.find((entry) =>
    entry.id === expectedFlow.id || entry.name === expectedFlow.name
  ) || null;
  const expectedOpenMessagingId = manifest.resources?.openMessagingIntegrationId || "";
  const openMessaging = openMessagingIntegrations.find((entry) =>
    entry.id === expectedOpenMessagingId
  ) || null;
  const expectedRecipientId = manifest.messaging?.recipientId || openMessaging?.recipient?.id || "";
  const expectedToolId = manifest.resources?.telnyxHandoffToolId || "";
  const handoffTool = managedTools.find((entry) => entry.remoteToolId === expectedToolId) || null;
  const expectedQueueIds = (manifest.messaging?.queues || []).map(({ id }) => id).sort();
  const desiredQueueIds = (desiredProfile?.queueIds || []).slice().sort();
  const queueMatches = Boolean(
    desiredProfile?.source === "desired" &&
    JSON.stringify(expectedQueueIds) === JSON.stringify(desiredQueueIds) &&
    manifest.messaging?.defaultQueue?.id === desiredProfile.defaultQueueId
  );
  const flowPublished = Boolean(flow?.publishedVersion?.id || flow?.publishedVersion);
  const integrationReady = Boolean(
    openMessaging &&
    !openMessaging.createError &&
    !["failed", "error"].includes(String(openMessaging.createStatus || openMessaging.status || "").toLowerCase())
  );
  const recipientLinked = Boolean(
    recipient?.id === expectedRecipientId &&
    recipient?.flow?.id === flow?.id
  );
  const toolHealthy = Boolean(handoffTool && handoffTool.status !== "missing");
  const resourceStatuses = [
    managedResourceStatus(flow, flowPublished),
    managedResourceStatus(openMessaging, integrationReady),
    managedResourceStatus(recipient, recipientLinked),
    managedResourceStatus(handoffTool, toolHealthy),
    queueMatches ? "healthy" : "drifted",
  ];
  const status = resourceStatuses.includes("missing")
    ? "missing"
    : resourceStatuses.includes("drifted") ? "drifted" : "healthy";
  return {
    configured: true,
    status,
    updatedAt: manifest.updatedAt || null,
    flow: {
      id: flow?.id || expectedFlow.id || null,
      name: flow?.name || expectedFlow.name || null,
      version: publishedFlowVersion(flow),
      published: flowPublished,
      status: managedResourceStatus(flow, flowPublished),
    },
    openMessaging: {
      id: openMessaging?.id || expectedOpenMessagingId || null,
      name: openMessaging?.name || null,
      providerStatus: openMessaging?.createStatus || openMessaging?.status || null,
      webhookUrl: openMessaging?.outboundNotificationWebhookUrl || null,
      status: managedResourceStatus(openMessaging, integrationReady),
    },
    recipient: {
      id: recipient?.id || expectedRecipientId || null,
      name: recipient?.name || null,
      flowId: recipient?.flow?.id || null,
      flowName: recipient?.flow?.name || null,
      status: managedResourceStatus(recipient, recipientLinked),
    },
    handoffTool: {
      id: handoffTool?.remoteToolId || expectedToolId || null,
      name: handoffTool?.displayName || handoffTool?.name ||
        manifest.resourceNames?.telnyxHandoffTool || installationResourceNames().widgetHandoffTool,
      status: managedResourceStatus(handoffTool, toolHealthy),
    },
    queues: {
      status: queueMatches ? "healthy" : "drifted",
      entries: manifest.messaging?.queues || [],
      defaultQueue: manifest.messaging?.defaultQueue || null,
      desiredCount: desiredProfile?.queueIds?.length || 0,
    },
    access: {
      group: manifest.access?.group || null,
      role: manifest.access?.role || null,
    },
    allowedOrigins: manifest.messaging?.allowedOrigins || [],
    publicBaseUrl: manifest.publicBaseUrl || publicBaseUrl || null,
  };
}
