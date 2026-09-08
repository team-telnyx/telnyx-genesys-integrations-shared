#!/usr/bin/env node

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Telnyx from "telnyx";
import {
  GENESYS_HANDOFF_TOOL_FUNCTION_NAME,
  genesysHandoffToolFunctionName,
} from "../lib/genesys/handoff-tool-name.js";
import {
  attachedGenesysHandoffTools,
  assistantSharedToolIds,
  mergeGenesysHandoffQueues,
  reconciledAssistantToolIds,
  telnyxToolDefinition,
  telnyxToolDisplayName,
  telnyxToolFunctionName,
  telnyxToolId,
  universalGenesysHandoffToolDefinition,
} from "../lib/genesys/handoff-tool-definition.mjs";
import {
  genesysAudioRuntimeContextInstructions,
  removeGenesysAudioRuntimeContextInstructions,
  removeGenesysUniversalHandoffInstructions,
  upsertAudioConnectorHandoffInstructions,
  upsertGenesysAudioRuntimeContextInstructions,
  genesysUniversalHandoffInstructions,
} from "../lib/genesys/handoff-assistant-instructions.mjs";
import {
  DEFAULT_GENESYS_AUDIO_ASSISTANT_NAME,
  publicGenesysBaseUrl,
} from "../lib/genesys/audio-connector-config.mjs";
import {
  GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES,
} from "../lib/genesys/audio-connector-flow-config.mjs";
import { installationResourceNames } from "../lib/genesys/installation-scope.mjs";
import { ensureAdminManagedInsightProfile } from "../lib/genesys/admin-managed-insights.mjs";

const HANDOFF_SECRET_PREFIX = "telnyx-genesys-handoff";
export const SHARED_HANGUP_TOOL_DISPLAY_NAME = installationResourceNames().sharedHangupTool;
export const SHARED_GENESYS_HANDOFF_TOOL_DISPLAY_NAME = installationResourceNames().widgetHandoffTool;
export const MANAGED_ASSISTANT_TAGS = ["genesys", "audio-connector", "managed"];
export const TELNYX_PRODUCT_ASSISTANT_GREETING =
  "Hi! I can answer questions about Telnyx products and services. If needed, I can connect you to the right human team.";
export const GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS = Object.freeze({
  genesys_handoff_channel_fallback: "",
  genesys_audiohook_session_id: "",
  genesys_organization_id: "",
  genesys_conversation_id: "",
  genesys_participant_id: "",
  genesys_ani: "",
  genesys_ani_name: "",
  genesys_dnis: "",
  genesys_language: "",
  ...Object.fromEntries(
    GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES.map(({ telnyxName }) => [telnyxName, ""])
  ),
});

function required(name, fallback) {
  const value = String(process.env[name] || fallback || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cliOption(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? String(argv[index + 1] || "").trim() : fallback;
}

export function selectedQueueNames(value) {
  return selectedQueues(value).map(({ name }) => name);
}

export function selectedQueues(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "[]"));
  } catch {
    throw new Error("--queues-json must be a JSON array");
  }
  const queues = [...new Map((Array.isArray(parsed) ? parsed : []).map((entry) => {
    const queue = typeof entry === "string"
      ? { id: "", name: entry.trim() }
      : { id: String(entry?.id || "").trim(), name: String(entry?.name || "").trim() };
    return [queue.name.toLowerCase(), queue];
  }).filter(([name]) => name)).values()];
  if (!queues.length) throw new Error("Select at least one Genesys queue for handoff");
  return queues;
}

export function handoffToolFunctionName(targetName) {
  return genesysHandoffToolFunctionName(targetName);
}

function queueInstruction(name) {
  const normalizedName = name.toLowerCase();
  if (normalizedName === "marketing") {
    return `${name}: campaigns, brand, events, promotions, content, and demand-generation questions.`;
  }
  if (normalizedName === "sales") {
    return `${name}: pricing, quotes, purchasing, commercial opportunities, and product evaluation.`;
  }
  if (normalizedName === "support") {
    return `${name}: technical problems, configuration, troubleshooting, incidents, and product usage.`;
  }
  if (normalizedName === "generic") {
    return `${name}: every handoff intent that does not match a more specific allowed queue, including general Telnyx company, platform, account, and service questions.`;
  }
  return `${name}: requests that most closely match this queue's exact name and apparent business function.`;
}

export function assistantInstructions(
  queues,
  toolFunctionName = GENESYS_HANDOFF_TOOL_FUNCTION_NAME
) {
  const normalizedQueues = (Array.isArray(queues) ? queues : []).map((queue) =>
    typeof queue === "string"
      ? { id: "", name: queue }
      : { id: String(queue?.id || "").trim(), name: String(queue?.name || "").trim() }
  ).filter(({ name }) => name);
  const role = `## Role
You are a concise, helpful demo assistant specializing in Telnyx products and services. Answer questions about the Telnyx communications platform, including Voice API and Call Control, SIP Trunking, WebRTC, phone numbers, SMS/MMS, RCS, WhatsApp, Verify, Fax, IoT connectivity, networking, and Telnyx AI Assistants. Explain capabilities and common integration patterns clearly. If you are uncertain about a Telnyx feature, availability, price, limit, or API behavior, say so instead of inventing details, and offer a human handoff when appropriate.`;
  const runtimeContext = genesysAudioRuntimeContextInstructions();
  const handoffQueues = normalizedQueues.map(({ id, name }) => {
    const instruction = queueInstruction(name);
    return { id, name, description: instruction.slice(`${name}: `.length) };
  });
  const handoff = genesysUniversalHandoffInstructions({
    queues: handoffQueues,
    toolName: toolFunctionName,
  });
  return `${role}\n\n${runtimeContext}\n\n## Ending the call\nFor voice transports only, when the caller explicitly asks to hang up, disconnect, or end the call, give a brief farewell and then call the Hangup tool exactly once. Also call the Hangup tool when a voice conversation has clearly concluded. Never call Hangup for sms_chat, web_chat, sms, or any other messaging transport. Do not call Hangup when a human handoff is pending or after the handoff tool succeeds; the channel integration owns that transition.\n\nThe customer can ask to speak with a human agent at any time. You should also offer a human when the issue requires access to their Telnyx account, repeated troubleshooting has failed, or the customer is frustrated.\n\n${handoffQueues.length ? handoff : ""}`;
}

export function prepareGenesysAudioAssistantInstructions(
  instructions,
  toolName = GENESYS_HANDOFF_TOOL_FUNCTION_NAME
) {
  return upsertAudioConnectorHandoffInstructions(
    upsertGenesysAudioRuntimeContextInstructions(instructions),
    toolName
  );
}

export function handoffToolDefinition({ baseUrl, queueNames, targetName, apiKeyRef }) {
  return universalGenesysHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: apiKeyRef,
    queues: queueNames,
    displayName: installationResourceNames().widgetHandoffTool,
    targetName,
  });
}

export function hangupToolDefinition(displayName = SHARED_HANGUP_TOOL_DISPLAY_NAME) {
  return {
    display_name: displayName,
    type: "hangup",
    hangup: {
      description:
        "End the voice call after the caller asks to disconnect, or after the conversation has clearly concluded and the assistant has delivered a brief farewell.",
      intent_message: "",
    },
  };
}

export async function findAssistantByExactName(telnyx, name) {
  // Unlike the paginated Tools endpoint, the Telnyx Assistants endpoint returns
  // a regular { data: [...], meta: {...} } response and is not async iterable.
  // Pass pagination through RequestOptions.query because this SDK method does
  // not expose the endpoint's page parameters in its generated signature.
  const matches = [];
  let pageNumber = 1;
  let totalPages = 1;
  do {
    const response = await telnyx.ai.assistants.list({
      query: { page: { number: pageNumber, size: 100 } },
    });
    if (!response || !Array.isArray(response.data)) {
      throw new Error("Telnyx assistant list returned an unexpected response");
    }
    matches.push(...response.data.filter((assistant) => assistant.name === name));

    const reportedTotalPages = Number(response.meta?.total_pages ?? 1);
    if (!Number.isInteger(reportedTotalPages) || reportedTotalPages < 1) {
      throw new Error("Telnyx assistant list returned invalid pagination metadata");
    }
    totalPages = Math.max(totalPages, reportedTotalPages);
    pageNumber += 1;
  } while (pageNumber <= totalPages);

  if (matches.length > 1) {
    throw new Error(`More than one Telnyx assistant is named ${name}`);
  }
  return matches[0] || null;
}

async function findToolByDisplayName(telnyx, displayName, toolType) {
  const matches = [];
  for await (const tool of telnyx.ai.tools.list()) {
    const definition = telnyxToolDefinition(tool);
    if (tool.display_name === displayName && (!toolType || definition?.type === toolType)) {
      matches.push(tool);
    }
  }
  if (matches.length > 1) throw new Error(`More than one Telnyx ${toolType || "AI"} tool is named ${displayName}`);
  return matches[0] || null;
}

function parsedStringArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "[]"));
  } catch {
    throw new Error(`${label} must be a JSON array`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return [...new Set(parsed.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function assistantUpdateToolIds(assistant, { removeIds = [], addIds = [] } = {}) {
  const removed = new Set(removeIds.map((id) => String(id || "").trim()).filter(Boolean));
  return [...new Set([
    ...assistantSharedToolIds(assistant).filter((id) => !removed.has(id)),
    ...addIds,
  ].map((id) => String(id || "").trim()).filter(Boolean))];
}

function handoffToolBelongsToAnotherInstallation(tool, displayName, baseUrl) {
  if (telnyxToolDisplayName(tool) === displayName) return false;
  if (/telnyx\s+(?:ai\s+)?integrations/i.test(telnyxToolDisplayName(tool))) return true;
  const url = String(tool?.webhook?.url || tool?.tool_definition?.webhook?.url || "").trim();
  if (!url) return false;
  try {
    return new URL(url).origin !== new URL(baseUrl).origin;
  } catch {
    return true;
  }
}

export async function provisionSharedGenesysHandoff({
  assistantIds = [],
  previouslyManagedAssistantIds = [],
  queueNames = [],
  queues = queueNames,
  preferredToolId = "",
  defaultQueueId = "",
  toolDisplayName = installationResourceNames().widgetHandoffTool,
  telnyx: suppliedTelnyx,
} = {}) {
  const selectedIds = [...new Set(assistantIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!selectedIds.length) throw new Error("Select at least one Telnyx AI assistant");
  const normalizedQueues = selectedQueues(JSON.stringify(queues));
  const defaultQueue = normalizedQueues.find(({ id }) => id === defaultQueueId) || null;
  if (defaultQueueId && !defaultQueue) throw new Error("Default queue is outside the handoff allowlist");
  const telnyx = suppliedTelnyx || new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const insightProfile = await ensureAdminManagedInsightProfile({
    telnyx,
    organizationId: required("GC_ORGANIZATION_ID"),
  });
  const baseUrl = publicGenesysBaseUrl();
  const handoffToken = required(
    process.env.GENESYS_HANDOFF_API_KEY
      ? "GENESYS_HANDOFF_API_KEY"
      : "GC_AUDIO_HANDOFF_API_KEY"
  );
  const apiKeyRef = handoffSecretIdentifier(handoffToken);
  const integrationSecret = await ensureIntegrationSecret(telnyx, {
    identifier: apiKeyRef,
    token: handoffToken,
  });

  let existingTool = null;
  if (preferredToolId) {
    try {
      existingTool = await telnyx.ai.tools.retrieve(preferredToolId);
      if (telnyxToolDisplayName(existingTool) !== toolDisplayName) existingTool = null;
    } catch (error) {
      if (Number(error?.status || 0) !== 404) throw error;
    }
  }
  if (!existingTool) {
    existingTool = await findToolByDisplayName(telnyx, toolDisplayName, "webhook");
  }
  // The same universal tool is shared by Audio Connector and Web Chat.
  // Preserve queue names already contributed by the other infrastructure
  // reconciler so applying either component cannot narrow the other's schema.
  const sharedToolQueues = mergeGenesysHandoffQueues(existingTool, normalizedQueues);
  const definition = universalGenesysHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: apiKeyRef,
    queues: sharedToolQueues,
    defaultQueue,
    displayName: toolDisplayName,
    functionName: GENESYS_HANDOFF_TOOL_FUNCTION_NAME,
  });
  const tool = existingTool
    ? await telnyx.ai.tools.update(telnyxToolId(existingTool), definition)
    : await telnyx.ai.tools.create(definition);

  const selected = [];
  for (const assistantId of selectedIds) {
    const assistant = await telnyx.ai.assistants.retrieve(assistantId);
    const attachedHandoffTools = await attachedGenesysHandoffTools(telnyx, assistant);
    const foreignTool = attachedHandoffTools.find(
      (entry) => handoffToolBelongsToAnotherInstallation(entry, toolDisplayName, baseUrl)
    );
    if (foreignTool) {
      throw new Error(
        `Telnyx assistant ${assistantId} already belongs to another Genesys Integrations installation (${telnyxToolDisplayName(foreignTool)}); select a separate assistant`
      );
    }
    const obsoleteHandoffIds = attachedHandoffTools
      .map((entry) => telnyxToolId(entry))
      .filter((id) => id && id !== tool.id);
    const updated = await telnyx.ai.assistants.update(assistantId, {
      instructions: prepareGenesysAudioAssistantInstructions(
        assistant.instructions,
        GENESYS_HANDOFF_TOOL_FUNCTION_NAME
      ),
      enabled_features: [...new Set([...(assistant.enabled_features || []), "telephony"])],
      dynamic_variables: {
        ...(assistant.dynamic_variables || {}),
        ...GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS,
      },
      tool_ids: assistantUpdateToolIds(assistant, {
        removeIds: obsoleteHandoffIds,
        addIds: [tool.id],
      }),
      privacy_settings: {
        ...(assistant.privacy_settings || {}),
        data_retention: true,
        pii_redaction: "disabled",
      },
      insight_settings: {
        ...(assistant.insight_settings || {}),
        insight_group_id: insightProfile.group.id,
      },
    });
    selected.push({
      id: updated.id || assistantId,
      name: updated.name || assistant.name || assistantId,
      removedLegacyToolIds: obsoleteHandoffIds,
    });
  }

  const detached = [];
  const removedAssistantIds = [...new Set(previouslyManagedAssistantIds)]
    .filter((id) => id && !selectedIds.includes(id));
  for (const assistantId of removedAssistantIds) {
    let assistant;
    try {
      assistant = await telnyx.ai.assistants.retrieve(assistantId);
    } catch (error) {
      if (Number(error?.status || 0) === 404) continue;
      throw error;
    }
    const remainingToolIds = assistantUpdateToolIds(assistant, { removeIds: [tool.id] });
    const remainingHandoffTools = await attachedGenesysHandoffTools(telnyx, {
      ...assistant,
      tool_ids: remainingToolIds,
      tools: (assistant.tools || []).filter((entry) => remainingToolIds.includes(telnyxToolId(entry))),
    });
    const updated = await telnyx.ai.assistants.update(assistantId, {
      instructions: remainingHandoffTools.length
        ? assistant.instructions
        : removeGenesysAudioRuntimeContextInstructions(
          removeGenesysUniversalHandoffInstructions(assistant.instructions)
        ),
      tool_ids: remainingToolIds,
    });
    detached.push({ id: updated.id || assistantId, name: updated.name || assistant.name || assistantId });
  }

  return {
    tool: {
      id: tool.id,
      displayName: tool.display_name || definition.display_name,
      functionName: GENESYS_HANDOFF_TOOL_FUNCTION_NAME,
      created: !existingTool,
    },
    integrationSecret,
    assistants: selected,
    detachedAssistants: detached,
    queues: normalizedQueues,
    queueNames: normalizedQueues.map(({ name }) => name),
  };
}

export async function ensureIntegrationSecret(telnyx, { identifier, token }) {
  const matches = [];
  for await (const secret of telnyx.integrationSecrets.list({ filter: { type: "bearer" } })) {
    if (secret.identifier === identifier) matches.push(secret);
  }
  if (matches.length > 1) {
    throw new Error(`More than one Telnyx integration secret is named ${identifier}`);
  }
  if (matches[0]) return { id: matches[0].id, identifier, created: false };
  const created = await telnyx.integrationSecrets.create({
    identifier,
    type: "bearer",
    token,
  });
  const secret = created?.data || created;
  return { id: secret.id, identifier: secret.identifier || identifier, created: true };
}

export function handoffSecretIdentifier(token) {
  const digest = createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
  return `${HANDOFF_SECRET_PREFIX}-${digest}`;
}

export async function provisionTelnyxAssistant({
  assistantName,
  queuesJson,
  defaultQueueId = "",
  assistantConfig = null,
  preferredToolId = null,
  preferredHangupToolId = null,
  toolDisplayName = installationResourceNames().widgetHandoffTool,
  hangupDisplayName = installationResourceNames().sharedHangupTool,
} = {}) {
  const telnyx = new Telnyx({ apiKey: required("TELNYX_API_KEY") });
  const insightProfile = await ensureAdminManagedInsightProfile({
    telnyx,
    organizationId: required("GC_ORGANIZATION_ID"),
  });
  const targetName = String(assistantName || DEFAULT_GENESYS_AUDIO_ASSISTANT_NAME).trim();
  if (!targetName) throw new Error("--assistant-name cannot be empty");
  const queueNames = selectedQueueNames(queuesJson);
  const baseUrl = publicGenesysBaseUrl();
  const handoffToken = required(
    process.env.GENESYS_HANDOFF_API_KEY
      ? "GENESYS_HANDOFF_API_KEY"
      : "GC_AUDIO_HANDOFF_API_KEY"
  );
  const apiKeyRef = handoffSecretIdentifier(handoffToken);
  const integrationSecret = await ensureIntegrationSecret(telnyx, {
    identifier: apiKeyRef,
    token: handoffToken,
  });
  const existingAssistant = await findAssistantByExactName(telnyx, targetName);
  if (assistantConfig?.forceCreate && existingAssistant) {
    throw new Error(`A Telnyx AI assistant named ${targetName} already exists; choose a unique name`);
  }
  const currentAssistant = existingAssistant
    ? await telnyx.ai.assistants.retrieve(existingAssistant.id)
    : null;
  const attachedHandoffTools = currentAssistant
    ? await attachedGenesysHandoffTools(telnyx, currentAssistant)
    : [];
  const queues = selectedQueues(queuesJson);
  const defaultQueue = queues.find(({ id }) => id === defaultQueueId) || null;
  if (defaultQueueId && !defaultQueue) throw new Error("Default queue is outside the handoff allowlist");
  const defaultToolDefinition = universalGenesysHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: apiKeyRef,
    queues,
    defaultQueue,
    displayName: toolDisplayName,
    functionName: GENESYS_HANDOFF_TOOL_FUNCTION_NAME,
  });
  const exactAttachedTool = attachedHandoffTools.find(
    (entry) => telnyxToolDisplayName(entry) === toolDisplayName
  ) || null;
  const foreignAttachedTool = attachedHandoffTools.find((entry) =>
    handoffToolBelongsToAnotherInstallation(entry, toolDisplayName, baseUrl)
  ) || null;
  const attachedTool = exactAttachedTool || (!foreignAttachedTool ? attachedHandoffTools[0] : null);
  if (!attachedTool && foreignAttachedTool) {
    throw new Error(
      `Telnyx assistant ${targetName} already belongs to another Genesys Integrations installation; use a separate assistant`
    );
  }
  let preferredTool = null;
  if (!attachedTool && preferredToolId) {
    try {
      preferredTool = await telnyx.ai.tools.retrieve(preferredToolId);
      if (telnyxToolDisplayName(preferredTool) !== toolDisplayName) preferredTool = null;
    } catch (error) {
      if (Number(error?.status || error?.statusCode || error?.response?.status || 0) !== 404) {
        throw error;
      }
    }
  }
  const namedTool = attachedTool || preferredTool
    ? null
    : await findToolByDisplayName(telnyx, defaultToolDefinition.display_name, "webhook");
  const existingTool = attachedTool || preferredTool || namedTool;
  const mergedQueues = mergeGenesysHandoffQueues(existingTool, queues);
  const toolDefinition = universalGenesysHandoffToolDefinition({
    baseUrl,
    integrationSecretIdentifier: apiKeyRef,
    queues: mergedQueues,
    defaultQueue,
    displayName: existingTool
      ? telnyxToolDisplayName(existingTool)
      : defaultToolDefinition.display_name,
    functionName: existingTool
      ? telnyxToolFunctionName(existingTool)
      : defaultToolDefinition.webhook.name,
  });
  const tool = existingTool
    ? await telnyx.ai.tools.update(telnyxToolId(existingTool), toolDefinition)
    : await telnyx.ai.tools.create(toolDefinition);
  const hangupDefinition = hangupToolDefinition(hangupDisplayName);
  let preferredHangupTool = null;
  if (preferredHangupToolId) {
    try {
      preferredHangupTool = await telnyx.ai.tools.retrieve(preferredHangupToolId);
    } catch (error) {
      if (Number(error?.status || error?.statusCode || error?.response?.status || 0) !== 404) {
        throw error;
      }
    }
  }
  const existingHangupTool = preferredHangupTool ||
    await findToolByDisplayName(telnyx, hangupDefinition.display_name, "hangup");
  const hangupTool = existingHangupTool
    ? await telnyx.ai.tools.update(existingHangupTool.id, hangupDefinition)
    : await telnyx.ai.tools.create(hangupDefinition);

  const body = {
    name: targetName,
    description: assistantConfig?.useCase ||
      `Telnyx product and services assistant with Genesys Audio Connector handoff to: ${queueNames.join(", ")}.`,
    instructions: assistantConfig?.instructions
      ? prepareGenesysAudioAssistantInstructions(
          assistantConfig.instructions,
          GENESYS_HANDOFF_TOOL_FUNCTION_NAME
        )
      : assistantInstructions(mergedQueues, toolDefinition.webhook.name),
    greeting: assistantConfig?.greeting || TELNYX_PRODUCT_ASSISTANT_GREETING,
    ...(assistantConfig?.model ? { model: assistantConfig.model } : {}),
    ...(assistantConfig?.transcription ? { transcription: assistantConfig.transcription } : {}),
    ...(assistantConfig?.voiceSettings ? { voice_settings: assistantConfig.voiceSettings } : {}),
    enabled_features: [...new Set([
      ...(currentAssistant?.enabled_features || []),
      "telephony",
    ])],
    dynamic_variables: {
      ...(currentAssistant?.dynamic_variables || {}),
      ...GENESYS_AUDIO_DYNAMIC_VARIABLE_DEFAULTS,
    },
    tool_ids: currentAssistant
      ? reconciledAssistantToolIds({
          assistant: currentAssistant,
          attachedHandoffTools,
          handoffToolId: tool.id,
          requiredToolIds: [hangupTool.id],
        })
      : [tool.id, hangupTool.id],
    tags: [...new Set([...(currentAssistant?.tags || []), ...MANAGED_ASSISTANT_TAGS])],
    privacy_settings: {
      ...(currentAssistant?.privacy_settings || {}),
      data_retention: true,
      pii_redaction: "disabled",
    },
    insight_settings: {
      ...(currentAssistant?.insight_settings || {}),
      insight_group_id: insightProfile.group.id,
    },
  };

  const assistant = existingAssistant
    ? await telnyx.ai.assistants.update(existingAssistant.id, body)
    : await telnyx.ai.assistants.create(body);
  return {
    assistant: { id: assistant.id, name: assistant.name, created: !existingAssistant },
    tool: { id: tool.id, displayName: tool.display_name, created: !existingTool },
    hangupTool: {
      id: hangupTool.id,
      displayName: hangupTool.display_name,
      created: !existingHangupTool,
    },
    integrationSecret,
    insightGroup: { id: insightProfile.group.id, name: insightProfile.group.name },
    queueNames,
  };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || !args.has("--apply")) {
    console.log(
      "Usage: node --env-file=.env scripts/provision-telnyx-genesys-assistant.mjs --apply --assistant-name=<name> --queues-json=<json> [--default-queue-id=<id>] [--assistant-config-json=<json>]\n" +
        "Creates or updates a self-contained Telnyx assistant and a queue-restricted Genesys voice handoff tool."
    );
    process.exit(args.has("--help") ? 0 : 2);
  }

  try {
    const argv = process.argv.slice(2);
    const sharedAssistantIds = parsedStringArray(
      cliOption(argv, "assistant-ids-json", "[]"),
      "--assistant-ids-json"
    );
    const result = sharedAssistantIds.length
      ? await provisionSharedGenesysHandoff({
          assistantIds: sharedAssistantIds,
          previouslyManagedAssistantIds: parsedStringArray(
            cliOption(argv, "previous-assistant-ids-json", "[]"),
            "--previous-assistant-ids-json"
          ),
          queues: selectedQueues(cliOption(argv, "queues-json")),
          preferredToolId: cliOption(argv, "tool-id"),
          defaultQueueId: cliOption(argv, "default-queue-id"),
          toolDisplayName: cliOption(
            argv,
            "handoff-tool-name",
            installationResourceNames().widgetHandoffTool
          ),
        })
      : await provisionTelnyxAssistant({
          assistantName: cliOption(argv, "assistant-name", DEFAULT_GENESYS_AUDIO_ASSISTANT_NAME),
          queuesJson: cliOption(argv, "queues-json"),
          defaultQueueId: cliOption(argv, "default-queue-id"),
          assistantConfig: JSON.parse(cliOption(argv, "assistant-config-json", "null")),
          preferredToolId: cliOption(argv, "tool-id"),
          preferredHangupToolId: cliOption(argv, "hangup-tool-id"),
          toolDisplayName: cliOption(
            argv,
            "handoff-tool-name",
            installationResourceNames().widgetHandoffTool
          ),
          hangupDisplayName: cliOption(
            argv,
            "hangup-tool-name",
            installationResourceNames().sharedHangupTool
          ),
        });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: error?.status, error: error?.message || String(error) }));
    process.exit(1);
  }
}
