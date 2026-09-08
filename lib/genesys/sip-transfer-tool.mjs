import {
  assistantToolIds,
  telnyxToolDefinition,
  telnyxToolDisplayName,
  telnyxToolId,
} from "./handoff-tool-definition.mjs";

export const TELNYX_END_USER_TARGET_TEMPLATE = "{{telnyx_end_user_target}}";
export const GENESYS_QUEUE_NAME_TEMPLATE = "{{genesys_queue_name}}";
export const GENESYS_QUEUE_SIP_HEADER = "X-TGX-Queue-Name";
export const GENESYS_HANDOFF_SIP_URI_VARIABLE = "genesys_handoff_sip_uri";
export const GENESYS_HANDOFF_SIP_URI_TEMPLATE = `{{${GENESYS_HANDOFF_SIP_URI_VARIABLE}}}`;
export const TELNYX_CALL_CONTROL_ID_TEMPLATE = "{{call_control_id}}";
export const TELNYX_CALL_CONTROL_ID_SIP_HEADER = "X-TGX-Call-Control-Id";
export const WIDGET_SESSION_ID_TEMPLATE = "{{widget_session_id}}";
export const WIDGET_SESSION_ID_SIP_HEADER = "X-TGX-Widget-Session-Id";
export const GENESYS_HANDOFF_SIP_CONTEXT = Object.freeze([
  { header: "X-TGX-Handoff-Reason", variable: "genesys_handoff_reason" },
  { header: "X-TGX-Summary", variable: "genesys_handoff_summary" },
  { header: "X-TGX-Intent", variable: "genesys_handoff_intent" },
  { header: "X-TGX-Sentiment", variable: "genesys_handoff_sentiment" },
]);

function requiredText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export { normalizeGenesysSipUri } from "./sip-uri.mjs";
// A re-export creates no local binding, and this module validates destinations itself.
import { normalizeGenesysSipUri } from "./sip-uri.mjs";

export function normalizeTelnyxWebCallerNumber(value) {
  const number = requiredText(value, "Telnyx Widget WebRTC caller number");
  if (!/^\+[1-9]\d{6,14}$/.test(number)) {
    throw new Error("Telnyx Widget WebRTC caller number must use E.164 format, for example +15551234567");
  }
  return number;
}

// The Telnyx AI Assistant transfer tool accepts and stores sip_transport_protocol
// and media_encryption, but does not apply them to the outbound INVITE: a tool
// carrying TLS/SRTP still produced a plain leg against a TLS trunk. Encrypted
// media is requested through the destination URI instead — see buildGenesysSipUri,
// which appends ;secure=srtp for a TLS trunk. Pass these explicitly only once
// Telnyx honors them on this path.

export function genesysSipTransferToolDefinition({
  displayName,
  from,
  to,
  targetName = "Genesys Cloud",
  queueHeaderName = GENESYS_QUEUE_SIP_HEADER,
  queueNameTemplate = GENESYS_QUEUE_NAME_TEMPLATE,
  callControlIdHeaderName = TELNYX_CALL_CONTROL_ID_SIP_HEADER,
  callControlIdTemplate = TELNYX_CALL_CONTROL_ID_TEMPLATE,
  dynamicDestination = false,
  sipTransportProtocol = null,
  mediaEncryption = null,
}) {
  const destination = normalizeGenesysSipUri(to);
  return {
    display_name: requiredText(displayName, "Telnyx Transfer tool display name"),
    type: "transfer",
    transfer: {
      from: requiredText(from, "Telnyx Transfer tool from identity"),
      ...(sipTransportProtocol ? { sip_transport_protocol: sipTransportProtocol } : {}),
      ...(mediaEncryption ? { media_encryption: mediaEncryption } : {}),
      targets: [
        {
          name: requiredText(targetName, "Telnyx Transfer target name"),
          to: dynamicDestination ? GENESYS_HANDOFF_SIP_URI_TEMPLATE : destination,
        },
      ],
      custom_headers: [
        {
          name: requiredText(queueHeaderName, "Genesys queue SIP header name"),
          value: requiredText(queueNameTemplate, "Genesys queue dynamic variable"),
        },
        {
          name: requiredText(
            callControlIdHeaderName,
            "Telnyx call control ID SIP header name"
          ),
          value: requiredText(
            callControlIdTemplate,
            "Telnyx call control ID dynamic variable"
          ),
        },
        {
          name: WIDGET_SESSION_ID_SIP_HEADER,
          value: WIDGET_SESSION_ID_TEMPLATE,
        },
        ...GENESYS_HANDOFF_SIP_CONTEXT.map(({ header, variable }) => ({
          name: header,
          value: `{{${variable}}}`,
        })),
      ],
    },
  };
}

export function genesysVoiceQueueToolDefinition({
  displayName,
  functionName,
  queues,
  sipUri,
}) {
  const toolName = requiredText(functionName, "Telnyx Update Dynamic Variables function name");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(toolName)) {
    throw new Error("Telnyx Update Dynamic Variables function name is invalid");
  }
  const queueNames = [...new Set(
    (Array.isArray(queues) ? queues : [])
      .map((queue) => String(typeof queue === "string" ? queue : queue?.name || "").trim())
      .filter(Boolean)
  )];
  if (!queueNames.length) throw new Error("At least one Genesys queue is required");
  const destination = normalizeGenesysSipUri(sipUri);
  return {
    display_name: requiredText(displayName, "Telnyx Update Dynamic Variables display name"),
    type: "update_dynamic_variables",
    update_dynamic_variables: {
      name: toolName,
      description:
        "Prepare the Genesys Cloud queue and concise agent handoff context immediately before a phone_call or web_call SIP transfer. Call exactly once per transfer.",
      updatable_variables: [
        {
          name: "genesys_queue_name",
          type: "string",
          description: `Set this to exactly one allowed Genesys Cloud queue name: ${queueNames.join(", ")}.`,
        },
        {
          name: "genesys_handoff_reason",
          type: "string",
          description:
            "A factual, single-line reason for human handoff, maximum 160 characters; never include CR or LF characters.",
        },
        {
          name: "genesys_handoff_summary",
          type: "string",
          description:
            "A concise, single-line conversation summary for the Genesys agent, maximum 300 characters; never include CR or LF characters.",
        },
        {
          name: "genesys_handoff_intent",
          type: "string",
          description:
            "A short, single-line customer intent label, maximum 80 characters; never include CR or LF characters.",
        },
        {
          name: "genesys_handoff_sentiment",
          type: "string",
          description:
            "One lowercase value describing customer sentiment: positive, neutral, negative, or mixed.",
        },
        {
          name: GENESYS_HANDOFF_SIP_URI_VARIABLE,
          type: "string",
          description: `Use ${destination}`,
        },
      ],
    },
  };
}

// Invite keeps the assistant on the call while the Genesys agent joins, where
// Transfer hands the leg over and drops it. Telnyx models both the same way —
// from, targets, custom headers — so the handoff context and the ;secure=srtp
// destination travel identically. Web calls only: messaging has no SIP leg, and
// an Audio Connector call is already bridged into Genesys by Architect.
export function genesysSipInviteToolDefinition({
  displayName,
  from,
  to,
  targetName = "Genesys Cloud",
  queueHeaderName = GENESYS_QUEUE_SIP_HEADER,
  queueNameTemplate = GENESYS_QUEUE_NAME_TEMPLATE,
  callControlIdHeaderName = TELNYX_CALL_CONTROL_ID_SIP_HEADER,
  callControlIdTemplate = TELNYX_CALL_CONTROL_ID_TEMPLATE,
  dynamicDestination = false,
}) {
  const destination = dynamicDestination ? null : normalizeGenesysSipUri(to);
  return {
    display_name: requiredText(displayName, "Telnyx Invite tool display name"),
    type: "invite",
    invite: {
      from: requiredText(from, "Telnyx Invite tool from identity"),
      targets: [
        {
          name: requiredText(targetName, "Telnyx Invite target name"),
          to: dynamicDestination ? GENESYS_HANDOFF_SIP_URI_TEMPLATE : destination,
        },
      ],
      custom_headers: [
        {
          name: requiredText(queueHeaderName, "Genesys queue SIP header name"),
          value: requiredText(queueNameTemplate, "Genesys queue dynamic variable"),
        },
        {
          name: requiredText(callControlIdHeaderName, "Telnyx call control ID SIP header name"),
          value: requiredText(callControlIdTemplate, "Telnyx call control ID dynamic variable"),
        },
        {
          name: WIDGET_SESSION_ID_SIP_HEADER,
          value: WIDGET_SESSION_ID_TEMPLATE,
        },
        ...GENESYS_HANDOFF_SIP_CONTEXT.map(({ header, variable }) => ({
          name: header,
          value: `{{${variable}}}`,
        })),
      ],
    },
  };
}

// Inviting an agent onto a live call leaves the assistant holding the turn. Skip
// turn is what lets it stay connected and silent until it is addressed again, so
// the pair is always attached together.
export function genesysSkipTurnToolDefinition({ displayName, description } = {}) {
  return {
    display_name: requiredText(displayName, "Telnyx Skip Turn tool display name"),
    type: "skip_turn",
    skip_turn: {
      description: String(
        description ||
        "Stay on the call without speaking. Use this after inviting a Genesys Cloud agent, " +
        "and whenever the customer is talking to that agent, so the conversation is not interrupted. " +
        "Respond again only when the customer or the agent addresses the assistant directly."
      ).trim(),
    },
  };
}

export function telnyxInviteTargets(tool) {
  const definition = telnyxToolDefinition(tool);
  return Array.isArray(definition?.invite?.targets) ? definition.invite.targets : [];
}

export function telnyxTransferTargets(tool) {
  const definition = telnyxToolDefinition(tool);
  return Array.isArray(definition?.transfer?.targets)
    ? definition.transfer.targets
    : [];
}

export function isTransferToolForDestination(tool, destination) {
  const expected = normalizeGenesysSipUri(destination).toLowerCase();
  const definition = telnyxToolDefinition(tool);
  return definition?.type === "transfer" && telnyxTransferTargets(tool).some(
    (target) => String(target?.to || "").trim().toLowerCase() === expected
  );
}

// Invite and Transfer both answer "get me a human", so leaving the previous one
// attached lets the model pick either. Only the tools this integration created
// for the widget's own destination are detached, never an unrelated transfer.
export async function attachedGenesysCallHandoffTools(telnyx, assistant, types) {
  const wanted = new Set(types);
  const inlineTools = new Map(
    (Array.isArray(assistant?.tools) ? assistant.tools : [])
      .map((tool) => [telnyxToolId(tool), tool])
      .filter(([id]) => id)
  );
  const results = [];
  for (const id of assistantToolIds(assistant)) {
    const tool = inlineTools.get(id) || await telnyx.ai.tools.retrieve(id);
    const definition = telnyxToolDefinition(tool);
    if (!wanted.has(definition?.type)) continue;
    const targets = definition?.type === "invite"
      ? telnyxInviteTargets(tool)
      : telnyxTransferTargets(tool);
    if (targets.some((target) => String(target?.to || "").trim() === GENESYS_HANDOFF_SIP_URI_TEMPLATE)) {
      results.push(id);
    }
  }
  return results;
}

export async function attachedTransferTools(telnyx, assistant) {
  const inlineTools = new Map(
    (Array.isArray(assistant?.tools) ? assistant.tools : [])
      .map((tool) => [telnyxToolId(tool), tool])
      .filter(([id]) => id)
  );
  const results = [];
  for (const id of assistantToolIds(assistant)) {
    let tool = inlineTools.get(id);
    if (tool) {
      if (telnyxToolDefinition(tool)?.type === "transfer") results.push(tool);
      continue;
    }
    tool = await telnyx.ai.tools.retrieve(id);
    if (telnyxToolDefinition(tool)?.type === "transfer") results.push(tool);
  }
  return results;
}

export function findMatchingTransferTool(tools, { displayName, destination }) {
  const named = (Array.isArray(tools) ? tools : []).find(
    (tool) => telnyxToolDisplayName(tool) === displayName
  );
  if (named) return named;
  return (Array.isArray(tools) ? tools : []).find(
    (tool) => isTransferToolForDestination(tool, destination)
  ) || null;
}
