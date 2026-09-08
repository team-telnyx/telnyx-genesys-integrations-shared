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

function unscopedVariableName(variable, fallback) {
  return String(variable?.name || fallback).replace(/^(?:flow|state|task)\./i, "");
}

function setScriptInput(action, name, { variable, literal } = {}) {
  const input = action.scriptInputs?.getNamedValueByName(name);
  if (!input?.value) throw new Error(`Screen Pop script input ${name} is unavailable`);
  if (variable) input.value.setExpressionFromVariable(variable);
  else input.value.setLiteralString(String(literal || ""));
}

function actionErrorDetail(error) {
  const body = error?.body || error?.response?.body;
  return String(
    body?.errors?.[0]?.detail ||
    body?.errors?.[0]?.message ||
    body?.message ||
    error?.message ||
    error
  );
}

const SCREEN_POP_SCRIPT_RETRY_DELAYS_MS = Object.freeze([0, 1_000, 1_500, 2_000, 3_000, 4_000, 5_000]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setScreenPopScriptWhenReady(action, scriptId, waitForRetry = wait) {
  let lastError;
  for (const delay of SCREEN_POP_SCRIPT_RETRY_DELAYS_MS) {
    if (delay) await waitForRetry(delay);
    try {
      await action.setScriptByIdAsync(scriptId);
      return;
    } catch (error) {
      lastError = error;
      if (!/(?:input validation|not found|screen pop script)/i.test(actionErrorDetail(error))) break;
    }
  }
  throw new Error(
    `Published Screen Pop script ${scriptId} is not yet available to Architect: ${actionErrorDetail(lastError)}`,
    { cause: lastError }
  );
}

export const WIDGET_MESSAGE_FLOW_AGENT_EXPERIENCE_MARKER = "agent-experience-v1";

export function widgetMessageFlowSupportsAgentExperience(flow) {
  return String(flow?.description || "").includes(WIDGET_MESSAGE_FLOW_AGENT_EXPERIENCE_MARKER);
}

export async function configureWidgetMessageFlow(
  scripting,
  flow,
  queues,
  { handoffScriptId, screenPopScriptWait } = {}
) {
  if (!queues?.length) throw new Error("At least one Genesys queue is required for the message flow");
  const task =
    flow.startUpObject ||
    scripting.factories.archFactoryTasks.addTask(flow, "Route Telnyx widget handoff", true);
  task.name = "Route Telnyx widget handoff";
  for (const action of [...task.actions].reverse()) task.deleteAction(action);

  flow.description =
    `Managed by genesys:widget; ${WIDGET_MESSAGE_FLOW_AGENT_EXPERIENCE_MARKER}; routes Telnyx AI messaging handoffs using the validated queue ID`;
  const variables = {
    queueId: getOrAddFlowVariable(flow, "TelnyxWidgetQueueId", "string", "Queue ID selected by the Telnyx AI assistant from the deployment allowlist"),
    queueName: getOrAddFlowVariable(flow, "TelnyxWidgetQueueName", "string", "Queue name selected by the Telnyx AI assistant"),
    conversationId: getOrAddFlowVariable(flow, "TelnyxConversationId", "string", "Telnyx AI conversation ID"),
    handoffReason: getOrAddFlowVariable(flow, "TelnyxHandoffReason", "string", "Reason for human handoff"),
    summary: getOrAddFlowVariable(flow, "TelnyxSummary", "string", "Concise AI conversation summary"),
    intent: getOrAddFlowVariable(flow, "TelnyxIntent", "string", "Detected customer intent"),
    sentiment: getOrAddFlowVariable(flow, "TelnyxSentiment", "string", "Detected customer sentiment"),
  };
  const queueId = variables.queueId;
  const queueVariableName = unscopedVariableName(queueId, "TelnyxWidgetQueueId");
  const actions = scripting.factories.archFactoryActions;
  const participantData = actions.addActionGetParticipantData(
    task,
    "Read the validated Telnyx handoff queue"
  );
  for (const [attribute, variable] of [
    ["telnyx_ai_queue_id", variables.queueId],
    ["telnyx_ai_queue_name", variables.queueName],
    ["telnyx_conversation_id", variables.conversationId],
    ["telnyx_ai_handoff_reason", variables.handoffReason],
    ["telnyx_ai_summary", variables.summary],
    ["telnyx_ai_intent", variables.intent],
    ["telnyx_ai_sentiment", variables.sentiment],
  ]) {
    participantData.addAttributeNameOutputValuePair(
      JSON.stringify(attribute),
      `flow.${unscopedVariableName(variable, attribute)}`
    );
  }
  const queueSwitch = actions.addActionSwitch(
    task,
    "Select the allowed Genesys queue",
    `Flow.${queueVariableName}`,
    queues.map((queue) => JSON.stringify(queue.id)),
    participantData
  );

  for (let index = 0; index < queues.length; index += 1) {
    const queue = queues[index];
    const output = queueSwitch.getOutputByIndex(index);
    if (!output) throw new Error(`Architect did not create a switch output for queue ${queue.name}`);
    let previousAction;
    if (handoffScriptId) {
      const screenPop = actions.addActionSetScreenPop(
        output,
        "Show Telnyx AI messaging handoff summary"
      );
      await setScreenPopScriptWhenReady(screenPop, handoffScriptId, screenPopScriptWait);
      setScriptInput(screenPop, "Summary", { variable: variables.summary });
      setScriptInput(screenPop, "Intent", { variable: variables.intent });
      setScriptInput(screenPop, "Sentiment", { variable: variables.sentiment });
      setScriptInput(screenPop, "HandoffReason", { variable: variables.handoffReason });
      setScriptInput(screenPop, "QueueName", { variable: variables.queueName });
      setScriptInput(screenPop, "Channel", { literal: "messaging" });
      setScriptInput(screenPop, "TelnyxConversationId", { variable: variables.conversationId });
      previousAction = screenPop;
    }
    const transfer = actions.addActionTransferToAcd(
      output,
      `Transfer message to ${queue.name}`,
      undefined,
      previousAction
    );
    await transfer.setLiteralByQueueIdAsync(queue.id);
    transfer.priority.setLiteralInt(0);
  }
  actions.addActionDisconnect(
    queueSwitch.outputDefault,
    "Disconnect when the requested queue is outside the deployment allowlist"
  );
}

export async function publishWidgetMessageFlow({
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
          let flow;
          try {
            flow = existingFlow
              ? await scripting.factories.archFactoryFlows.checkoutAndLoadFlowByFlowNameAsync(
                  flowName,
                  scripting.enums.archEnums.FLOW_TYPES.inboundShortMessage,
                  false,
                  "latest"
                )
              : await scripting.factories.archFactoryFlows.createFlowInboundShortMessageAsync(
                  flowName,
                  "Managed Telnyx AI widget handoff routing"
                );
          } catch (error) {
            throw new Error(
              `Architect flow ${existingFlow ? "checkout and load" : "creation"} failed: ${actionErrorDetail(error)}`,
              { cause: error }
            );
          }
          try {
            await configureWidgetMessageFlow(scripting, flow, queues, { handoffScriptId });
          } catch (error) {
            throw new Error(`Architect flow configuration failed: ${actionErrorDetail(error)}`, {
              cause: error,
            });
          }
          let validation;
          try {
            validation = await flow.validateAsync();
          } catch (error) {
            throw new Error(`Architect flow validation request failed: ${actionErrorDetail(error)}`, {
              cause: error,
            });
          }
          if (validation.hasErrors) {
            throw new Error(`Architect validation failed: ${validation.getSummaryStr(true)}`);
          }
          try {
            await flow.publishAsync(true);
          } catch (error) {
            throw new Error(`Architect flow publication failed: ${actionErrorDetail(error)}`, {
              cause: error,
            });
          }
          result = { id: flow.id, name: flow.name, type: "INBOUNDSHORTMESSAGE" };
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
    if (!result?.id) throw new Error("Architect message flow was not published");
    return result;
  } finally {
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      console[method] = originalConsole[method];
    }
  }
}
