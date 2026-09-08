import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import platformClient from "purecloud-platform-client-v2";
import {
  GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES,
  genesysAudioDnisValues,
} from "../lib/genesys/audio-connector-flow-config.mjs";
import {
  GENESYS_AUDIO_CONNECTOR_ID,
  GENESYS_AUDIO_FLOW_NAME,
  GENESYS_AUDIO_HANDOFF_SCRIPT_NAME,
  genesysAudioConnectorBaseUri,
} from "../lib/genesys/audio-connector-config.mjs";
import { ensureAudioCallRoute } from "../lib/genesys/audio-call-route.mjs";

const AUDIO_CONNECTOR_TYPE = "audio-connector";
const TELNYX_ASSISTANT_TASK_NAME = "Run dynamically selected Telnyx assistant";

export function normalizeAssistantRoutes(routes = []) {
  const normalized = (Array.isArray(routes) ? routes : []).map((route) => ({
    dnis: String(route?.dnis || "").trim(),
    assistantId: String(route?.assistantId || "").trim(),
  })).filter(({ dnis, assistantId }) => dnis && assistantId);
  const seen = new Set();
  for (const route of normalized) {
    if (seen.has(route.dnis)) throw new Error(`DNIS ${route.dnis} is assigned more than once`);
    seen.add(route.dnis);
  }
  if (!normalized.length) throw new Error("Configure at least one DNIS-to-assistant assignment");
  return normalized;
}

export function groupAssistantRoutes(routes = []) {
  const grouped = new Map();
  for (const route of normalizeAssistantRoutes(routes)) {
    const entry = grouped.get(route.assistantId) || { assistantId: route.assistantId, dnis: [] };
    entry.dnis.push(route.dnis);
    grouped.set(route.assistantId, entry);
  }
  return [...grouped.values()];
}

export function assistantRouteExpression(dnis = []) {
  return dnis
    .map((value) => `Call.CalledAddressOriginal == ${JSON.stringify(value)}`)
    .join(" or ");
}

function required(name, fallback) {
  const value = String(process.env[name] || fallback || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function websocketBaseUri() {
  return genesysAudioConnectorBaseUri();
}

async function findAudioConnectorIntegration(integrationsApi, integrationId) {
  if (!integrationId) throw new Error("--integration-id is required");
  const integration = await integrationsApi.getIntegration(integrationId);
  if (integration.integrationType?.id !== AUDIO_CONNECTOR_TYPE) {
    throw new Error(`Integration ${integrationId} is not an Audio Connector`);
  }
  return integration;
}

async function configureAudioConnector(integrationsApi, integration) {
  const baseUri = websocketBaseUri();
  const apiKey = required("GC_AUDIO_CONNECTOR_API_KEY");
  const clientSecret = required("GC_AUDIO_CONNECTOR_CLIENT_SECRET");
  const current = await integrationsApi.getIntegrationConfigCurrent(integration.id);
  const existingCredential = current.credentials?.audioHook;
  const credentialBody = {
    id: existingCredential?.id,
    name: existingCredential?.name || `${integration.name} AudioHook`,
    type: { name: "audioHook" },
    credentialFields: { apiKey, clientSecret },
  };
  const credential = existingCredential?.id
    ? await integrationsApi.putIntegrationsCredential(existingCredential.id, {
        body: credentialBody,
      })
    : await integrationsApi.postIntegrationsCredentials({ body: credentialBody });

  const config = await integrationsApi.putIntegrationConfigCurrent(integration.id, {
    body: {
      id: current.id || "current",
      name: integration.name,
      version: current.version || 1,
      properties: { ...(current.properties || {}), baseUri },
      advanced: current.advanced || {},
      notes: current.notes || "Telnyx AI Assistant over Genesys Audio Connector",
      credentials: {
        ...(current.credentials || {}),
        audioHook: {
          id: credential.id,
          name: credential.name,
          type: credential.type,
        },
      },
    },
  });
  await integrationsApi.patchIntegration(integration.id, {
    body: { intendedState: "ENABLED" },
  });
  return {
    baseUri: config.properties?.baseUri || baseUri,
    credentialId: config.credentials?.audioHook?.id || credential.id,
    intendedState: "ENABLED",
  };
}

function architectLocation(environment) {
  const locations = {
    "mypurecloud.com": "prod_us_east_1",
    "use2.us-gov-pure.cloud": "prod_us_east_1",
    "use2.pure.cloud": "prod_us_east_2",
    "usw2.pure.cloud": "prod_us_west_2",
    "mypurecloud.ie": "prod_eu_west_1",
    "euw1.pure.cloud": "prod_eu_west_1",
    "euw2.pure.cloud": "prod_eu_west_2",
    "mypurecloud.de": "prod_eu_central_1",
    "euc1.pure.cloud": "prod_eu_central_1",
    "euc2.pure.cloud": "prod_eu_central_2",
    "mypurecloud.jp": "prod_ap_northeast_1",
    "apne1.pure.cloud": "prod_ap_northeast_1",
    "apne2.pure.cloud": "prod_ap_northeast_2",
    "apne3.pure.cloud": "prod_ap_northeast_3",
    "aps1.pure.cloud": "prod_ap_south_1",
    "apse1.pure.cloud": "prod_ap_southeast_1",
    "mypurecloud.com.au": "prod_ap_southeast_2",
    "apse2.pure.cloud": "prod_ap_southeast_2",
    "mypurecloud.ca": "prod_ca_central_1",
    "cac1.pure.cloud": "prod_ca_central_1",
    "mypurecloud.com.br": "prod_sa_east_1",
    "sae1.pure.cloud": "prod_sa_east_1",
    "mec1.pure.cloud": "prod_me_central_1",
    "mxc1.pure.cloud": "prod_mx_central_1",
  };
  const normalized = String(environment || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const location = locations[normalized];
  if (!location) throw new Error(`Unsupported Genesys Architect environment: ${environment}`);
  return location;
}

function getOrAddFlowVariable(flow, name, dataTypeName, description) {
  const existing = flow.getVariableByName(`Flow.${name}`);
  if (existing) return existing;
  const dataType = flow.dataTypes[dataTypeName];
  if (!dataType) throw new Error(`Architect data type ${dataTypeName} is unavailable`);
  return flow.addVariable(name, dataType, description);
}

function participantAttribute(action, name, valueExpression) {
  action.addAttributeNameValuePair(JSON.stringify(name), valueExpression);
}

function setScriptInput(action, name, { variable, literal } = {}) {
  const input = action.scriptInputs?.getNamedValueByName(name);
  if (!input?.value) throw new Error(`Screen Pop script input ${name} is unavailable`);
  if (variable) {
    input.value.setExpressionFromVariable(variable);
  } else {
    input.value.setLiteralString(String(literal || ""));
  }
}

async function configureFlow(
  scripting,
  flow,
  { integrationId, connectorId, handoffScriptId, assistantRoutes = [], outboundAssistantId = null, contactListId = null, wrapupCodeId = null }
) {
  const routingTask =
    flow.startUpObject ||
    scripting.factories.archFactoryTasks.addTask(flow, "Route Telnyx assistant by DNIS", true);
  routingTask.name = "Route Telnyx assistant by DNIS";
  for (const action of [...routingTask.actions].reverse()) routingTask.deleteAction(action);

  let assistantTask = flow.tasksReusable.find(
    (candidate) => candidate.name === TELNYX_ASSISTANT_TASK_NAME
  );
  if (!assistantTask) {
    assistantTask = scripting.factories.archFactoryTasks.addTask(
      flow,
      TELNYX_ASSISTANT_TASK_NAME,
      false
    );
  }
  for (const action of [...assistantTask.actions].reverse()) assistantTask.deleteAction(action);

  flow.description =
    "Runs the Telnyx AI assistant over Genesys Audio Connector and dynamically transfers requested handoffs";
  flow.settingsErrorHandling.handling =
    scripting.enums.archEnums.EVENTS_FLOW_ERROR_HANDLING.disconnect;
  if (outboundAssistantId) {
    if (!contactListId || !wrapupCodeId) {
      throw new Error("Outbound callback flow requires a Contact List and default wrap-up code");
    }
    await flow.settingsOutboundCall.setContactListLiteralByContactListIdAsync(contactListId);
    await flow.settingsOutboundCall.defaultWrapupCode.setLiteralByWrapupCodeIdAsync(wrapupCodeId);
  }

  const routeToHuman = getOrAddFlowVariable(
    flow,
    "RouteToHuman",
    "string",
    "Set to true by the Telnyx AudioHook runtime when a human handoff was requested"
  );
  const queueId = getOrAddFlowVariable(flow, "QueueId", "string", "Validated Genesys queue ID");
  const queueName = getOrAddFlowVariable(flow, "QueueName", "string", "Validated Genesys queue name");
  const targetQueue = getOrAddFlowVariable(flow, "TargetQueue", "queue", "Resolved transfer queue");
  const handoffId = getOrAddFlowVariable(
    flow,
    "HandoffId",
    "string",
    "Audio Connector handoff correlation ID"
  );
  const handoffReason = getOrAddFlowVariable(flow, "HandoffReason", "string", "Reason for escalation");
  const summary = getOrAddFlowVariable(flow, "Summary", "string", "AI conversation summary for the agent");
  const intent = getOrAddFlowVariable(flow, "Intent", "string", "Detected customer intent");
  const sentiment = getOrAddFlowVariable(flow, "Sentiment", "string", "Detected customer sentiment");
  const telnyxConversationId = getOrAddFlowVariable(
    flow,
    "TelnyxConversationId",
    "string",
    "Telnyx realtime conversation ID"
  );
  const telnyxAiTranscript = getOrAddFlowVariable(
    flow,
    "TelnyxAiTranscript",
    "string",
    "Bounded speaker-labelled Telnyx AI transcript"
  );
  const telnyxAssistantId = getOrAddFlowVariable(
    flow,
    "TelnyxAssistantId",
    "string",
    "Telnyx AI assistant ID selected from the original called number (DNIS)"
  );
  const audioConnectorErrorType = getOrAddFlowVariable(
    flow,
    "AudioConnectorErrorType",
    "string",
    "Genesys Audio Connector failure type"
  );
  const audioConnectorErrorMessage = getOrAddFlowVariable(
    flow,
    "AudioConnectorErrorMessage",
    "string",
    "Genesys Audio Connector failure message"
  );

  const actions = scripting.factories.archFactoryActions;
  if (outboundAssistantId) {
    const selectAssistant = actions.addActionUpdateData(routingTask, "Select callback AI assistant");
    selectAssistant.addUpdateDataStatement(
      flow.dataTypes.string,
      telnyxAssistantId,
      JSON.stringify(outboundAssistantId)
    );
    const callAssistantTask = actions.addActionCallTask(
      routingTask,
      "Run callback AI assistant",
      assistantTask,
      selectAssistant
    );
    actions.addActionDisconnect(callAssistantTask.outputDefault, "Disconnect after callback AI assistant");
  } else {
    const groupedRoutes = groupAssistantRoutes(assistantRoutes);
    const dnisSwitch = actions.addActionSwitch(
      routingTask,
      "Select Telnyx assistant by original DNIS"
    );
    dnisSwitch.setFirstTrueSwitch();
    while (dnisSwitch.caseCount < groupedRoutes.length) dnisSwitch.addCase();
    while (dnisSwitch.caseCount > groupedRoutes.length) {
      dnisSwitch.deleteCaseByIndex(dnisSwitch.caseCount - 1);
    }

    groupedRoutes.forEach(({ assistantId, dnis }, index) => {
      dnisSwitch.getCaseValue(index).setExpression(assistantRouteExpression(dnis));
      const caseOutput = dnisSwitch.getOutputByIndex(index);
      if (!caseOutput) {
        throw new Error(`Architect did not create a switch output for assistant ${assistantId}`);
      }
      const selectAssistant = actions.addActionUpdateData(
        caseOutput,
        `Select assistant for ${dnis.join(", ")}`
      );
      selectAssistant.addUpdateDataStatement(
        flow.dataTypes.string,
        telnyxAssistantId,
        JSON.stringify(assistantId)
      );
      const callAssistantTask = actions.addActionCallTask(
        caseOutput,
        `Run Telnyx assistant for ${dnis.join(", ")}`,
        assistantTask,
        selectAssistant
      );
      actions.addActionDisconnect(
        callAssistantTask.outputDefault,
        `Disconnect after assistant task for ${dnis.join(", ")}`
      );
    });

    const unconfiguredDnis = actions.addActionSetParticipantData(
      dnisSwitch.outputDefault,
      "Record unconfigured DNIS"
    );
    participantAttribute(unconfiguredDnis, "telnyx_ai_error_type", '"NoAssistantConfiguredForDnis"');
    participantAttribute(
      unconfiguredDnis,
      "telnyx_ai_error_message",
      'Append("No Telnyx assistant configured for DNIS ", Call.CalledAddressOriginal)'
    );
    participantAttribute(unconfiguredDnis, "telnyx_ai_dnis", "Call.CalledAddressOriginal");
    actions.addActionDisconnect(dnisSwitch.outputDefault, "Disconnect unconfigured DNIS", unconfiguredDnis);
  }

  const connector = actions.addActionCallAudioConnector(
    assistantTask,
    "Call dynamically selected Telnyx AI assistant"
  );
  await connector.setAudioConnectorByIdAsync(integrationId);
  connector.connectorId.setLiteralString(connectorId);
  connector.addSessionVariableNameValuePair(
    "assistantId",
    "Flow.TelnyxAssistantId"
  );
  if (outboundAssistantId) {
    connector.addSessionVariableNameValuePair("telnyxCallDirection", '"outbound"');
    for (const column of [
      "first_name", "last_name", "email", "topic_key", "topic_label", "description",
      "callback_mode", "callback_at_utc", "callback_timezone", "customer_locale",
      "callback_request_id", "widget_id", "consent_phone", "consent_sms", "consent_email",
      "consent_text", "consent_timestamp_utc", "consent_policy_version", "created_at_utc",
    ]) {
      connector.addSessionVariableNameValuePair(`telnyxVar_${column}`, `Call.Contact.${column}`);
    }
  } else {
    for (const example of GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES) {
      connector.addSessionVariableNameValuePair(example.architectName, JSON.stringify(example.value));
    }
  }

  connector.audioConnectorOutputsFailure
    .getNamedValueByName("errorType")
    .value.setVariable(audioConnectorErrorType);
  connector.audioConnectorOutputsFailure
    .getNamedValueByName("errorMessage")
    .value.setVariable(audioConnectorErrorMessage);

  const outputs = [
    ["routeToHuman", routeToHuman],
    ["queueId", queueId],
    ["queueName", queueName],
    ["handoffId", handoffId],
    ["handoffReason", handoffReason],
    ["summary", summary],
    ["intent", intent],
    ["sentiment", sentiment],
    ["telnyxConversationId", telnyxConversationId],
    ["telnyxAiTranscript", telnyxAiTranscript],
  ];
  for (const [name, variable] of outputs) {
    connector.addSessionVariableOutputNameValuePair(name, variable);
  }

  const decision = actions.addActionDecision(
    connector.outputSuccess,
    "Did Telnyx request a human handoff?",
    'Flow.RouteToHuman == "true"'
  );

  const setContext = actions.addActionSetParticipantData(
    decision.outputYes,
    "Persist Telnyx AI context for the Genesys agent"
  );
  participantAttribute(setContext, "telnyx_ai_handoff_id", "Flow.HandoffId");
  participantAttribute(setContext, "telnyx_ai_queue_id", "Flow.QueueId");
  participantAttribute(setContext, "telnyx_ai_queue_name", "Flow.QueueName");
  participantAttribute(setContext, "telnyx_ai_handoff_reason", "Flow.HandoffReason");
  participantAttribute(setContext, "telnyx_ai_summary", "Flow.Summary");
  participantAttribute(setContext, "telnyx_ai_intent", "Flow.Intent");
  participantAttribute(setContext, "telnyx_ai_sentiment", "Flow.Sentiment");
  participantAttribute(setContext, "telnyx_conversation_id", "Flow.TelnyxConversationId");
  participantAttribute(setContext, "telnyx_ai_transcript", "Flow.TelnyxAiTranscript");
  participantAttribute(setContext, "telnyx_ai_assistant_id", "Flow.TelnyxAssistantId");
  participantAttribute(setContext, "telnyx_ai_dnis", "Call.CalledAddressOriginal");

  const findQueue = actions.addActionFindQueueById(
    decision.outputYes,
    "Resolve queue validated by the handoff service",
    setContext
  );
  findQueue.findId.setExpressionFromVariable(queueId);
  findQueue.findResult.setVariable(targetQueue);

  const screenPop = actions.addActionSetScreenPop(
    findQueue.outputFound,
    "Show Telnyx AI handoff summary"
  );
  await screenPop.setScriptByIdAsync(handoffScriptId);
  setScriptInput(screenPop, "Summary", { variable: summary });
  setScriptInput(screenPop, "Intent", { variable: intent });
  setScriptInput(screenPop, "Sentiment", { variable: sentiment });
  setScriptInput(screenPop, "HandoffReason", { variable: handoffReason });
  setScriptInput(screenPop, "QueueName", { variable: queueName });
  setScriptInput(screenPop, "Channel", { literal: "voice" });
  setScriptInput(screenPop, "TelnyxConversationId", {
    variable: telnyxConversationId,
  });

  const transfer = actions.addActionTransferToAcd(
    findQueue.outputFound,
    "Transfer to dynamically selected Genesys queue",
    undefined,
    screenPop
  );
  transfer.targetQueue.setExpressionFromVariable(targetQueue);
  transfer.priority.setLiteralInt(0);
  transfer.preTransferAudio.setDefaultCaseExpression("ToAudioBlank(100)");
  transfer.failureTransferAudio.setDefaultCaseExpression("ToAudioBlank(100)");

  actions.addActionDisconnect(decision.outputNo, "AI session completed without handoff");
  actions.addActionDisconnect(findQueue.outputNotFound, "Validated queue no longer exists");
  const setFailureContext = actions.addActionSetParticipantData(
    connector.outputFailure,
    "Persist Audio Connector error"
  );
  participantAttribute(
    setFailureContext,
    "telnyx_ai_assistant_id",
    "Flow.TelnyxAssistantId"
  );
  participantAttribute(setFailureContext, "telnyx_ai_dnis", "Call.CalledAddressOriginal");
  participantAttribute(
    setFailureContext,
    "telnyx_ai_error_type",
    "Flow.AudioConnectorErrorType"
  );
  participantAttribute(
    setFailureContext,
    "telnyx_ai_error_message",
    "Flow.AudioConnectorErrorMessage"
  );
  actions.addActionDisconnect(
    connector.outputFailure,
    "Audio Connector failed",
    setFailureContext
  );
  actions.addActionDisconnect(transfer.outputFailure, "Transfer to ACD failed");
}

export async function publishArchitectFlow({ environment, accessToken, existingFlow, integrationId, connectorId, handoffScriptId, flowName, assistantRoutes = [], outboundAssistantId = null, contactListId = null, wrapupCodeId = null }) {
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  let result;
  let callbackError;

  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.debug = () => {};

  try {
    const scriptingModule = await import("purecloud-flow-scripting-api-sdk-javascript");
    const scripting = scriptingModule.default || scriptingModule;
    const session = scripting.environment.archSession;
    session.endTerminatesProcess = false;
    session.endExitCode = 0;

    await session.startWithAuthToken(
      scripting.enums.archEnums.LOCATIONS[architectLocation(environment)],
      async () => {
        try {
          const flowType = outboundAssistantId
            ? scripting.enums.archEnums.FLOW_TYPES.outboundCall
            : scripting.enums.archEnums.FLOW_TYPES.inboundCall;
          const flow = existingFlow
            ? await scripting.factories.archFactoryFlows.checkoutAndLoadFlowByFlowNameAsync(
                flowName,
                flowType,
                false,
                "latest"
              )
            : outboundAssistantId
              ? await scripting.factories.archFactoryFlows.createFlowOutboundCallAsync(
                  flowName,
                  "Telnyx AI callback assistant through Genesys Audio Connector"
                )
              : await scripting.factories.archFactoryFlows.createFlowInboundCallAsync(
                  flowName,
                  "Telnyx AI voice assistant through Genesys Audio Connector"
                );
          await configureFlow(scripting, flow, {
            integrationId,
            connectorId,
            handoffScriptId,
            assistantRoutes,
            outboundAssistantId,
            contactListId,
            wrapupCodeId,
          });
          const validation = await flow.validateAsync();
          if (validation.hasErrors) {
            throw new Error(`Architect validation failed: ${validation.getSummaryStr(true)}`);
          }
          await flow.publishAsync(true);
          result = { id: flow.id, name: flow.name };
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
      accessToken,
      undefined,
      true,
      {
        cacheEnabled: false,
        captureNetworkDiagnosticsOnFailure: false,
        logNetworkDiagnosticsOnFailure: false,
      }
    );

    if (callbackError) throw callbackError;
    if (session.endExitCode !== 0) {
      throw new Error(`Architect scripting session failed with exit code ${session.endExitCode}`);
    }
    if (!result?.id) throw new Error("Architect flow was not published");
    return result;
  } finally {
    Object.assign(console, originalConsole);
  }
}

async function provision({ configureOnly = false, skipConnector = false, skipFlow = false, skipCallRoute = false, integrationId, assistantId, assistantRoutes, flowName, scriptName, dnis, callRouteId, callRouteName, callRouteTakeovers = [], callRouteOwnerTakeovers = [], deploymentId } = {}) {
  const environment = required("GC_ENVIRONMENT");
  const targetFlowName = String(flowName || GENESYS_AUDIO_FLOW_NAME).trim();
  if (!targetFlowName) throw new Error("--flow-name cannot be empty");
  const connectorId = GENESYS_AUDIO_CONNECTOR_ID;
  const dnisValues = genesysAudioDnisValues(dnis || []);
  const routes = configureOnly
    ? []
    : normalizeAssistantRoutes(
        assistantRoutes?.length
          ? assistantRoutes
          : dnisValues.map((value) => ({ dnis: value, assistantId }))
      );
  const apiClient = platformClient.ApiClient.instance;
  apiClient.setEnvironment(environment);
  const authData = await apiClient.loginClientCredentialsGrant(
    required("GC_CLIENT_CRED_CLIENT_ID"),
    required("GC_CLIENT_CRED_CLIENT_SECRET")
  );
  const accessToken = authData?.accessToken || apiClient.authData?.accessToken;
  if (!accessToken) throw new Error("Genesys access token was not returned");

  const integrationsApi = new platformClient.IntegrationsApi();
  const integration = await findAudioConnectorIntegration(integrationsApi, integrationId);
  const connectorConfig = skipConnector
    ? null
    : await configureAudioConnector(integrationsApi, integration);

  if (configureOnly) {
    return { integration, connectorId, connectorConfig };
  }

  if (skipFlow && skipCallRoute) {
    return {
      published: null,
      integration,
      connectorId,
      connectorConfig,
      handoffScript: null,
      configuredDnis: routes.map(({ dnis: value }) => value),
      assistantRoutes: routes,
      callRoute: null,
      callRouteTakeovers: [],
    };
  }

  const architectApi = new platformClient.ArchitectApi();
  const telephonyApi = new platformClient.TelephonyProvidersEdgeApi();
  const usersApi = new platformClient.UsersApi();
  const flows = await architectApi.getFlows({
    type: ["INBOUNDCALL"],
    name: targetFlowName,
    pageSize: 100,
  });
  const existingFlow = (flows.entities || []).find(
    (flow) => flow.name === targetFlowName
  );
  let handoffScript = null;
  let published = existingFlow || null;
  if (!skipFlow) {
    const scriptsApi = new platformClient.ScriptsApi();
    const handoffScriptName = String(scriptName || GENESYS_AUDIO_HANDOFF_SCRIPT_NAME).trim();
    if (!handoffScriptName) throw new Error("--script-name cannot be empty");
    const scripts = await scriptsApi.getScriptsPublished({
      pageSize: 100,
      pageNumber: 1,
      name: handoffScriptName,
    });
    handoffScript = (scripts.entities || []).find(
      (script) => script.name === handoffScriptName
    );
    if (!handoffScript?.id) {
      throw new Error(`Published Genesys script ${handoffScriptName} was not found`);
    }
    published = await publishArchitectFlow({
      environment,
      accessToken,
      existingFlow,
      integrationId: integration.id,
      connectorId,
      handoffScriptId: handoffScript.id,
      flowName: targetFlowName,
      assistantRoutes: routes,
    });
  }
  if (!skipCallRoute && !published?.id) {
    throw new Error(`Existing Architect flow ${targetFlowName} was not found for call-route reconciliation`);
  }
  const callRoute = !skipCallRoute && callRouteName
      ? await ensureAudioCallRoute({
        architectApi,
        telephonyApi,
        usersApi,
        ivrId: callRouteId || null,
        name: callRouteName,
        dnis: routes.map(({ dnis: value }) => value),
        flow: { ...published, name: published.name || targetFlowName },
        deploymentId,
        takeovers: callRouteTakeovers,
        ownerTakeovers: callRouteOwnerTakeovers,
      })
    : null;
  return {
    published,
    integration,
    connectorId,
    connectorConfig,
    handoffScript,
    configuredDnis: routes.map(({ dnis: value }) => value),
    assistantRoutes: routes,
    callRoute: callRoute?.route || null,
    callRouteTakeovers: callRoute?.takeovers || [],
  };
}

const args = new Set(process.argv.slice(2));
function cliOption(name) {
  const argv = process.argv.slice(2);
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? String(argv[index + 1] || "").trim() : "";
}
function cliJsonOption(name, fallback = []) {
  const value = cliOption(name);
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`--${name} must contain valid JSON`);
  }
}
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url) && (args.has("--help") || !args.has("--apply"))) {
  console.log(
    "Usage: node --env-file=.env scripts/provision-genesys-audio-connector-flow.mjs --apply --integration-id=<id> --assistant-routes-json=<json> --flow-name=<name> [--script-name=<name>] [--configure-only] [--skip-connector] [--skip-flow] [--skip-call-route]\n" +
      "Selectively configures the Audio Connector, Architect flow, and inbound call route."
  );
  process.exit(args.has("--help") ? 0 : 2);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
const result = await provision({
  configureOnly: args.has("--configure-only"),
  skipConnector: args.has("--skip-connector"),
  skipFlow: args.has("--skip-flow"),
  skipCallRoute: args.has("--skip-call-route"),
  integrationId: cliOption("integration-id"),
  assistantId: cliOption("assistant-id"),
  assistantRoutes: cliJsonOption("assistant-routes-json"),
  flowName: cliOption("flow-name") || GENESYS_AUDIO_FLOW_NAME,
  scriptName: cliOption("script-name") || GENESYS_AUDIO_HANDOFF_SCRIPT_NAME,
  dnis: cliJsonOption("dnis-json"),
  callRouteId: cliOption("call-route-id"),
  callRouteName: cliOption("call-route-name"),
  callRouteTakeovers: cliJsonOption("call-route-takeovers-json"),
  callRouteOwnerTakeovers: cliJsonOption("call-route-owner-takeovers-json"),
  deploymentId: cliOption("deployment-id"),
});
console.log(
  JSON.stringify(
    {
      flow: result.published || null,
      handoffScript: result.handoffScript
        ? { id: result.handoffScript.id, name: result.handoffScript.name }
        : null,
      audioConnectorIntegration: {
        id: result.integration.id,
        name: result.integration.name,
        connectorId: result.connectorId,
        baseUri: result.connectorConfig?.baseUri || null,
        credentialConfigured: Boolean(result.connectorConfig?.credentialId),
      },
      publicWebSocketPath: "/api/genesys/audio-connector/ws",
      configuredDnis: result.configuredDnis || [],
      assistantRoutes: result.assistantRoutes || [],
      callRoute: result.callRoute ? { id: result.callRoute.id, name: result.callRoute.name, dnis: result.callRoute.dnis || [] } : null,
      callRouteTakeovers: result.callRouteTakeovers || [],
      exampleDynamicVariables: GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES,
    },
    null,
    2
  )
);
process.exit(0);
}
