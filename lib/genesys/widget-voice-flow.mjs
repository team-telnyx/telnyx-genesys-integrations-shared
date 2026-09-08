const QUEUE_HEADER_NAME = "X-TGX-Queue-Name";
const HANDOFF_HEADER_NAMES = Object.freeze([
  QUEUE_HEADER_NAME,
  "X-TGX-Call-Control-Id",
  "X-TGX-Widget-Session-Id",
  "X-TGX-Handoff-Reason",
  "X-TGX-Summary",
  "X-TGX-Intent",
  "X-TGX-Sentiment",
]);

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
  const key = String(environment || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!locations[key]) throw new Error(`Unsupported Genesys Architect environment: ${environment}`);
  return locations[key];
}

function getOrAddFlowVariable(flow, name, dataTypeName, description) {
  const existing = flow.getVariableByName(`Flow.${name}`);
  if (existing) return existing;
  return flow.addVariable(name, flow.dataTypes[dataTypeName], description);
}

function participantAttribute(action, name, valueExpression) {
  action.addAttributeNameValuePair(JSON.stringify(name), valueExpression);
}

function setScriptInput(action, name, { variable, literal } = {}) {
  const input = action.scriptInputs?.getNamedValueByName(name);
  if (!input?.value) throw new Error(`Screen Pop script input ${name} is unavailable`);
  if (variable) input.value.setExpressionFromVariable(variable);
  else input.value.setLiteralString(String(literal || ""));
}

export function widgetVoiceQueueNameExpression(queues) {
  const names = [...new Set(
    (Array.isArray(queues) ? queues : [])
      .map((queue) => String(queue?.name || "").trim())
      .filter(Boolean)
  )].sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (!names.length) throw new Error("At least one Genesys queue is required for the voice flow");

  return names.reduceRight((fallback, name) => {
    return `If(Lower(Trim(Flow.TelnyxRequestedQueueName)) == ${JSON.stringify(name.toLowerCase())}, ${JSON.stringify(name)}, ${fallback})`;
  }, '""');
}

export function widgetVoiceHeaderValueExpression(headerName) {
  const name = String(headerName || "").trim();
  if (!name) throw new Error("SIP header name is required");
  // Architect normalizes SIP header names to lowercase. Every property is a
  // JSON array, so convert it explicitly before reading its first item. Direct
  // indexing of the JSON value validates at design time but fails at runtime.
  const headers = widgetVoiceHeaderDataExpression();
  const normalizedName = name.toLowerCase();
  const property = `GetJsonObjectProperty(${headers}, ${JSON.stringify(normalizedName)})`;
  const values = `ToJsonCollection(${property})`;
  return `If(FindFirst(GetJsonObjectPropertyNames(${headers}), ${JSON.stringify(normalizedName)}) >= 0, ToString(${values}[0]), "")`;
}

export function widgetVoiceHeaderDataExpression() {
  // The action output is already the JSON object containing lowercase header
  // names. Execution Replay displays it under a `value.data` serialization
  // envelope, but `data` is not a property of the Architect JSON value.
  return "Flow.TelnyxSipHeadersResult";
}

export async function configureWidgetVoiceFlow(scripting, flow, queues, { handoffScriptId } = {}) {
  if (!queues?.length) throw new Error("At least one Genesys queue is required for the voice flow");
  const task = flow.startUpObject ||
    scripting.factories.archFactoryTasks.addTask(flow, "Route Telnyx Widget voice handoff", true);
  task.name = "Route Telnyx Widget voice handoff";
  for (const action of [...task.actions].reverse()) task.deleteAction(action);
  flow.description =
    `Managed by genesys:widget; resolves ${QUEUE_HEADER_NAME} against the deployment queue-name allowlist`;

  const legacyRawHeaders = flow.getVariableByName("Flow.TelnyxSipHeaders");
  if (legacyRawHeaders?.canDelete) flow.removeVariable(legacyRawHeaders);
  const sipHeadersResult = getOrAddFlowVariable(
    flow,
    "TelnyxSipHeadersResult",
    "json",
    "Named Telnyx SIP headers retrieved from the initial INVITE"
  );
  const obsoleteSipHeaderData = flow.getVariableByName("Flow.TelnyxSipHeaderData");
  if (obsoleteSipHeaderData?.canDelete) flow.removeVariable(obsoleteSipHeaderData);
  const requestedQueueName = getOrAddFlowVariable(
    flow,
    "TelnyxRequestedQueueName",
    "string",
    "Genesys queue name received from the Telnyx SIP header"
  );
  const canonicalQueueName = getOrAddFlowVariable(
    flow,
    "TelnyxCanonicalQueueName",
    "string",
    "Canonical Genesys queue name selected from the deployment allowlist"
  );
  const targetQueue = getOrAddFlowVariable(
    flow,
    "TelnyxTargetQueue",
    "queue",
    "Genesys queue resolved dynamically from the validated SIP header"
  );
  const callControlId = getOrAddFlowVariable(
    flow,
    "TelnyxCallControlId",
    "string",
    "Telnyx Call Control ID used to retrieve the complete AI conversation"
  );
  const widgetSessionId = getOrAddFlowVariable(
    flow,
    "TelnyxWidgetSessionId",
    "string",
    "Private WebRTC widget session ID used to correlate Genesys notifications"
  );
  const handoffReason = getOrAddFlowVariable(flow, "TelnyxHandoffReason", "string", "Reason for human handoff");
  const summary = getOrAddFlowVariable(flow, "TelnyxHandoffSummary", "string", "Concise AI conversation summary");
  const intent = getOrAddFlowVariable(flow, "TelnyxHandoffIntent", "string", "Detected customer intent");
  const sentiment = getOrAddFlowVariable(flow, "TelnyxHandoffSentiment", "string", "Detected customer sentiment");
  const actions = scripting.factories.archFactoryActions;
  const readHeaders = actions.addActionGetSIPHeaders(
    task,
    "Read named Telnyx handoff headers from the initial SIP INVITE"
  );
  readHeaders.sipHeaderNames.setLiteralEmptyCollection();
  for (const headerName of HANDOFF_HEADER_NAMES) {
    readHeaders.sipHeaderNames.addItemToCollection().setLiteralString(headerName);
  }
  readHeaders.setInputDataVariable(sipHeadersResult);

  const parseHeaders = actions.addActionUpdateData(
    readHeaders.outputSuccess,
    "Read Telnyx handoff values from SIP headers"
  );
  for (const [variable, header] of [
    [requestedQueueName, QUEUE_HEADER_NAME],
    [callControlId, "X-TGX-Call-Control-Id"],
    [widgetSessionId, "X-TGX-Widget-Session-Id"],
    [handoffReason, "X-TGX-Handoff-Reason"],
    [summary, "X-TGX-Summary"],
    [intent, "X-TGX-Intent"],
    [sentiment, "X-TGX-Sentiment"],
  ]) {
    parseHeaders.addUpdateDataStatement(
      flow.dataTypes.string,
      variable,
      widgetVoiceHeaderValueExpression(header)
    );
  }
  const selectQueueName = actions.addActionUpdateData(
    readHeaders.outputSuccess,
    "Validate the requested queue against the deployment allowlist",
    parseHeaders
  );
  selectQueueName.addUpdateDataStatement(
    flow.dataTypes.string,
    canonicalQueueName,
    widgetVoiceQueueNameExpression(queues)
  );
  const allowedQueue = actions.addActionDecision(
    readHeaders.outputSuccess,
    "Was an allowed Genesys queue requested?",
    "IsNotSetOrEmpty(Flow.TelnyxCanonicalQueueName) == false",
    selectQueueName
  );
  const findQueue = actions.addActionFindQueue(
    allowedQueue.outputYes,
    "Find the requested Genesys queue by name"
  );
  findQueue.findName.setExpressionFromVariable(canonicalQueueName);
  findQueue.findResult.setVariable(targetQueue);
  const setContext = actions.addActionSetParticipantData(
    findQueue.outputFound,
    "Persist Telnyx SIP handoff context for the Genesys agent"
  );
  participantAttribute(setContext, "telnyx_ai_queue_id", "Flow.TelnyxTargetQueue.id");
  participantAttribute(setContext, "telnyx_ai_queue_name", "Flow.TelnyxCanonicalQueueName");
  participantAttribute(setContext, "telnyx_conversation_channel", '"phone_call"');
  participantAttribute(setContext, "telnyx_call_control_id", "Flow.TelnyxCallControlId");
  participantAttribute(setContext, "telnyx_widget_session_id", "Flow.TelnyxWidgetSessionId");
  participantAttribute(setContext, "telnyx_ai_handoff_reason", "Flow.TelnyxHandoffReason");
  participantAttribute(setContext, "telnyx_ai_summary", "Flow.TelnyxHandoffSummary");
  participantAttribute(setContext, "telnyx_ai_intent", "Flow.TelnyxHandoffIntent");
  participantAttribute(setContext, "telnyx_ai_sentiment", "Flow.TelnyxHandoffSentiment");
  participantAttribute(setContext, "telnyx_ai_dnis", "Call.CalledAddressOriginal");

  let previousAction = setContext;
  if (handoffScriptId) {
    const screenPop = actions.addActionSetScreenPop(
      findQueue.outputFound,
      "Show Telnyx AI handoff summary",
      setContext
    );
    await screenPop.setScriptByIdAsync(handoffScriptId);
    setScriptInput(screenPop, "Summary", { variable: summary });
    setScriptInput(screenPop, "Intent", { variable: intent });
    setScriptInput(screenPop, "Sentiment", { variable: sentiment });
    setScriptInput(screenPop, "HandoffReason", { variable: handoffReason });
    setScriptInput(screenPop, "QueueName", { variable: canonicalQueueName });
    setScriptInput(screenPop, "Channel", { literal: "voice" });
    setScriptInput(screenPop, "TelnyxConversationId", { variable: callControlId });
    previousAction = screenPop;
  }
  const transfer = actions.addActionTransferToAcd(
    findQueue.outputFound,
    "Transfer voice call to the requested Genesys queue",
    undefined,
    previousAction
  );
  transfer.targetQueue.setExpressionFromVariable(targetQueue);
  transfer.priority.setLiteralInt(0);
  transfer.preTransferAudio.setDefaultCaseExpression("ToAudioBlank(100)");
  transfer.failureTransferAudio.setDefaultCaseExpression("ToAudioBlank(100)");
  actions.addActionDisconnect(
    transfer.outputFailure,
    "Transfer to the requested Genesys queue failed"
  );
  actions.addActionDisconnect(
    allowedQueue.outputNo,
    "Disconnect when the requested queue is outside the deployment allowlist"
  );
  actions.addActionDisconnect(
    findQueue.outputNotFound,
    "Disconnect when the allowed Genesys queue no longer exists"
  );
  actions.addActionDisconnect(readHeaders.outputFailure, "Reading SIP headers failed");
}

export async function publishWidgetVoiceFlow({
  environment,
  accessToken,
  flowName,
  queues,
  existingFlow = null,
  handoffScriptId = null,
}) {
  const originalConsole = { ...console };
  let result;
  let callbackError;
  for (const method of ["log", "info", "warn", "error", "debug"]) console[method] = () => {};
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
          const flow = existingFlow
            ? await scripting.factories.archFactoryFlows.checkoutAndLoadFlowByFlowNameAsync(
                flowName,
                scripting.enums.archEnums.FLOW_TYPES.inboundCall,
                false,
                "latest"
              )
            : await scripting.factories.archFactoryFlows.createFlowInboundCallAsync(
                flowName,
                "Managed Telnyx AI Widget voice handoff routing"
              );
          await configureWidgetVoiceFlow(scripting, flow, queues, { handoffScriptId });
          const validation = await flow.validateAsync();
          if (validation.hasErrors) {
            throw new Error(`Architect validation failed: ${validation.getSummaryStr(true)}`);
          }
          await flow.publishAsync(true);
          result = { id: flow.id, name: flow.name, type: "INBOUNDCALL" };
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
      accessToken,
      undefined,
      true,
      { cacheEnabled: false, captureNetworkDiagnosticsOnFailure: false, logNetworkDiagnosticsOnFailure: false }
    );
    if (callbackError) throw callbackError;
    if (session.endExitCode !== 0) {
      throw new Error(`Architect scripting session failed with exit code ${session.endExitCode}`);
    }
    if (!result?.id) throw new Error("Architect voice flow was not published");
    return result;
  } finally {
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      console[method] = originalConsole[method];
    }
  }
}

export { QUEUE_HEADER_NAME as WIDGET_VOICE_QUEUE_HEADER_NAME };
