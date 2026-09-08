const MANAGED_INSTRUCTION_SECTIONS = Object.freeze([
  {
    id: "universal_handoff",
    label: "Genesys human handoff",
    startMarker: "<!-- genesys-universal-handoff:start -->",
    endMarker: "<!-- genesys-universal-handoff:end -->",
  },
  {
    id: "audio_runtime_context",
    label: "Genesys runtime context",
    startMarker: "<!-- genesys-audio-runtime-context:start -->",
    endMarker: "<!-- genesys-audio-runtime-context:end -->",
  },
  {
    id: "widget_hangup",
    label: "Voice call completion",
    startMarker: "<!-- telnyx-widget-hangup:start -->",
    endMarker: "<!-- telnyx-widget-hangup:end -->",
  },
]);

export const ADMIN_MANAGED_INSTRUCTION_SECTION_IDS = Object.freeze(
  MANAGED_INSTRUCTION_SECTIONS.map((section) => section.id)
);

export function extractAdminManagedInstructionSections(instructions) {
  const current = String(instructions || "");
  return MANAGED_INSTRUCTION_SECTIONS.flatMap((definition) => {
    const start = current.indexOf(definition.startMarker);
    const end = current.indexOf(definition.endMarker, start + definition.startMarker.length);
    if (start < 0 || end < start) return [];
    return [{
      ...definition,
      content: current
        .slice(start + definition.startMarker.length, end)
        .replace(/^\s*\n?/, "")
        .replace(/\n?\s*$/, ""),
    }];
  });
}

export function applyAdminManagedInstructionSections(instructions, updates = []) {
  const requested = new Map((Array.isArray(updates) ? updates : []).map((section) => [
    String(section?.id || "").trim(),
    String(section?.content || "").trim(),
  ]));
  let result = String(instructions || "");
  for (const definition of MANAGED_INSTRUCTION_SECTIONS) {
    if (!requested.has(definition.id)) continue;
    const start = result.indexOf(definition.startMarker);
    const end = result.indexOf(definition.endMarker, start + definition.startMarker.length);
    if (start < 0 || end < start) {
      throw new Error(`Managed instruction section ${definition.id} is no longer present on the assistant`);
    }
    const content = requested.get(definition.id);
    if (!content) throw new Error(`Managed instruction section ${definition.id} cannot be empty`);
    if (content.includes("<!--") || content.includes("-->")) {
      throw new Error(`Managed instruction section ${definition.id} cannot contain instruction markers`);
    }
    const replacement = `${definition.startMarker}\n${content}\n${definition.endMarker}`;
    result = `${result.slice(0, start)}${replacement}${result.slice(end + definition.endMarker.length)}`;
  }
  return result;
}

export function reconcileAdminManagedInstructionSections(instructions, desiredSections = []) {
  const requested = new Map((Array.isArray(desiredSections) ? desiredSections : []).map((section) => [
    String(section?.id || "").trim(),
    String(section?.content || "").trim(),
  ]));
  let result = String(instructions || "");
  for (const definition of MANAGED_INSTRUCTION_SECTIONS) {
    if (!requested.has(definition.id)) continue;
    const content = requested.get(definition.id);
    if (!content) throw new Error(`Managed instruction section ${definition.id} cannot be empty`);
    if (content.includes("<!--") || content.includes("-->")) {
      throw new Error(`Managed instruction section ${definition.id} cannot contain instruction markers`);
    }
    const start = result.indexOf(definition.startMarker);
    const end = result.indexOf(definition.endMarker, start + definition.startMarker.length);
    const replacement = `${definition.startMarker}\n${content}\n${definition.endMarker}`;
    if (start >= 0 && end >= start) {
      result = `${result.slice(0, start)}${replacement}${result.slice(end + definition.endMarker.length)}`;
    } else {
      result = `${result.trimEnd()}${result.trim() ? "\n\n" : ""}${replacement}`;
    }
  }
  return result;
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => typeof entry === "string" ? entry : entry?.phone_number || entry?.phoneNumber || entry?.number)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean))];
}

export function adminAssistantPreview(
  assistant,
  { usage = {}, managedTools = [], managedInsights = null, instructionSections = [] } = {}
) {
  const enabledFeatures = stringList(assistant?.enabled_features);
  const assignedNumbers = stringList([
    ...(usage.dnis || []),
    ...(assistant?.phone_numbers || []),
    ...(assistant?.assigned_phone_numbers || []),
    ...(assistant?.telephony_settings?.phone_numbers || []),
  ]);
  return {
    id: String(assistant?.id || ""),
    name: String(assistant?.name || assistant?.id || ""),
    description: String(assistant?.description || ""),
    greeting: String(assistant?.greeting || ""),
    instructions: String(assistant?.instructions || ""),
    model: String(assistant?.model || ""),
    externalLlm: assistant?.external_llm || null,
    enabledFeatures,
    assignedNumbers,
    transcription: assistant?.transcription || null,
    voiceSettings: assistant?.voice_settings || null,
    telephonySettings: assistant?.telephony_settings || null,
    messagingSettings: assistant?.messaging_settings || null,
    dynamicVariables: assistant?.dynamic_variables || {},
    integrations: assistant?.integrations || [],
    mcpServers: assistant?.mcp_servers || [],
    tags: assistant?.tags || [],
    privacySettings: assistant?.privacy_settings || null,
    insightSettings: assistant?.insight_settings || null,
    managedInsights,
    instructionSections,
    version: {
      id: assistant?.version_id || null,
      name: assistant?.version_name || null,
      createdAt: assistant?.version_created_at || null,
    },
    usage,
    managedTools,
  };
}
