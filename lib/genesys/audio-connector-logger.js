export const GENESYS_AUDIO_CONNECTOR_LOG_PREFIX =
  "[genesys-audio-connector]";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const MAX_LOGGED_JSON_CHARACTERS = 12_000;
const AUDIO_PAYLOAD_EVENT_TYPES = new Set([
  "input_audio_buffer.append",
  "response.audio.delta",
  "response.output_audio.delta",
]);

export function genesysAudioConnectorDebugEnabled(environment = process.env) {
  return ENABLED_VALUES.has(
    String(environment.GC_AUDIO_CONNECTOR_DEBUG || "").trim().toLowerCase()
  );
}

export function isAudioConnectorMediaEvent(value) {
  return AUDIO_PAYLOAD_EVENT_TYPES.has(String(value?.type || ""));
}

function truncate(value) {
  const text = String(value);
  if (text.length <= MAX_LOGGED_JSON_CHARACTERS) return text;
  return `${text.slice(0, MAX_LOGGED_JSON_CHARACTERS)}… <truncated ${
    text.length - MAX_LOGGED_JSON_CHARACTERS
  } characters>`;
}

export function summarizeAudioConnectorJson(value) {
  if (!value || typeof value !== "object") return truncate(value);

  const summarized = { ...value };
  if (
    summarized.parameters?.inputVariables &&
    typeof summarized.parameters.inputVariables === "object" &&
    !Array.isArray(summarized.parameters.inputVariables)
  ) {
    summarized.parameters = {
      ...summarized.parameters,
      inputVariables: Object.fromEntries(
        Object.keys(summarized.parameters.inputVariables).map((name) => [
          name,
          "<redacted>",
        ])
      ),
    };
  }
  if (typeof summarized.audio === "string") {
    summarized.audio = `<base64 audio: ${Buffer.from(
      summarized.audio,
      "base64"
    ).length} bytes>`;
  }
  if (
    typeof summarized.delta === "string" &&
    (summarized.type === "response.output_audio.delta" ||
      summarized.type === "response.audio.delta")
  ) {
    summarized.delta = `<base64 audio: ${Buffer.from(
      summarized.delta,
      "base64"
    ).length} bytes>`;
  }

  try {
    return truncate(JSON.stringify(summarized));
  } catch {
    return "<unserializable WebSocket message>";
  }
}

export function createGenesysAudioConnectorLogger({
  environment = process.env,
  logger = console,
} = {}) {
  const enabled = genesysAudioConnectorDebugEnabled(environment);
  const write = (level, ...values) => {
    if (!enabled) return;
    const method = typeof logger[level] === "function" ? logger[level] : logger.log;
    method?.call(logger, GENESYS_AUDIO_CONNECTOR_LOG_PREFIX, ...values);
  };

  return {
    enabled,
    info: (...values) => write("info", ...values),
    warn: (...values) => write("warn", ...values),
    error: (...values) => write("error", ...values),
    wire: (direction, message) => {
      if (!enabled) return;
      write(
        "info",
        `${direction}:`,
        typeof message === "function" ? message() : message
      );
    },
  };
}
