const TOOL_TYPES = Object.freeze([
  { id: "webhook", label: "Webhook", description: "Call an HTTPS endpoint with validated JSON parameters." },
  { id: "transfer", label: "SIP Transfer", description: "Transfer a voice call to one fixed phone number or SIP endpoint." },
  { id: "hangup", label: "Hangup", description: "Allow an assistant to end a completed voice call." },
  { id: "update_dynamic_variables", label: "Dynamic Variables", description: "Let an assistant update an explicit allowlist of session variables." },
]);

export const ADMIN_CUSTOM_TOOL_TYPES = TOOL_TYPES;

function text(value, label, { max = 500, optional = false } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized && !optional) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} must contain at most ${max} characters`);
  return normalized;
}

function functionName(value, label = "Tool function name") {
  const normalized = text(value, label, { max: 64 });
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(normalized)) {
    throw new Error(`${label} must start with a letter or underscore and contain only letters, digits and underscores`);
  }
  return normalized;
}

function httpsUrl(value) {
  const normalized = text(value, "Webhook URL", { max: 2000 });
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Webhook URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");
  url.username = "";
  url.password = "";
  return url.toString();
}

function callAddress(value, label, { allowTemplate = false } = {}) {
  const normalized = text(value, label, { max: 500 });
  if (/^\+[1-9]\d{6,14}$/.test(normalized) || /^sips?:[^\s]+$/i.test(normalized)) return normalized;
  if (allowTemplate && /^\{\{[A-Za-z_][A-Za-z0-9_]{0,63}\}\}$/.test(normalized)) return normalized;
  throw new Error(`${label} must be an E.164 number${allowTemplate ? ", dynamic variable," : ""} or sip:/sips: URI`);
}

function objectSchema(value) {
  const schema = value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
  if (schema.type !== "object") throw new Error("Webhook body schema type must be object");
  if (schema.properties != null && (typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
    throw new Error("Webhook body schema properties must be an object");
  }
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? [...new Set(schema.required.map((name) => String(name || "").trim()).filter(Boolean))] : [];
  const unknownRequired = required.find((name) => !Object.prototype.hasOwnProperty.call(properties, name));
  if (unknownRequired) throw new Error(`Required webhook parameter ${unknownRequired} is not defined in properties`);
  return { ...schema, type: "object", properties, required };
}

function normalizeVariables(value) {
  const variables = (Array.isArray(value) ? value : []).map((variable) => ({
    name: functionName(variable?.name, "Dynamic variable name"),
    type: String(variable?.type || "string").trim(),
    description: text(variable?.description, `Description for ${variable?.name || "dynamic variable"}`, { max: 500 }),
  }));
  if (!variables.length) throw new Error("Add at least one dynamic variable");
  const allowedTypes = new Set(["string", "number", "integer", "boolean"]);
  const unsupported = variables.find((variable) => !allowedTypes.has(variable.type));
  if (unsupported) throw new Error(`Unsupported type ${unsupported.type} for dynamic variable ${unsupported.name}`);
  if (new Set(variables.map((variable) => variable.name)).size !== variables.length) {
    throw new Error("Dynamic variable names must be unique");
  }
  return variables;
}

export function normalizeAdminCustomTool(input) {
  const kind = String(input?.kind || "").trim();
  if (!TOOL_TYPES.some((entry) => entry.id === kind)) throw new Error(`Unsupported assistant tool type ${kind}`);
  const displayName = text(input?.displayName, "Tool display name", { max: 100 });
  const config = input?.config && typeof input.config === "object" && !Array.isArray(input.config)
    ? input.config
    : {};
  if (kind === "webhook") {
    const normalized = {
      functionName: functionName(config.functionName),
      description: text(config.description, "Webhook description", { max: 1000 }),
      url: httpsUrl(config.url),
      method: String(config.method || "POST").trim().toUpperCase(),
      bodySchema: objectSchema(config.bodySchema || { type: "object", properties: {}, required: [] }),
    };
    if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(normalized.method)) {
      throw new Error(`Unsupported webhook method ${normalized.method}`);
    }
    return {
      kind,
      displayName,
      functionName: normalized.functionName,
      config: normalized,
      definition: {
        display_name: displayName,
        type: "webhook",
        webhook: {
          name: normalized.functionName,
          description: normalized.description,
          url: normalized.url,
          method: normalized.method,
          body_parameters: normalized.bodySchema,
        },
      },
    };
  }
  if (kind === "transfer") {
    const normalized = {
      from: callAddress(config.from, "Transfer caller identity", { allowTemplate: true }),
      to: callAddress(config.to, "Transfer destination"),
      targetName: text(config.targetName || "Transfer destination", "Transfer target name", { max: 100 }),
    };
    return {
      kind,
      displayName,
      functionName: null,
      config: normalized,
      definition: {
        display_name: displayName,
        type: "transfer",
        transfer: { from: normalized.from, targets: [{ name: normalized.targetName, to: normalized.to }] },
      },
    };
  }
  if (kind === "hangup") {
    const normalized = {
      description: text(config.description, "Hangup description", { max: 1000 }),
    };
    return {
      kind,
      displayName,
      functionName: null,
      config: normalized,
      definition: {
        display_name: displayName,
        type: "hangup",
        hangup: { description: normalized.description, intent_message: "" },
      },
    };
  }
  const normalized = {
    functionName: functionName(config.functionName),
    description: text(config.description, "Dynamic variables tool description", { max: 1000 }),
    variables: normalizeVariables(config.variables),
  };
  return {
    kind,
    displayName,
    functionName: normalized.functionName,
    config: normalized,
    definition: {
      display_name: displayName,
      type: "update_dynamic_variables",
      update_dynamic_variables: {
        name: normalized.functionName,
        description: normalized.description,
        updatable_variables: normalized.variables,
      },
    },
  };
}

export function adminCustomToolDraft(tool) {
  if (tool?.metadata?.source !== "admin_catalog") return null;
  return {
    kind: tool.metadata.kind || tool.toolType,
    displayName: tool.displayName,
    config: structuredClone(tool.metadata.config || {}),
  };
}
