export const GENESYS_AUDIO_PLACEHOLDER_DNIS = Object.freeze([
  "+15550001001",
  "+15550001002",
  "+15550001003",
]);

export const GENESYS_AUDIO_EXAMPLE_DYNAMIC_VARIABLES = Object.freeze([
  Object.freeze({
    architectName: "telnyxVar_first_name",
    telnyxName: "first_name",
    value: "John",
  }),
  Object.freeze({
    architectName: "telnyxVar_last_name",
    telnyxName: "last_name",
    value: "Wick",
  }),
]);

export function genesysAudioDnisValues(values = []) {
  let supplied = values;
  if (typeof supplied === "string") {
    try {
      supplied = JSON.parse(supplied);
    } catch {
      throw new Error("Architect DNIS values must be a JSON array");
    }
  }
  if (!Array.isArray(supplied)) throw new Error("Architect DNIS values must be an array");
  if (supplied.length > 3) throw new Error("Configure no more than 3 Architect DNIS values");
  const normalized = GENESYS_AUDIO_PLACEHOLDER_DNIS.map((fallback, index) =>
    String(supplied[index] || fallback).trim()
  );
  normalized.forEach((value) => {
    if (!/^\+[1-9]\d{7,14}$/.test(value)) {
      throw new Error(`${value || "Empty value"} is not a valid E.164 phone number`);
    }
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Architect DNIS values must be unique");
  }
  return normalized;
}

export function genesysAudioDnisManualAction(
  flowName = "Telnyx Audio Connector",
  dnisValues = GENESYS_AUDIO_PLACEHOLDER_DNIS
) {
  const placeholders = dnisValues.filter((value) => GENESYS_AUDIO_PLACEHOLDER_DNIS.includes(value));
  if (!placeholders.length) {
    return (
      `Open the published Architect flow '${flowName}', verify the configured DNIS Switch cases, ` +
      "then configure the required Genesys number assignments and call routes separately."
    );
  }
  return (
    `Open the published Architect flow '${flowName}', edit the three Switch cases based on ` +
    `Call.CalledAddressOriginal, replace the remaining placeholder DNIS values (${placeholders.join(", ")}) with the real inbound ` +
    "numbers that will route to the assistant, then validate and republish the flow."
  );
}
