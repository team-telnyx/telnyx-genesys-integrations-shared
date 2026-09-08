import { randomUUID } from "node:crypto";

import Telnyx from "telnyx";

import { loadAdminConsoleGenesysContext } from "./admin-console-installer.mjs";
import { ADMIN_ASSISTANT_RECOMMENDED_MODEL } from "./admin-assistant-generator.mjs";
import {
  ADMIN_SHARED_HANDOFF_TOOL_KEY,
  getAdminManagedTool,
} from "./admin-managed-tools.mjs";
import {
  GENESYS_AUDIO_CONNECTOR_ID,
  GENESYS_AUDIO_HANDOFF_SCRIPT_NAME,
} from "./audio-connector-config.mjs";
import { adminComponentPlanSummary } from "./admin-components.mjs";
import { installationResourceNames } from "./installation-scope.mjs";
import { registerManagedResourceBatch } from "./managed-resource-registry.mjs";
import {
  findAssistantByExactName,
  provisionSharedGenesysHandoff,
  provisionTelnyxAssistant,
} from "../../scripts/provision-telnyx-genesys-assistant.mjs";
import {
  listAudioConnectorIntegrations,
  listManagedAudioDeployments,
  PRIMARY_AUDIO_DEPLOYMENT_ID,
} from "../../scripts/manage-genesys-audio.mjs";
import { publishArchitectFlow } from "../../scripts/provision-genesys-audio-connector-flow.mjs";

export const CALLBACK_RESOURCE_NAME = installationResourceNames().callbacks;
export function callbackResourceName(environment = process.env) {
  return installationResourceNames(environment).callbacks;
}
export const CALLBACK_CONTACT_COLUMNS = Object.freeze([
  "phone_number",
  "phone_timezone",
  "first_name",
  "last_name",
  "email",
  "topic_key",
  "topic_label",
  "description",
  "callback_mode",
  "callback_at_utc",
  "callback_timezone",
  "customer_locale",
  "callback_request_id",
  "widget_id",
  "consent_phone",
  "consent_sms",
  "consent_email",
  "consent_text",
  "consent_timestamp_utc",
  "consent_policy_version",
  "created_at_utc",
]);

function exactNamed(entities, name, type) {
  const matches = (entities || []).filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error(`More than one Genesys ${type} is named ${name}`);
  return matches[0] || null;
}

export function resolvePublishedHandoffScript(entities, audioDeployment) {
  const scriptId = audioDeployment?.resources?.scriptId || null;
  const scriptName = audioDeployment?.resourceNames?.handoffScriptName ||
    audioDeployment?.deployment?.name || GENESYS_AUDIO_HANDOFF_SCRIPT_NAME;
  const exactMatches = (entities || []).filter((entry) => entry.name === scriptName);
  if (scriptId) return exactMatches.find((entry) => entry.id === scriptId) || null;
  if (exactMatches.length > 1) {
    throw new Error(`More than one Genesys published handoff script is named ${scriptName}`);
  }
  return exactMatches[0] || null;
}

async function listAll(fetchPage) {
  const entities = [];
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = await fetchPage(pageNumber);
    entities.push(...(page.entities || []));
    if (!page.nextUri || !(page.entities || []).length) return entities;
  }
  throw new Error("Genesys pagination exceeded 100 pages");
}

export function callbackContactListBody() {
  const name = callbackResourceName();
  return {
    name,
    columnNames: [...CALLBACK_CONTACT_COLUMNS],
    phoneColumns: [{
      columnName: "phone_number",
      type: "Cell",
      callableTimeColumnName: "phone_timezone",
    }],
    automaticTimeZoneMapping: false,
    trimWhitespace: true,
    columnDataTypeSpecifications: [{
      columnName: "callback_at_utc",
      columnDataType: "TIMESTAMP",
    }],
  };
}

export function callbackContactListFilterBody(contactListId) {
  const name = callbackResourceName();
  return {
    name,
    contactList: { id: contactListId },
    sourceType: "ContactList",
    filterType: "AND",
    clauses: [{
      filterType: "AND",
      predicates: [{
        column: "callback_at_utc",
        columnType: "alphabetic",
        operator: "BEFORE",
        value: "P00DT00H00M",
      }],
    }],
  };
}

function normalizedContactListFilter(filter) {
  return {
    name: filter?.name || "",
    contactListId: filter?.contactList?.id || "",
    sourceType: filter?.sourceType || "",
    filterType: filter?.filterType || "",
    clauses: (filter?.clauses || []).map((clause) => ({
      filterType: clause?.filterType || "",
      predicates: (clause?.predicates || []).map((predicate) => ({
        column: predicate?.column || "",
        columnType: predicate?.columnType || "",
        operator: predicate?.operator || "",
        value: predicate?.value || "",
        inverted: Boolean(predicate?.inverted),
      })),
    })),
  };
}

export function callbackContactListFilterMatches(actual, desired) {
  return JSON.stringify(normalizedContactListFilter(actual)) ===
    JSON.stringify(normalizedContactListFilter(desired));
}

export function callbackResponseSetBody(flowId) {
  const name = callbackResourceName();
  const hangupDispositions = [
    "disposition.classification.uncallable.sit",
    "disposition.classification.callable.busy",
    "disposition.classification.callable.noanswer",
    "disposition.classification.callable.sit",
    "disposition.classification.callable.fax",
    "disposition.classification.callable.disconnect",
    "disposition.classification.uncallable.notfound",
  ];
  const transferToFlow = {
    reactionType: "transfer_flow",
    // Genesys renders this field as the selected flow label in the Call
    // Analysis Response editor. Keep it equal to the managed flow name while
    // `data` remains the authoritative flow ID.
    name,
    data: flowId,
  };
  return {
    name,
    responses: {
      "disposition.classification.callable.person": transferToFlow,
      // Genesys requires answering machines to transfer when beep detection is enabled.
      // The transfer is released after the detected voicemail beep.
      "disposition.classification.callable.machine": transferToFlow,
      ...Object.fromEntries(hangupDispositions.map((disposition) => [
        disposition,
        { reactionType: "hangup" },
      ])),
    },
    beepDetectionEnabled: true,
  };
}

function normalizedResponseSet(responseSet) {
  return {
    name: responseSet?.name || "",
    responses: Object.fromEntries(Object.entries(responseSet?.responses || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([disposition, reaction]) => [disposition, {
        reactionType: reaction?.reactionType || "",
        name: reaction?.name || "",
        data: reaction?.data || "",
      }])),
    beepDetectionEnabled: Boolean(responseSet?.beepDetectionEnabled),
  };
}

export function callbackResponseSetMatches(actual, desired) {
  return JSON.stringify(normalizedResponseSet(actual)) ===
    JSON.stringify(normalizedResponseSet(desired));
}

export function callbackCampaignBody(config, resources) {
  return {
    name: callbackResourceName(),
    contactList: { id: resources.contactListId },
    dialingMode: "agentless",
    site: { id: config.siteId },
    phoneColumns: [{ columnName: "phone_number", type: "Cell" }],
    callAnalysisResponseSet: { id: resources.responseSetId },
    callerName: config.callerName,
    callerAddress: config.callerAddress,
    outboundLineCount: 1,
    alwaysRunning: true,
    contactListFilters: [{ id: resources.contactListFilterId }],
    dynamicContactQueueingSettings: { sort: false, filter: true },
    callAnalysisLanguage: "en-US",
    campaignStatus: "off",
  };
}

export function normalizeCallbackCampaignStatus(status) {
  return String(status || "unknown").trim().toLowerCase() || "unknown";
}

function finiteRecordCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

export function callbackContactListRecordCounts(contactList, filterPreview) {
  const callableRecords = finiteRecordCount(filterPreview?.filteredContacts);
  const previewTotal = finiteRecordCount(filterPreview?.totalContacts);
  return {
    callableRecords,
    totalRecords: previewTotal ?? finiteRecordCount(contactList?.size),
    recordCountsAvailable: callableRecords !== null && (previewTotal !== null || finiteRecordCount(contactList?.size) !== null),
  };
}

export async function setCallbackCampaignEnabled(
  outboundApi,
  campaignId,
  enabled,
  { attempts = 12, intervalMs = 500, sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) } = {}
) {
  const targetStatus = enabled ? "on" : "off";
  let campaign = await outboundApi.getOutboundCampaign(campaignId);
  if (normalizeCallbackCampaignStatus(campaign?.campaignStatus) === targetStatus) return campaign;

  if (enabled) await outboundApi.postOutboundCampaignStart(campaignId);
  else await outboundApi.postOutboundCampaignStop(campaignId);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);
    campaign = await outboundApi.getOutboundCampaign(campaignId);
    const status = normalizeCallbackCampaignStatus(campaign?.campaignStatus);
    if (status === targetStatus) return campaign;
    if (["invalid", "error"].includes(status)) {
      throw new Error(`Genesys campaign entered ${status} state`);
    }
  }
  throw new Error(
    `Genesys did not confirm campaign status ${targetStatus}; current status is ${normalizeCallbackCampaignStatus(campaign?.campaignStatus)}`
  );
}

async function callbackGenesysInventory(context) {
  const resourceName = callbackResourceName();
  const [contactLists, filters, responseSets, campaigns, flows, audioDeployments, audioIntegrations, sites, wrapupCodes] = await Promise.all([
    listAll((pageNumber) => context.outboundApi.getOutboundContactlists({ pageSize: 100, pageNumber })),
    listAll((pageNumber) => context.outboundApi.getOutboundContactlistfilters({ pageSize: 100, pageNumber })),
    listAll((pageNumber) => context.outboundApi.getOutboundCallanalysisresponsesets({ pageSize: 100, pageNumber })),
    listAll((pageNumber) => context.outboundApi.getOutboundCampaigns({ pageSize: 100, pageNumber })),
    context.architectApi.getFlows({ type: ["OUTBOUNDCALL"], name: resourceName, pageSize: 100 }),
    listManagedAudioDeployments(),
    listAudioConnectorIntegrations(context.integrationsApi),
    context.telephonyApi.getTelephonyProvidersEdgesSites({ pageSize: 100, pageNumber: 1 }),
    context.routingApi.getRoutingWrapupcodes({ pageSize: 100, pageNumber: 1 }),
  ]);
  const audioDeployment = audioDeployments.find(({ deployment }) => deployment.id === PRIMARY_AUDIO_DEPLOYMENT_ID);
  const audioIntegrationId = audioDeployment?.resources?.audioConnectorIntegrationId;
  const audioIntegration = audioIntegrations.find(({ id }) => id === audioIntegrationId) ||
    exactNamed(audioIntegrations, resourceName, "Audio Connector");
  const handoffScriptName = audioDeployment?.resourceNames?.handoffScriptName ||
    audioDeployment?.deployment?.name || GENESYS_AUDIO_HANDOFF_SCRIPT_NAME;
  const scripts = await context.scriptsApi.getScriptsPublished({
    pageSize: 100,
    pageNumber: 1,
    name: handoffScriptName,
  });
  return {
    contactList: exactNamed(contactLists, resourceName, "Contact List"),
    filter: exactNamed(filters, resourceName, "Contact List filter"),
    responseSet: exactNamed(responseSets, resourceName, "Call Analysis Response Set"),
    campaign: exactNamed(campaigns, resourceName, "campaign"),
    flow: exactNamed(flows.entities, resourceName, "outbound Architect flow"),
    handoffScript: resolvePublishedHandoffScript(scripts.entities, audioDeployment),
    handoffScriptName,
    audioIntegration,
    site: (sites.entities || []).find(({ id }) => id === context.config?.siteId),
    sites: sites.entities || [],
    wrapupCodes: wrapupCodes.entities || [],
  };
}

function assertManagedContactList(contactList) {
  if (!contactList) return;
  const columns = new Set(contactList.columnNames || []);
  const missing = CALLBACK_CONTACT_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length) {
    throw new Error(`Existing Contact List ${callbackResourceName()} is not managed by this integration; missing columns: ${missing.join(", ")}`);
  }
}

export async function prepareCallbacksDeployment(config) {
  const context = await loadAdminConsoleGenesysContext({
    environment: process.env.GC_ENVIRONMENT,
    clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
    clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
  });
  context.config = config;
  const inventory = await callbackGenesysInventory(context);
  assertManagedContactList(inventory.contactList);
  if (!inventory.audioIntegration?.id) {
    throw new Error("Deploy AI Audio Connector before configuring Callbacks");
  }
  if (!inventory.handoffScript?.id) {
    throw new Error(
      `Published Genesys script ${inventory.handoffScriptName} was not found; reconcile the Audio Connector Agent Experience before configuring Callbacks`
    );
  }
  if (!inventory.sites.some(({ id }) => id === config.siteId)) throw new Error("Selected Genesys Site is unavailable");
  if (!inventory.wrapupCodes.some(({ id }) => id === config.wrapupCodeId)) throw new Error("Selected wrap-up code is unavailable");
  for (const queueId of config.queueIds) {
    if (!context.queues.some(({ id }) => id === queueId)) throw new Error(`Genesys queue ${queueId} is unavailable`);
  }
  const telnyx = new Telnyx({ apiKey: process.env.TELNYX_API_KEY });
  let assistant;
  if (config.createAssistant) {
    const existing = await findAssistantByExactName(telnyx, config.assistantName);
    if (existing) throw new Error(`A Telnyx AI assistant named ${config.assistantName} already exists; select it or choose a unique name`);
    assistant = { id: "__managed_default__", name: config.assistantName, operation: "create" };
  } else {
    const existing = await telnyx.ai.assistants.retrieve(config.assistantId);
    assistant = { id: existing.id, name: existing.name || existing.id, operation: "attach" };
  }
  const queues = config.queueIds.map((id) => {
    const queue = context.queues.find((entry) => entry.id === id);
    return { id, name: queue.name };
  });
  const plan = {
    schemaVersion: 1,
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    organization: { id: context.organization.id, name: context.organization.name },
    environment: context.environment,
    config,
    queues,
    assistant,
    dependencies: {
      audioConnectorIntegrationId: inventory.audioIntegration.id,
      handoffScriptId: inventory.handoffScript.id,
      wrapupCodeId: config.wrapupCodeId,
    },
    current: {
      contactListId: inventory.contactList?.id || null,
      contactListFilterId: inventory.filter?.id || null,
      responseSetId: inventory.responseSet?.id || null,
      campaignId: inventory.campaign?.id || null,
      flowId: inventory.flow?.id || null,
    },
  };
  return {
    config: { ...config, allowedQueues: queues, defaultQueueName: queues.find(({ id }) => id === config.defaultQueueId)?.name || "" },
    installerPlan: plan,
    installerPlanPath: null,
    summary: adminComponentPlanSummary("callbacks", plan),
    steps: [
      "Validate callback dependencies and configuration",
      config.createAssistant ? "Create the callback Telnyx AI Assistant and attach handoff" : "Attach shared handoff to the callback Telnyx AI Assistant",
      "Ensure the Genesys Contact List",
      "Publish the outbound Architect flow",
      "Ensure the callback time filter",
      "Ensure the Call Analysis Response Set",
      "Ensure the agentless callback campaign",
    ],
  };
}

async function ensureContactList(outboundApi, currentId) {
  if (currentId) return outboundApi.getOutboundContactlist(currentId);
  return outboundApi.postOutboundContactlists(callbackContactListBody());
}

async function ensureFilter(outboundApi, currentId, contactListId) {
  const body = callbackContactListFilterBody(contactListId);
  if (currentId) {
    const current = await outboundApi.getOutboundContactlistfilter(currentId);
    try {
      return await outboundApi.putOutboundContactlistfilter(currentId, { ...body, version: current.version });
    } catch (error) {
      const written = await outboundApi.getOutboundContactlistfilter(currentId).catch(() => null);
      if (callbackContactListFilterMatches(written, body)) return written;
      throw error;
    }
  }
  try {
    return await outboundApi.postOutboundContactlistfilters(body);
  } catch (error) {
    const listing = await outboundApi.getOutboundContactlistfilters({
      pageSize: 100,
      pageNumber: 1,
      name: body.name,
      contactListId,
    }).catch(() => null);
    const written = (listing?.entities || []).find((entry) =>
      callbackContactListFilterMatches(entry, body)
    );
    if (written) return written;
    throw error;
  }
}

export async function ensureCallbackResponseSet(outboundApi, currentId, flowId) {
  const body = callbackResponseSetBody(flowId);
  if (currentId) {
    const current = await outboundApi.getOutboundCallanalysisresponseset(currentId);
    try {
      return await outboundApi.putOutboundCallanalysisresponseset(currentId, {
        ...body,
        version: current.version,
      });
    } catch (error) {
      const written = await outboundApi.getOutboundCallanalysisresponseset(currentId).catch(() => null);
      if (callbackResponseSetMatches(written, body)) return written;
      throw error;
    }
  }
  try {
    return await outboundApi.postOutboundCallanalysisresponsesets(body);
  } catch (error) {
    const listing = await outboundApi.getOutboundCallanalysisresponsesets({
      pageSize: 100,
      pageNumber: 1,
      name: body.name,
    }).catch(() => null);
    const written = (listing?.entities || []).find((entry) =>
      callbackResponseSetMatches(entry, body)
    );
    if (written) return written;
    throw error;
  }
}

export async function ensureCallbackCampaign(outboundApi, currentId, config, resources) {
  const body = callbackCampaignBody(config, resources);
  if (currentId) {
    const current = await outboundApi.getOutboundCampaign(currentId);
    return outboundApi.putOutboundCampaign(currentId, {
      ...body,
      // Deployment reconciles configuration, but an administrator controls
      // the runtime state separately. Never stop a running campaign merely
      // because its managed resources are being updated.
      campaignStatus: current.campaignStatus || body.campaignStatus,
      version: current.version,
    });
  }
  return outboundApi.postOutboundCampaigns(body);
}

export async function applyCallbacksDeployment(plan, { onProgress, dependencies = {} } = {}) {
  if (plan?.schemaVersion !== 1 || !plan?.config) throw new Error("Unsupported Callbacks deployment plan");
  const progress = async (ordinal, status, detail) => {
    await onProgress?.({ ordinal, status, detail });
  };
  const context = await (dependencies.loadAdminConsoleGenesysContext || loadAdminConsoleGenesysContext)({
    environment: process.env.GC_ENVIRONMENT,
    clientId: process.env.GC_CLIENT_CRED_CLIENT_ID,
    clientSecret: process.env.GC_CLIENT_CRED_CLIENT_SECRET,
  });
  if (context.organization.id !== plan.organization.id) throw new Error("Genesys organization changed after the Callbacks plan was created");
  await progress(1, "running", "Attaching the shared handoff configuration to the callback assistant");
  const config = plan.config;
  const managedTool = await (dependencies.getAdminManagedTool || getAdminManagedTool)({
    organizationId: context.organization.id,
    logicalKey: ADMIN_SHARED_HANDOFF_TOOL_KEY,
  });
  let assistantId = config.assistantId;
  let assistantResult;
  if (config.createAssistant) {
    assistantResult = await (dependencies.provisionTelnyxAssistant || provisionTelnyxAssistant)({
      assistantName: config.assistantName,
      queuesJson: JSON.stringify(plan.queues),
      defaultQueueId: config.defaultQueueId,
      preferredToolId: managedTool?.remoteToolId || null,
      assistantConfig: {
        forceCreate: true,
        useCase: config.assistantUseCase,
        instructions: config.assistantInstructions,
        greeting: config.assistantGreeting,
        model: ADMIN_ASSISTANT_RECOMMENDED_MODEL,
        transcription: { model: "deepgram/flux", language: "en" },
        voiceSettings: { voice: "Telnyx.Ultra.aura", expressive_mode: true },
      },
    });
    assistantId = assistantResult.assistant.id;
  } else {
    assistantResult = await (dependencies.provisionSharedGenesysHandoff || provisionSharedGenesysHandoff)({
      assistantIds: [assistantId],
      queues: plan.queues,
      defaultQueueId: config.defaultQueueId,
      preferredToolId: managedTool?.remoteToolId || "",
    });
  }
  await progress(1, "succeeded", "Callback assistant handoff configuration attached");
  await progress(2, "running", "Ensuring the callback Contact List");
  const contactList = await ensureContactList(context.outboundApi, plan.current.contactListId);
  await progress(2, "succeeded", "Callback Contact List is ready");
  await progress(3, "running", "Publishing the callback outbound Architect flow");
  const resourceName = callbackResourceName();
  const flows = await context.architectApi.getFlows({ type: ["OUTBOUNDCALL"], name: resourceName, pageSize: 100 });
  const existingFlow = exactNamed(flows.entities, resourceName, "outbound Architect flow");
  const flow = await (dependencies.publishArchitectFlow || publishArchitectFlow)({
    environment: context.environment,
    accessToken: context.accessToken,
    existingFlow,
    integrationId: plan.dependencies.audioConnectorIntegrationId,
    connectorId: GENESYS_AUDIO_CONNECTOR_ID,
    handoffScriptId: plan.dependencies.handoffScriptId,
    flowName: resourceName,
    outboundAssistantId: assistantId,
    contactListId: contactList.id,
    wrapupCodeId: config.wrapupCodeId,
  });
  await progress(3, "succeeded", "Callback outbound Architect flow is ready");
  await progress(4, "running", "Ensuring the callback time filter");
  const filter = await ensureFilter(context.outboundApi, plan.current.contactListFilterId, contactList.id);
  await progress(4, "succeeded", "Callback time filter is ready");
  await progress(5, "running", "Ensuring the Call Analysis Response Set");
  const responseSet = await ensureCallbackResponseSet(context.outboundApi, plan.current.responseSetId, flow.id);
  await progress(5, "succeeded", "Call Analysis Response Set is ready");
  await progress(6, "running", "Ensuring the agentless callback campaign");
  const campaign = await ensureCallbackCampaign(context.outboundApi, plan.current.campaignId, config, {
    contactListId: contactList.id,
    contactListFilterId: filter.id,
    responseSetId: responseSet.id,
  });
  await progress(6, "succeeded", "Agentless callback campaign is ready");
  if (config.createAssistant) {
    await registerManagedResourceBatch({
      organizationId: context.organization.id,
      aggregate: {
        kind: "callback_campaign",
        name: "default",
        desiredConfig: { installationName: installationResourceNames().installationName },
      },
      resources: [
        {
          key: "assistant", provider: "telnyx", resourceType: "ai_assistant",
          remoteId: assistantResult.assistant?.created ? assistantResult.assistant.id : null,
          displayName: assistantResult.assistant?.name, logicalKey: "callback_assistant",
        },
        {
          key: "handoff_tool", provider: "telnyx", resourceType: "ai_tool",
          remoteId: assistantResult.tool?.created ? assistantResult.tool.id : null,
          displayName: assistantResult.tool?.displayName, logicalKey: "shared_handoff_tool",
        },
        {
          key: "hangup_tool", provider: "telnyx", resourceType: "ai_tool",
          remoteId: assistantResult.hangupTool?.created ? assistantResult.hangupTool.id : null,
          displayName: assistantResult.hangupTool?.displayName, logicalKey: "shared_hangup_tool",
        },
        {
          key: "integration_secret", provider: "telnyx", resourceType: "integration_secret",
          remoteId: assistantResult.integrationSecret?.created ? assistantResult.integrationSecret.id : null,
          displayName: assistantResult.integrationSecret?.identifier,
          logicalKey: "handoff_integration_secret",
        },
      ],
      dependencies: [
        { resource: "assistant", dependsOn: "handoff_tool", relationship: "uses_tool" },
        { resource: "assistant", dependsOn: "hangup_tool", relationship: "uses_tool" },
        { resource: "handoff_tool", dependsOn: "integration_secret", relationship: "uses_secret" },
      ],
    });
  }
  return {
    assistant: assistantResult.assistant || { id: assistantId },
    contactList: { id: contactList.id, name: contactList.name },
    flow,
    contactListFilter: { id: filter.id, name: filter.name },
    responseSet: { id: responseSet.id, name: responseSet.name },
    campaign: { id: campaign.id, name: campaign.name, status: campaign.campaignStatus },
  };
}
