import { normalizePublicApplicationOrigin } from "./public-origin-manager.mjs";
import {
  GENESYS_HANDOFF_TOOL_FUNCTION_NAME,
  genesysHandoffToolFunctionName,
  isGenesysHandoffToolFunctionName,
} from "./handoff-tool-name.js";
import { installationResourceNames } from "./installation-scope.mjs";

export const GENESYS_HANDOFF_PATH = "/api/genesys/handoff";
export const SHARED_GENESYS_HANDOFF_TOOL_DISPLAY_NAME = installationResourceNames().widgetHandoffTool;

function emptySchema() {
  return { type: "object", properties: {}, required: [], additionalProperties: false };
}

function normalizedQueues(queues) {
  return [...new Map(
    (Array.isArray(queues) ? queues : []).map((queue) => {
      const item = typeof queue === "string" ? { id: "", name: queue } : queue || {};
      const name = String(item.name || "").trim();
      return [name.toLowerCase(), { id: String(item.id || "").trim(), name }];
    })
  ).values()].filter(({ name }) => name);
}

export function genesysHandoffUrl(baseUrl) {
  return `${normalizePublicApplicationOrigin(baseUrl)}${GENESYS_HANDOFF_PATH}`;
}

export function universalGenesysHandoffToolDefinition({
  baseUrl,
  integrationSecretIdentifier,
  queues = [],
  defaultQueue = null,
  displayName,
  functionName = GENESYS_HANDOFF_TOOL_FUNCTION_NAME,
  targetName,
}) {
  const secret = String(integrationSecretIdentifier || "").trim();
  if (!secret) throw new Error("Telnyx integration secret identifier is required");
  const resolvedDisplayName = String(displayName || "").trim();
  if (!resolvedDisplayName) throw new Error("Telnyx handoff tool display name is required");
  const resolvedFunctionName = targetName
    ? genesysHandoffToolFunctionName(targetName)
    : String(functionName || "").trim();
  if (!isGenesysHandoffToolFunctionName(resolvedFunctionName)) {
    throw new Error("Invalid Genesys handoff tool function name");
  }
  const allowedQueues = normalizedQueues(queues);
  const fallbackQueue = defaultQueue
    ? allowedQueues.find(({ id, name }) =>
        (defaultQueue.id && id === defaultQueue.id) ||
        (defaultQueue.name && name.toLowerCase() === String(defaultQueue.name).toLowerCase())
      )
    : null;
  return {
    display_name: resolvedDisplayName,
    type: "webhook",
    timeout_ms: 10_000,
    webhook: {
      name: resolvedFunctionName,
      description:
        "Request a Genesys human handoff only for websocket_call Audio Connector sessions or web_chat widget sessions. SMS handoff is not supported by this widget-scoped webhook. Never use this webhook for phone_call or web_call; those transports must use the Genesys SIP Transfer tool.",
      url: genesysHandoffUrl(baseUrl),
      method: "POST",
      headers: [
        {
          name: "telnyx-ai-api-key",
          value: `{{#integration_secret}}${secret}{{/integration_secret}}`,
        },
        { name: "Content-Type", value: "application/json" },
      ],
      path_parameters: emptySchema(),
      query_parameters: emptySchema(),
      body_parameters: {
        type: "object",
        properties: {
          telnyx_conversation_channel: {
            type: "string",
            description:
              "Copy the exact resolved value of {{telnyx_conversation_channel}}. This webhook accepts websocket_call or web_chat; never send sms_chat, sms, phone_call, or web_call.",
          },
          widget_session_id: {
            type: "string",
            description:
              "For web widget messaging, copy the exact private widget_session_id from the integration context. Omit it for voice calls.",
          },
          queue_name: {
            type: "string",
            ...(allowedQueues.length
              ? { enum: allowedQueues.map(({ name }) => name) }
              : {}),
            description: `Exact Genesys queue name selected from the deployment allowlist.${fallbackQueue ? ` Omit it when no queue can be determined; ${fallbackQueue.name} is then used as the default.` : ""}`,
          },
          reason: { type: "string", description: "Why the customer needs a human agent." },
          summary: { type: "string", description: "Concise factual conversation summary." },
          intent: { type: "string", description: "Short customer intent label." },
          sentiment: {
            type: "string",
            enum: ["positive", "neutral", "negative", "mixed", "unknown"],
            description: "Current customer sentiment.",
          },
        },
        required: [
          "telnyx_conversation_channel",
          "reason",
          "summary",
          "intent",
          "sentiment",
        ],
        additionalProperties: false,
      },
      async: false,
    },
  };
}

export function telnyxToolDefinition(tool) {
  const value = tool || {};
  const payload = value?.tool_definition;
  if (!payload || typeof payload !== "object") return value;

  const type = String(value?.type || payload?.type || "").trim();
  const normalized = {
    ...value,
    ...payload,
    ...(type ? { type } : {}),
  };

  // Telnyx returns shared tools in two shapes. Assistant resources expose
  // `{ type: "webhook", webhook: {...} }`, while GET /ai/tools/:id exposes
  // `{ type: "webhook", tool_definition: {...webhook fields} }`. Normalize
  // the latter to the former so all readers use one representation.
  if (type && !normalized[type]) normalized[type] = payload;
  return normalized;
}

export function telnyxToolId(tool) {
  return String(tool?.id || tool?.tool_id || "").trim() || null;
}

export function telnyxToolDisplayName(tool) {
  const definition = telnyxToolDefinition(tool);
  return String(
    tool?.display_name || tool?.name || definition?.display_name || ""
  ).trim();
}

export function telnyxToolFunctionName(tool) {
  const definition = telnyxToolDefinition(tool);
  return String(
    definition?.webhook?.name || definition?.update_dynamic_variables?.name || ""
  ).trim();
}

export function isGenesysHandoffTool(tool) {
  return isGenesysHandoffToolFunctionName(telnyxToolFunctionName(tool));
}

async function listedTelnyxTools(telnyx) {
  const listing = telnyx.ai.tools.list();
  if (listing?.[Symbol.asyncIterator]) {
    const tools = [];
    for await (const tool of listing) tools.push(tool);
    return tools;
  }
  const response = await listing;
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.data) ? response.data : [];
}

function preferredToolMatch(matches, preferredToolIds) {
  for (const preferredId of preferredToolIds) {
    const preferred = matches.find((tool) => telnyxToolId(tool) === preferredId);
    if (preferred) return preferred;
  }
  return null;
}

function canonicalSharedToolMatch(matches) {
  return [...matches].sort((left, right) => {
    const leftExactName = telnyxToolDisplayName(left) === SHARED_GENESYS_HANDOFF_TOOL_DISPLAY_NAME;
    const rightExactName = telnyxToolDisplayName(right) === SHARED_GENESYS_HANDOFF_TOOL_DISPLAY_NAME;
    if (leftExactName !== rightExactName) return leftExactName ? -1 : 1;
    const leftCreated = String(left?.created_at || left?.createdAt || "");
    const rightCreated = String(right?.created_at || right?.createdAt || "");
    if (leftCreated !== rightCreated) {
      if (!leftCreated) return 1;
      if (!rightCreated) return -1;
      return leftCreated.localeCompare(rightCreated);
    }
    return telnyxToolId(left).localeCompare(telnyxToolId(right));
  })[0] || null;
}

export async function findSharedGenesysHandoffTool(
  telnyx,
  { preferredToolIds = [], displayName = "" } = {}
) {
  const preferredIds = [...new Set(
    (Array.isArray(preferredToolIds) ? preferredToolIds : [preferredToolIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )];
  if (typeof telnyx.ai.tools.retrieve === "function") {
    for (const preferredId of preferredIds) {
      try {
        const preferred = await telnyx.ai.tools.retrieve(preferredId);
        if (!displayName || telnyxToolDisplayName(preferred) === displayName) return preferred;
      } catch (error) {
        const status = Number(
          error?.status || error?.statusCode || error?.response?.status || 0
        );
        if (status !== 404) throw error;
      }
    }
  }
  const exactFunctionMatches = [];
  const displayNameMatches = [];
  const matchedIds = new Set();
  const targetDisplayName = String(displayName || "").trim();
  for (const tool of await listedTelnyxTools(telnyx)) {
    const exactFunction = telnyxToolFunctionName(tool) === GENESYS_HANDOFF_TOOL_FUNCTION_NAME;
    const toolDisplayName = telnyxToolDisplayName(tool);
    const exactDisplayName = toolDisplayName === (
      targetDisplayName || SHARED_GENESYS_HANDOFF_TOOL_DISPLAY_NAME
    );
    if (targetDisplayName && toolDisplayName !== targetDisplayName) continue;
    if (!exactFunction && !exactDisplayName) continue;
    const id = telnyxToolId(tool);
    if (id && matchedIds.has(id)) continue;
    if (id) matchedIds.add(id);
    if (exactFunction) exactFunctionMatches.push(tool);
    else displayNameMatches.push(tool);
  }
  if (exactFunctionMatches.length > 1) {
    const preferred = preferredToolMatch(exactFunctionMatches, preferredIds);
    if (preferred) return preferred;
    return canonicalSharedToolMatch(exactFunctionMatches);
  }
  if (exactFunctionMatches.length === 1) return exactFunctionMatches[0];
  if (displayNameMatches.length > 1) {
    const preferred = preferredToolMatch(displayNameMatches, preferredIds);
    if (preferred) return preferred;
    return canonicalSharedToolMatch(displayNameMatches);
  }
  return displayNameMatches[0] || null;
}

export function assistantToolIds(assistant) {
  return [...new Set([
    ...(Array.isArray(assistant?.tool_ids) ? assistant.tool_ids : []),
    ...(Array.isArray(assistant?.tools)
      ? assistant.tools.map((tool) => telnyxToolId(tool))
      : []),
  ].map((id) => String(id || "").trim()).filter(Boolean))];
}

export function assistantSharedToolIds(assistant) {
  return [...new Set([
    ...(Array.isArray(assistant?.tool_ids) ? assistant.tool_ids : []),
    ...(Array.isArray(assistant?.tools)
      ? assistant.tools
          .filter((tool) => tool?.shared === true)
          .map((tool) => telnyxToolId(tool))
      : []),
  ].map((id) => String(id || "").trim()).filter(Boolean))];
}

export async function attachedGenesysHandoffTools(telnyx, assistant) {
  const byId = new Map(
    (Array.isArray(assistant?.tools) ? assistant.tools : [])
      .map((tool) => [telnyxToolId(tool), tool])
      .filter(([id]) => id)
  );
  const matches = [];
  for (const id of assistantToolIds(assistant)) {
    let tool = byId.get(id);
    const inlineDefinition = telnyxToolDefinition(tool);
    const hasInlineDefinition = Boolean(
      inlineDefinition?.type ||
      inlineDefinition?.webhook ||
      inlineDefinition?.hangup ||
      inlineDefinition?.transfer
    );
    if (!tool || !hasInlineDefinition) {
      tool = await telnyx.ai.tools.retrieve(id);
    }
    if (isGenesysHandoffTool(tool)) matches.push(tool);
  }
  return matches;
}

export function reconciledAssistantToolIds({
  assistant,
  attachedHandoffTools = [],
  handoffToolId,
  requiredToolIds = [],
}) {
  const obsoleteHandoffIds = new Set(
    attachedHandoffTools
      .map((tool) => telnyxToolId(tool))
      .filter((id) => id && id !== handoffToolId)
  );
  return [...new Set([
    ...assistantSharedToolIds(assistant).filter((id) => !obsoleteHandoffIds.has(id)),
    handoffToolId,
    ...requiredToolIds,
  ].map((id) => String(id || "").trim()).filter(Boolean))];
}

export function mergeGenesysHandoffQueues(existingTool, requestedQueues = []) {
  const definition = telnyxToolDefinition(existingTool);
  const properties = definition?.webhook?.body_parameters?.properties || {};
  const existingNames = Array.isArray(properties.queue_name?.enum)
    ? properties.queue_name.enum
    : [];
  const existingIds = Array.isArray(properties.queue_id?.enum)
    ? properties.queue_id.enum
    : [];
  const existing = existingNames.map((name, index) => ({
    id: existingIds.length === existingNames.length ? existingIds[index] || "" : "",
    name,
  }));
  return normalizedQueues([...existing, ...requestedQueues]);
}

// Both the Audio Connector and the Widget installer look up managed tools by
// display name, so the lookup lives here rather than being duplicated in each.
export async function findTelnyxToolByName(telnyx, displayName, toolType = null) {
  const matches = [];
  const exactType = String(toolType || "").trim();
  const matchesTarget = (tool) => tool.display_name === displayName && (
    !exactType || String(telnyxToolDefinition(tool)?.type || tool?.type || "").trim() === exactType
  );
  const listing = telnyx.ai.tools.list?.();
  if (listing?.[Symbol.asyncIterator]) {
    for await (const tool of listing) {
      if (matchesTarget(tool)) matches.push(tool);
    }
  } else {
    const response = listing ? await listing : { data: [] };
    for (const tool of response?.data || response || []) {
      if (matchesTarget(tool)) matches.push(tool);
    }
  }
  if (matches.length > 1) {
    throw new Error(`More than one Telnyx ${exactType || "AI"} tool is named ${displayName}`);
  }
  return matches[0] || null;
}
