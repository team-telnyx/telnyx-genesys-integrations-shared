import { createHash } from "node:crypto";

export const GENESYS_HANDOFF_TOOL_FUNCTION_NAME = "request_genesys_human_handoff";

const MANAGED_HANDOFF_TOOL_PATTERN =
  /^request_genesys_human_handoff_[0-9a-f]{6}$/i;

export function genesysHandoffToolFunctionName(targetName) {
  const normalizedTargetName = String(targetName || "").trim();
  if (!normalizedTargetName) throw new Error("A deployment name is required for the handoff tool");
  const deploymentId = normalizedTargetName.match(/\(([0-9a-f]{6})\)$/i)?.[1]?.toLowerCase();
  const suffix = deploymentId || createHash("sha256").update(normalizedTargetName).digest("hex").slice(0, 6);
  return `${GENESYS_HANDOFF_TOOL_FUNCTION_NAME}_${suffix}`;
}

export function isGenesysHandoffToolFunctionName(value) {
  const name = String(value || "").trim();
  return (
    name === GENESYS_HANDOFF_TOOL_FUNCTION_NAME ||
    MANAGED_HANDOFF_TOOL_PATTERN.test(name)
  );
}
