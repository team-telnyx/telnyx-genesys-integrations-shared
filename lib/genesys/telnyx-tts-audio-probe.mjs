import { createHash } from "node:crypto";

import { assertTtsConnectorProfile } from "./tts-connector-profiles.mjs";

const TELNYX_API_ORIGIN = "https://api.telnyx.com";

function assertAllowlistedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== TELNYX_API_ORIGIN) {
    throw new Error(`Refusing to send Telnyx credentials to non-allowlisted URL ${url.origin}`);
  }
  return url;
}

function substituteTemplate(value, replacements) {
  if (Array.isArray(value)) return value.map((entry) => substituteTemplate(entry, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteTemplate(entry, replacements)])
    );
  }
  return typeof value === "string" && Object.hasOwn(replacements, value)
    ? replacements[value]
    : value;
}

function looksLikeMp3(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3") return true;
  if (buffer.length < 4 || buffer[0] !== 0xff || (buffer[1] & 0xe0) !== 0xe0) return false;
  const layerBits = (buffer[1] >> 1) & 0x03;
  const bitrateIndex = (buffer[2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[2] >> 2) & 0x03;
  return layerBits !== 0 && bitrateIndex !== 0 && bitrateIndex !== 0x0f && sampleRateIndex !== 0x03;
}

function firstNonWhitespaceByte(buffer) {
  for (const value of buffer.subarray(0, Math.min(buffer.length, 64))) {
    if (![0x09, 0x0a, 0x0d, 0x20].includes(value)) return value;
  }
  return undefined;
}

export function parsePcmWav(buffer) {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString("ascii") !== "RIFF") {
    throw new Error("WAV response does not start with RIFF");
  }
  if (buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("RIFF response is not WAVE audio");
  }

  let offset = 12;
  let format;
  let dataBytes;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) {
      throw new Error(`WAV ${chunkId} chunk exceeds the response length`);
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("WAV fmt chunk is too short");
      format = {
        audioFormat: buffer.readUInt16LE(dataOffset),
        channels: buffer.readUInt16LE(dataOffset + 2),
        sampleRate: buffer.readUInt32LE(dataOffset + 4),
        byteRate: buffer.readUInt32LE(dataOffset + 8),
        blockAlign: buffer.readUInt16LE(dataOffset + 12),
        bitsPerSample: buffer.readUInt16LE(dataOffset + 14),
      };
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (!format) throw new Error("WAV response has no fmt chunk");
  if (dataBytes === undefined || dataBytes === 0) throw new Error("WAV response has no audio data");
  return { ...format, dataBytes };
}

export function inspectTelnyxAudio(bufferInput, responseContract, headers = {}) {
  const buffer = Buffer.isBuffer(bufferInput) ? bufferInput : Buffer.from(bufferInput);
  const contentType = String(headers.get?.("content-type") || headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const contentEncoding = String(
    headers.get?.("content-encoding") || headers["content-encoding"] || "identity"
  ).toLowerCase();

  if (!buffer.length) throw new Error("Telnyx returned an empty audio body");
  if (contentEncoding && contentEncoding !== "identity") {
    throw new Error(`Telnyx returned unsupported content encoding ${contentEncoding}`);
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    throw new Error("Telnyx returned gzip bytes instead of raw audio");
  }
  if (contentType.includes("json") || contentType.startsWith("text/")) {
    throw new Error(`Telnyx returned ${contentType || "text"} instead of binary audio`);
  }
  const firstByte = firstNonWhitespaceByte(buffer);
  if (firstByte === 0x7b || firstByte === 0x5b) {
    throw new Error("Telnyx returned a JSON-looking body instead of binary audio");
  }
  if (looksLikeMp3(buffer)) throw new Error("Telnyx returned MP3 bytes for an 8 kHz PCM profile");
  const asciiPrefix = buffer.subarray(0, Math.min(12, buffer.length)).toString("ascii");
  if (asciiPrefix.startsWith("UklGR") || asciiPrefix.startsWith("SUQz")) {
    throw new Error("Telnyx returned base64-encoded audio instead of raw binary audio");
  }

  let audioBytes = buffer.length;
  let wav;
  if (responseContract.container === "wav") {
    wav = parsePcmWav(buffer);
    if (wav.audioFormat !== 1) throw new Error(`WAV codec ${wav.audioFormat} is not integer PCM`);
    if (wav.channels !== responseContract.channels) {
      throw new Error(`WAV has ${wav.channels} channel(s), expected ${responseContract.channels}`);
    }
    if (wav.sampleRate !== responseContract.sampleRate) {
      throw new Error(`WAV sample rate is ${wav.sampleRate}, expected ${responseContract.sampleRate}`);
    }
    if (wav.bitsPerSample !== responseContract.bitsPerSample) {
      throw new Error(
        `WAV sample size is ${wav.bitsPerSample} bits, expected ${responseContract.bitsPerSample}`
      );
    }
    audioBytes = wav.dataBytes;
  } else {
    if (buffer.subarray(0, 4).toString("ascii") === "RIFF") {
      throw new Error("Telnyx returned a WAV container for a raw PCM profile");
    }
    if (buffer.length % 2 !== 0) throw new Error("Raw PCM16 response has an odd byte length");
    if (buffer.length < 160) throw new Error("Raw PCM16 response is implausibly short");
  }

  const bytesPerSecond =
    responseContract.sampleRate * responseContract.channels * (responseContract.bitsPerSample / 8);
  return {
    container: responseContract.container,
    codec: responseContract.codec,
    sampleRate: responseContract.sampleRate,
    channels: responseContract.channels,
    bitsPerSample: responseContract.bitsPerSample,
    contentType: contentType || null,
    contentEncoding: contentEncoding || "identity",
    byteLength: buffer.length,
    audioBytes,
    estimatedDurationMs: Math.round((audioBytes / bytesPerSecond) * 1000),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    ...(wav ? { wav } : {}),
  };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function responseError(prefix, response, bodyText) {
  const detail = String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return new Error(`${prefix} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

function voiceId(voice) {
  return String(voice?.id || voice?.voice_id || "").trim();
}

function voiceLanguage(voice) {
  return String(voice?.language || voice?.locale || "").trim().toLowerCase();
}

function voiceMatchesCatalog(voice, voiceCatalog) {
  const modelId = String(voiceCatalog?.modelId || "").trim().toLowerCase();
  if (!modelId) return true;
  const explicitModelId = String(
    voice?.model_id || voice?.modelId || ""
  ).trim().toLowerCase();
  if (explicitModelId) return explicitModelId === modelId;
  const provider = String(voiceCatalog?.provider || "").trim().toLowerCase();
  return Boolean(provider) && voiceId(voice).toLowerCase().startsWith(`${provider}.${modelId}.`);
}

export function selectProbeVoice(voices, preferredLanguage, voiceCatalog) {
  const usable = voices
    .filter((voice) => voiceId(voice))
    .filter((voice) => voiceMatchesCatalog(voice, voiceCatalog));
  if (!usable.length) return undefined;
  const preferred = String(preferredLanguage || "").trim().toLowerCase();
  if (!preferred) return usable[0];
  return usable.find((voice) => voiceLanguage(voice) === preferred);
}

export async function probeTelnyxTtsProfile(
  profile,
  {
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}
) {
  assertTtsConnectorProfile(profile);
  if (!String(apiKey || "").trim()) throw new Error("TELNYX_API_KEY is required for an audio probe");
  if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required");

  const synthesizeUrl = assertAllowlistedUrl(profile.properties.ttsConnectorSynthesizeURI);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Accept-Encoding": "identity",
  };
  let voices = profile.advanced?.voices || [];
  if (profile.properties.ttsConnectorVoicesURI) {
    const voicesUrl = assertAllowlistedUrl(profile.properties.ttsConnectorVoicesURI);
    const voicesResponse = await fetchWithTimeout(
      fetchImpl,
      voicesUrl,
      { method: "GET", headers },
      timeoutMs
    );
    const voicesText = await voicesResponse.text();
    if (!voicesResponse.ok) throw responseError("Telnyx voice catalog", voicesResponse, voicesText);
    let voicesBody;
    try {
      voicesBody = JSON.parse(voicesText);
    } catch {
      throw new Error("Telnyx voice catalog did not return valid JSON");
    }
    voices = Array.isArray(voicesBody.voices)
      ? voicesBody.voices
      : Array.isArray(voicesBody.data)
        ? voicesBody.data
        : [];
  }
  const selectedVoice = selectProbeVoice(
    voices,
    profile.probe.language,
    profile.voiceCatalog
  );
  if (!selectedVoice) {
    const modelRequirement = profile.voiceCatalog?.modelId
      ? ` for model ${profile.voiceCatalog.modelId}`
      : "";
    throw new Error(
      `Telnyx returned no usable voices${modelRequirement} with exact ` +
        `${profile.probe.language} locale for profile ${profile.id}`
    );
  }

  const body = substituteTemplate(profile.advanced.synthesizeBody, {
    "$voice": voiceId(selectedVoice),
    "$text": profile.probe.text,
  });
  const audioResponse = await fetchWithTimeout(
    fetchImpl,
    synthesizeUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    throw responseError("Telnyx synthesis probe", audioResponse, errorText);
  }
  const audio = Buffer.from(await audioResponse.arrayBuffer());
  const inspection = inspectTelnyxAudio(audio, profile.responseContract, audioResponse.headers);
  return {
    profileId: profile.id,
    voice: {
      id: voiceId(selectedVoice),
      name: selectedVoice.name,
      language: selectedVoice.language,
    },
    request: {
      endpoint: synthesizeUrl.toString(),
      outputType: body.output_type,
    },
    audio: inspection,
  };
}
