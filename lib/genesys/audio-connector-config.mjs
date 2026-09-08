import { installationResourceNames } from "./installation-scope.mjs";

export const DEFAULT_GENESYS_AUDIO_ASSISTANT_NAME =
  "Genesys Audio Connector Assistant";
export const GENESYS_AUDIO_FLOW_NAME = installationResourceNames().installationName;
export const DEFAULT_GENESYS_AUDIO_APPLICATION_NAME = installationResourceNames().installationName;
export const GENESYS_AUDIO_CONNECTOR_LIMIT = 5;
export const GENESYS_AUDIO_CONNECTOR_ID = "ws";
export const GENESYS_AUDIO_HANDOFF_SCRIPT_NAME = installationResourceNames().audioHandoffScript;
export const GENESYS_AUDIO_WIDGET_NAME = installationResourceNames().audioInteractionWidget;
export const GENESYS_AUDIO_STATE_DIRECTORY = ".genesys-audio";

export function genesysAudioDeploymentName(applicationName, deploymentId) {
  const name = String(applicationName || "").trim();
  const id = String(deploymentId || "").trim().toUpperCase();
  if (!name || /[\r\n]/.test(name)) throw new Error("Audio application name is required");
  if (name.length > 120) throw new Error("Audio application name must not exceed 120 characters");
  if (!/^[A-F0-9]{6}$/.test(id)) {
    throw new Error("Audio deployment ID must contain exactly 6 hexadecimal characters");
  }
  return name;
}

export function publicGenesysBaseUrl(value = process.env.GC_PUBLIC_BASE_URL) {
  const configured = String(value || "").trim();
  if (!configured) throw new Error("GC_PUBLIC_BASE_URL is required");
  const url = new URL(configured);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("GC_PUBLIC_BASE_URL must contain only a public HTTPS origin");
  }
  return url.origin;
}

export function genesysAudioConnectorBaseUri(value = process.env.GC_PUBLIC_BASE_URL) {
  const url = new URL(publicGenesysBaseUrl(value));
  url.protocol = "wss:";
  url.pathname = "/api/genesys/audio-connector";
  return url.toString().replace(/\/$/, "");
}
