import { createHash } from "node:crypto";

import { installationResourceNames } from "./installation-scope.mjs";

export function normalizeManagedDisplayName(value, { label = "Resource name", maximum = 120 } = {}) {
  const normalized = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    throw new Error(`${label} must contain between 1 and ${maximum} single-line characters`);
  }
  return normalized;
}

export function normalizedManagedNameKey(value) {
  return normalizeManagedDisplayName(value).toLocaleLowerCase("en-US");
}

export function widgetResourceBaseName(widgetOrName, environment = process.env) {
  const widgetName = normalizeManagedDisplayName(
    typeof widgetOrName === "string" ? widgetOrName : widgetOrName?.name,
    { label: "Widget name" }
  );
  const installationName = installationResourceNames(environment).installationName;
  return normalizeManagedDisplayName(`${installationName} - ${widgetName}`, {
    label: "Widget resource name",
    maximum: 180,
  });
}

export function widgetTechnicalId6(widget) {
  const stableId = String(widget?.publicId || widget?.public_id || widget?.id || "").trim();
  if (!stableId) throw new Error("Widget ID is required for a technical tool name");
  return createHash("sha256").update(stableId).digest("hex").slice(0, 6);
}

export function widgetVoiceQueueFunctionName(widget) {
  return `select_genesys_voice_queue_${widgetTechnicalId6(widget)}`;
}

export function assertWidgetNameIsNotReserved(name, environment = process.env) {
  const widgetKey = normalizedManagedNameKey(name);
  const installationKey = normalizedManagedNameKey(
    installationResourceNames(environment).installationName
  );
  if (widgetKey === installationKey) {
    throw new Error("Widget name is reserved by this installation");
  }
  return normalizeManagedDisplayName(name, { label: "Widget name" });
}
