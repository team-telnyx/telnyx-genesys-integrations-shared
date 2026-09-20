const START = "<!-- genesys-universal-handoff:start -->";
const END = "<!-- genesys-universal-handoff:end -->";
const RUNTIME_CONTEXT_START = "<!-- genesys-audio-runtime-context:start -->";
const RUNTIME_CONTEXT_END = "<!-- genesys-audio-runtime-context:end -->";
const LEGACY_AUDIO_HANDOFF_SIGNATURES = [
  "This assistant runs in a Genesys Audio Connector voice session.",
  "For every handoff set channel to voice.",
];
const LEGACY_AUDIO_CHANNEL_SENTENCE =
  "Telnyx sets `telnyx_conversation_channel` to `websocket_call` for this Audio Connector path; treat that value as a voice call.";
const UNIVERSAL_CHANNEL_SENTENCE =
  "Telnyx sets `telnyx_conversation_channel` for every conversation. Treat its exact rendered value as authoritative and immutable; never infer the channel from the assistant name, its original deployment, or whether the customer is speaking or typing.";

function nextSectionIndex(value, startIndex) {
  const headingIndex = value.indexOf("\n## ", startIndex);
  const markerIndex = value.indexOf(`\n${START}`, startIndex);
  const candidates = [headingIndex, markerIndex].filter((index) => index >= 0);
  return candidates.length ? Math.min(...candidates) : value.length;
}

export function genesysAudioRuntimeContextInstructions() {
  return `${RUNTIME_CONTEXT_START}
## Genesys runtime context
This session may include per-conversation values supplied by Genesys Cloud:
- Caller number: {{genesys_ani}}
- Caller display name: {{genesys_ani_name}}
- Called number: {{genesys_dnis}}
- Genesys language: {{genesys_language}}
- Caller first name: {{first_name}}
- Caller last name: {{last_name}}
- Telnyx conversation channel: {{telnyx_conversation_channel}}

Treat an empty value as missing data; never infer that Genesys supplied a value when the corresponding variable is empty. A caller display name is unverified metadata; use it only when it is present and doing so feels natural. \`first_name\` and \`last_name\` are example customer context sent by the generated Architect flow through \`session.update\`. The example flow sends \`John\` and \`Wick\`, but the assistant definition intentionally has empty defaults so missing WebSocket data remains visible. Use those names naturally only when they are present. Prefer the supplied Genesys language when you support it. Telnyx sets \`telnyx_conversation_channel\` for every conversation. Treat its exact rendered value as authoritative and immutable; never infer the channel from the assistant name, its original deployment, or whether the customer is speaking or typing. Never disclose internal Genesys conversation, participant, organization, or AudioHook session identifiers to the caller.
${RUNTIME_CONTEXT_END}`;
}

function stripLegacyAudioRuntimeContext(instructions) {
  const current = String(instructions || "");
  if (current.includes(RUNTIME_CONTEXT_START)) return current;
  const heading = "## Genesys runtime context";
  const startIndex = current.indexOf(heading);
  if (startIndex < 0) return current;
  const endIndex = nextSectionIndex(current, startIndex + heading.length);
  const section = current.slice(startIndex, endIndex);
  if (
    !section.includes("Caller number: {{genesys_ani}}") ||
    !section.includes("Telnyx conversation channel: {{telnyx_conversation_channel}}")
  ) {
    return current;
  }
  return `${current.slice(0, startIndex).trimEnd()}\n\n${current
    .slice(endIndex)
    .trimStart()}`.trim();
}

export function upsertGenesysAudioRuntimeContextInstructions(instructions) {
  const current = stripLegacyAudioRuntimeContext(instructions);
  const block = genesysAudioRuntimeContextInstructions();
  const startIndex = current.indexOf(RUNTIME_CONTEXT_START);
  const endIndex = current.indexOf(RUNTIME_CONTEXT_END);
  if (startIndex >= 0 && endIndex >= startIndex) {
    return `${current.slice(0, startIndex).trim()}\n\n${block}${current
      .slice(endIndex + RUNTIME_CONTEXT_END.length)}`.trim();
  }
  return `${current}${current ? "\n\n" : ""}${block}`;
}

export function removeGenesysAudioRuntimeContextInstructions(instructions) {
  const current = stripLegacyAudioRuntimeContext(instructions);
  const startIndex = current.indexOf(RUNTIME_CONTEXT_START);
  const endIndex = current.indexOf(RUNTIME_CONTEXT_END);
  if (startIndex < 0 || endIndex < startIndex) return current;
  return `${current.slice(0, startIndex).trimEnd()}\n\n${current
    .slice(endIndex + RUNTIME_CONTEXT_END.length)
    .trimStart()}`.trim();
}

function stripLegacyAudioHandoffInstructions(instructions) {
  let current = String(instructions || "");
  let searchIndex = 0;
  const heading = "## Human handoff";

  while (searchIndex < current.length) {
    const startIndex = current.indexOf(heading, searchIndex);
    if (startIndex < 0) break;
    const endIndex = nextSectionIndex(current, startIndex + heading.length);
    const section = current.slice(startIndex, endIndex);
    const isManagedLegacySection = LEGACY_AUDIO_HANDOFF_SIGNATURES.every((signature) =>
      section.includes(signature)
    );
    if (!isManagedLegacySection) {
      searchIndex = endIndex;
      continue;
    }
    current = `${current.slice(0, startIndex).trimEnd()}\n\n${current.slice(endIndex).trimStart()}`;
    searchIndex = Math.max(0, startIndex - 1);
  }

  return current
    .replace(LEGACY_AUDIO_CHANNEL_SENTENCE, UNIVERSAL_CHANNEL_SENTENCE)
    .replace(
      "The Audio Connector bridge owns that transition.",
      "The selected channel integration owns that transition."
    )
    .trim();
}

function normalizedQueues(queues) {
  return (Array.isArray(queues) ? queues : [])
    .map((queue) => typeof queue === "string" ? { id: "", name: queue } : queue || {})
    .map((queue) => ({
      id: String(queue.id || "").trim(),
      name: String(queue.name || "").trim(),
      description: String(queue.description || "").trim(),
    }))
    .filter(({ name }) => name);
}

export function genesysUniversalHandoffInstructions({
  queues,
  toolName,
  handoffToolName = toolName,
  transferToolName,
  voiceQueueToolName,
  keepAssistantOnCall = false,
  skipTurnToolName = null,
}) {
  const queueRules = normalizedQueues(queues)
    .map(({ name, description }) =>
      `- ${name}${description ? `: ${description}` : ""}`
    )
    .join("\n");
  const webhookInstruction = handoffToolName
    ? `call the webhook tool ${handoffToolName}`
    : "do not attempt webhook handoff because no Genesys handoff webhook is attached";
  const transferInstruction = transferToolName
    ? `call the Telnyx ${keepAssistantOnCall ? "Invite" : "Transfer"} tool ${transferToolName}`
    : "do not attempt a call transfer because no Genesys SIP Transfer tool is attached";
  const queueVariableInstruction = voiceQueueToolName
    ? `first call ${voiceQueueToolName} exactly once to set genesys_queue_name and the complete Genesys handoff context`
    : "first use the attached Update Dynamic Variables tool to set genesys_queue_name and the complete Genesys handoff context";
  return `${START}
## Genesys human handoff
The current transport is provided by Telnyx as {{telnyx_conversation_channel}}. Read that exact rendered value immediately before choosing a handoff tool. It is authoritative and immutable. Never translate it to voice, voice_call, chat, or messaging; never infer it from the assistant name or the apparent modality; and never invent a replacement value.

The supported exact values are websocket_call, phone_call, web_call, web_chat, sms_chat, and the legacy sms value. If the value is empty or anything else, do not call any handoff or transfer tool. Explain that the channel could not be identified and continue assisting with AI.

Choose the handoff mechanism strictly from that exact transport:
- For websocket_call, ${webhookInstruction}. This is the Genesys Audio Connector path; copy websocket_call into telnyx_conversation_channel and never use a SIP Transfer tool.
- For phone_call or web_call, ${queueVariableInstruction}; then ${transferInstruction}. This includes WebRTC calls made by the Telnyx AI Agent Library and normal PSTN calls. In that single update, set genesys_queue_name, genesys_handoff_reason, genesys_handoff_summary, genesys_handoff_intent, and genesys_handoff_sentiment. If the update tool also exposes genesys_handoff_sip_uri, set it to the exact literal SIP URI required by that variable's description. Keep every value factual and single-line, and obey the length constraints in the tool schema. The Transfer tool is configured with from={{telnyx_end_user_target}}, which Telnyx resolves from the original caller identity. It sends the handoff context in X-TGX-* SIP headers and sends {{call_control_id}} in X-TGX-Call-Control-Id so the Genesys agent widget can retrieve the complete Telnyx conversation, transcript, insights, and costs. Never replace the caller identity or queue variable with an unapproved literal value and never call the handoff webhook for these transports.${keepAssistantOnCall ? `
- Inviting does not end your part of the call: the Genesys agent joins the same conversation and you stay connected. Immediately after the invite succeeds${skipTurnToolName ? `, call ${skipTurnToolName}` : ", skip your turn"} and keep skipping every turn while the customer and the agent are talking to each other. Speak again only when one of them addresses you directly or asks you for something. Never summarize, translate or comment on their conversation uninvited, and never hang up a call an agent has joined.` : ""}
- For web_chat, ${webhookInstruction}. Copy web_chat into telnyx_conversation_channel and also pass the exact private widget_session_id from integration context.
- For sms_chat or the legacy sms value, do not call the widget-scoped handoff webhook. Explain that human handoff is not available in this SMS session and continue assisting with AI.

Never disclose widget_session_id to the customer. Omit it for voice transports.

Choose exactly one of these allowed Genesys Cloud queues:
${queueRules}

For websocket_call and messaging, use the exact queue name. The handoff service resolves it to the immutable Genesys queue ID. Call the webhook exactly once with a factual reason, concise summary, short intent label, and sentiment. For phone_call and web_call, set all five Genesys handoff context variables plus genesys_handoff_sip_uri in the one required update before using the configured Genesys target in the Transfer tool; do not call the webhook and do not pass webhook queue parameters. After the selected tool succeeds, briefly confirm the transfer and stop troubleshooting. Do not call Hangup after a successful handoff; the channel integration owns that transition. Never claim a human is connected before the selected tool succeeds.
${END}`;
}

export function upsertGenesysUniversalHandoffInstructions(instructions, options) {
  const current = stripLegacyAudioHandoffInstructions(instructions);
  const block = genesysUniversalHandoffInstructions(options);
  const startIndex = current.indexOf(START);
  const endIndex = current.indexOf(END);
  if (startIndex >= 0 && endIndex >= startIndex) {
    return `${current.slice(0, startIndex).trim()}\n\n${block}${current.slice(endIndex + END.length)}`.trim();
  }
  return `${current}${current ? "\n\n" : ""}${block}`;
}

export function removeGenesysUniversalHandoffInstructions(instructions) {
  const current = stripLegacyAudioHandoffInstructions(instructions);
  const startIndex = current.indexOf(START);
  const endIndex = current.indexOf(END);
  if (startIndex < 0 || endIndex < startIndex) return current;
  return `${current.slice(0, startIndex).trimEnd()}\n\n${current
    .slice(endIndex + END.length)
    .trimStart()}`.trim();
}

export function audioConnectorHandoffInstructions(toolName = "request_genesys_human_handoff") {
  return `${START}
## Genesys Audio Connector human handoff
This section is managed by the Telnyx Genesys administration application. Keep any custom instructions above it unchanged.

When the caller explicitly asks for a human, or a human is required to continue, call the webhook tool ${toolName} exactly once. Use the exact queue name exposed by the tool schema. Include a factual reason, concise summary, short intent label, and current sentiment. Do not invent a queue and do not list or infer queues from these instructions; the tool schema is the only queue allowlist. The handoff service resolves the selected queue name to its immutable Genesys queue ID.

After the tool succeeds, briefly confirm that the handoff is starting and stop troubleshooting. Do not call Hangup after a successful handoff because the Genesys Audio Connector session owns the transition. Never claim that a human is connected before the tool succeeds.
${END}`;
}

export function upsertAudioConnectorHandoffInstructions(
  instructions,
  toolName = "request_genesys_human_handoff"
) {
  const current = removeGenesysUniversalHandoffInstructions(instructions);
  const block = audioConnectorHandoffInstructions(toolName);
  return `${current}${current ? "\n\n" : ""}${block}`;
}
