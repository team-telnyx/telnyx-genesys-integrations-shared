export const TELNYX_DYNAMIC_VARIABLE_INPUT_PREFIX = "telnyxVar_";

const MAX_DYNAMIC_VARIABLES = 40;
const MAX_DYNAMIC_VARIABLE_NAME_LENGTH = 64;
const MAX_DYNAMIC_VARIABLE_VALUE_BYTES = 4 * 1024;
const MAX_SESSION_UPDATE_BYTES = 64 * 1024;
const DYNAMIC_VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

const GENESYS_CONTEXT_VARIABLES = Object.freeze([
  ["sessionId", "genesys_audiohook_session_id"],
  ["organizationId", "genesys_organization_id"],
  ["conversationId", "genesys_conversation_id"],
  ["participantId", "genesys_participant_id"],
  ["ani", "genesys_ani"],
  ["aniName", "genesys_ani_name"],
  ["dnis", "genesys_dnis"],
  ["direction", "genesys_direction"],
  ["language", "genesys_language"],
]);

export function normalizeGenesysTelephoneTarget(value) {
  if (typeof value !== "string") return value;
  return value.trim().replace(/^tel:/i, "");
}

function assertTelephoneTargetsHaveNoTelScheme(dynamicVariables) {
  for (const name of [
    "genesys_ani",
    "genesys_dnis",
    "telnyx_end_user_target",
    "telnyx_agent_target",
  ]) {
    const value = dynamicVariables[name];
    if (typeof value === "string" && /^tel:/i.test(value)) {
      throw new Error(`${name} must not contain the tel: URI scheme`);
    }
  }
}

function assertVariableName(name, sourceName, allowTelnyxSystemTarget = false) {
  if (
    !name ||
    name.length > MAX_DYNAMIC_VARIABLE_NAME_LENGTH ||
    !DYNAMIC_VARIABLE_NAME.test(name)
  ) {
    throw new Error(
      `AudioHook input variable ${sourceName} must map to a lower-case snake_case dynamic variable name`
    );
  }
  if (name.startsWith("telnyx_") && !allowTelnyxSystemTarget) {
    throw new Error(
      `AudioHook input variable ${sourceName} cannot use the reserved telnyx_ namespace`
    );
  }
}

function addVariable(
  target,
  name,
  value,
  sourceName,
  { allowTelnyxSystemTarget = false } = {}
) {
  if (value == null || value === "") return;
  if (typeof value !== "string") {
    throw new Error(`AudioHook input variable ${sourceName} must contain a string value`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_DYNAMIC_VARIABLE_VALUE_BYTES) {
    throw new Error(
      `AudioHook input variable ${sourceName} exceeds ${MAX_DYNAMIC_VARIABLE_VALUE_BYTES} bytes`
    );
  }
  assertVariableName(name, sourceName, allowTelnyxSystemTarget);
  if (Object.hasOwn(target, name)) {
    throw new Error(`AudioHook input variable ${sourceName} conflicts with ${name}`);
  }
  target[name] = value;
}

export function buildTelnyxSessionUpdate({ context = {}, inputVariables = {} } = {}) {
  const dynamicVariables = {};
  const suppliedDirection = String(context?.direction || inputVariables?.telnyxCallDirection || "").trim().toLowerCase();
  const direction = suppliedDirection || "inbound";
  const normalizedContext = {
    ...context,
    ani: normalizeGenesysTelephoneTarget(context?.ani),
    dnis: normalizeGenesysTelephoneTarget(context?.dnis),
    direction: suppliedDirection || null,
  };
  if (!["inbound", "outbound"].includes(direction)) {
    throw new Error("AudioHook call direction must be inbound or outbound");
  }

  for (const [contextKey, variableName, allowTelnyxSystemTarget] of GENESYS_CONTEXT_VARIABLES) {
    addVariable(dynamicVariables, variableName, normalizedContext?.[contextKey], contextKey, {
      allowTelnyxSystemTarget,
    });
  }

  const endUserTarget = direction === "outbound"
    ? normalizedContext.dnis
    : normalizedContext.ani;
  const agentTarget = direction === "outbound"
    ? normalizedContext.ani
    : normalizedContext.dnis;
  addVariable(dynamicVariables, "telnyx_end_user_target", endUserTarget, "endUserTarget", {
    allowTelnyxSystemTarget: true,
  });
  addVariable(dynamicVariables, "telnyx_agent_target", agentTarget, "agentTarget", {
    allowTelnyxSystemTarget: true,
  });

  if (
    inputVariables != null &&
    (typeof inputVariables !== "object" || Array.isArray(inputVariables))
  ) {
    throw new Error("AudioHook inputVariables must be an object");
  }

  for (const [sourceName, value] of Object.entries(inputVariables || {})) {
    if (!sourceName.startsWith(TELNYX_DYNAMIC_VARIABLE_INPUT_PREFIX)) continue;
    const variableName = sourceName.slice(TELNYX_DYNAMIC_VARIABLE_INPUT_PREFIX.length);
    addVariable(dynamicVariables, variableName, value, sourceName);
  }

  assertTelephoneTargetsHaveNoTelScheme(dynamicVariables);

  const names = Object.keys(dynamicVariables);
  if (names.length > MAX_DYNAMIC_VARIABLES) {
    throw new Error(`Telnyx session update cannot contain more than ${MAX_DYNAMIC_VARIABLES} variables`);
  }

  const frame = names.length
    ? {
        type: "session.update",
        session: { assistant: { dynamic_variables: dynamicVariables } },
      }
    : { type: "session.update" };
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SESSION_UPDATE_BYTES) {
    throw new Error(`Telnyx session update exceeds ${MAX_SESSION_UPDATE_BYTES} bytes`);
  }

  return { frame, variableNames: names };
}

