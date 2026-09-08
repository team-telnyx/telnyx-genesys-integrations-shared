const TELNYX_API_ORIGIN = "https://api.telnyx.com";
const SYNTHESIZE_URI = `${TELNYX_API_ORIGIN}/v2/text-to-speech/speech`;
const VOICES_URI = `${TELNYX_API_ORIGIN}/v2/text-to-speech/voices`;

export const GENESYS_TTS_CONNECTOR_TYPE = "genesys-tts-connector";
export const GENESYS_TTS_CREDENTIAL_SLOT = "basicAuth";

const voicesUri = ({ provider, model }) => {
  const url = new URL(VOICES_URI);
  url.searchParams.set("provider", provider);
  if (model) url.searchParams.set("model", model);
  return url.toString();
};

const commonProperties = ({ provider, model, voiceTypeAttribute = "model_id" }) => ({
  isPciCompliant: false,
  ttsConnectorVoicesURI: voicesUri({ provider, model }),
  ttsConnectorSynthesizeMethod: "post",
  voiceIdAttribute: "id",
  voiceGenderAttribute: "gender",
  ttsConnectorSynthesizeURI: SYNTHESIZE_URI,
  voicesAttribute: "voices",
  voiceLanguageAttribute: "language",
  voiceTypeAttribute,
  voiceNameAttribute: "name",
});

const staticVoiceProperties = ({ provider, voiceTypeAttribute }) => {
  const properties = commonProperties({ provider, voiceTypeAttribute });
  return { ...properties, ttsConnectorVoicesURI: null };
};

const pcmMapping = (token = "pcm") => ({
  "audio/L16": {
    "8000": token,
    "*": token,
  },
});

const verified = (profile) => ({
  ...profile,
  version: profile.version || 1,
  status: "verified",
  verifiedAt: profile.verifiedAt || "2026-08-09",
  verification: profile.verification || "Manual end-to-end playback through Genesys Cloud",
});

const blocked = ({ id, displayName, reason, aliases = [] }) => ({
  id,
  displayName,
  aliases,
  version: 1,
  status: "blocked",
  blockedAt: "2026-08-09",
  reason,
});

export const TTS_CONNECTOR_PROFILES = Object.freeze({
  "aws-polly-pcm": verified({
    id: "aws-polly-pcm",
    aliases: ["aws-pcm"],
    displayName: "AWS Polly",
    provider: "AWS Polly via Telnyx",
    integrationName: "Telnyx TTS - AWS Polly",
    description: "AWS Polly",
    properties: commonProperties({ provider: "aws", voiceTypeAttribute: "provider" }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          output_format: "pcm",
          sample_rate: "8000",
        },
        text: "$text",
        output_type: "binary_output",
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short AWS Polly text to speech test.",
    },
  }),

  "xai-pcm": verified({
    id: "xai-pcm",
    version: 2,
    aliases: [],
    displayName: "xAI",
    provider: "xAI via Telnyx",
    integrationName: "Telnyx TTS - xAI",
    description: "xAI",
    properties: staticVoiceProperties({ provider: "xai", voiceTypeAttribute: "type" }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      voices: [
        { id: "XAI.eve", name: "XAI.eve", gender: "female", language: "en-US", type: "xAI" },
        { id: "XAI.ara", name: "XAI.ara", gender: "female", language: "en-US", type: "xAI" },
        { id: "XAI.rex", name: "XAI.rex", gender: "male", language: "en-US", type: "xAI" },
        { id: "XAI.sal", name: "XAI.sal", gender: "male", language: "en-US", type: "xAI" },
        { id: "XAI.leo", name: "XAI.leo", gender: "male", language: "en-US", type: "xAI" },
      ],
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          output_format: "pcm",
          sample_rate: 8000,
          language: "en",
        },
        text: "$text",
        output_type: "binary_output",
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short xAI text to speech test.",
    },
  }),

  "inworld-pcm": verified({
    id: "inworld-pcm",
    aliases: [],
    displayName: "Inworld Mini",
    provider: "Inworld via Telnyx",
    integrationName: "Telnyx TTS - Inworld Mini",
    description: "Inworld Mini",
    properties: commonProperties({ provider: "inworld" }),
    advanced: {
      outputFormatMapping: pcmMapping("linear16"),
      synthesizeBody: {
        voice: "$voice",
        language: "en-US",
        voice_settings: {
          encoding: "LINEAR16",
          sample_rate: 8000,
          language_code: "en-US",
        },
        text: "$text",
        output_type: "binary_output",
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Inworld text to speech test.",
    },
  }),

  "minimax-pcm": verified({
    id: "minimax-pcm",
    aliases: [],
    displayName: "MiniMax",
    provider: "MiniMax via Telnyx",
    integrationName: "Telnyx TTS - MiniMax",
    description: "MiniMax",
    properties: commonProperties({ provider: "minimax" }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          sample_rate: 8000,
          language_boost: "English",
          response_format: "pcm",
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short MiniMax text to speech test.",
    },
  }),

  "rime-pcm": verified({
    id: "rime-pcm",
    aliases: [],
    displayName: "Rime Coda",
    provider: "Rime via Telnyx",
    integrationName: "Telnyx TTS - Rime Coda",
    description: "Rime Coda",
    properties: commonProperties({ provider: "rime" }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          sampling_rate: 8000,
          response_format: "pcm",
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Rime text to speech test.",
    },
  }),

  "naturalhd-pcm": verified({
    id: "naturalhd-pcm",
    aliases: [],
    displayName: "Telnyx NaturalHD",
    provider: "Telnyx NaturalHD",
    voiceCatalog: {
      provider: "telnyx",
      modelId: "NaturalHD",
    },
    integrationName: "Telnyx TTS - NaturalHD",
    description: "Telnyx NaturalHD",
    properties: commonProperties({ provider: "telnyx", model: "NaturalHD" }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          sampling_rate: 8000,
          response_format: "pcm",
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Natural HD text to speech test.",
    },
  }),

  "resemble-wav": verified({
    id: "resemble-wav",
    aliases: [],
    displayName: "Resemble Pro",
    provider: "Resemble via Telnyx",
    integrationName: "Telnyx TTS - Resemble",
    description: "Resemble Pro",
    properties: commonProperties({ provider: "resemble" }),
    advanced: {
      outputFormatMapping: pcmMapping("wav"),
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          sample_rate: "8000",
          format: "wav",
          precision: "PCM_16",
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "wav",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Resemble text to speech test.",
    },
  }),

  "fishaudio-pcm": verified({
    id: "fishaudio-pcm",
    version: 3,
    aliases: [],
    displayName: "FishAudio s2.1-pro",
    provider: "FishAudio via Telnyx",
    integrationName: "Telnyx TTS - FishAudio",
    description: "FishAudio s2.1-pro",
    properties: staticVoiceProperties({
      provider: "fishaudio",
      voiceTypeAttribute: "model_id",
    }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      // FishAudio reports only base language codes (for example, `en`) and
      // returns multiple models with duplicate voice names from one provider
      // endpoint. Genesys supports attribute selection but not value mapping,
      // so keep a deterministic s2.1-pro allowlist and expose its English
      // voices as en-US to Architect.
      voices: [
        {
          id: "FishAudio.s2.1-pro.933563129e564b19a115bedd57b7406a",
          name: "FishAudio.s2.1-pro.933563129e564b19a115bedd57b7406a",
          gender: "female",
          language: "en-US",
          model_id: "s2.1-pro",
        },
        {
          id: "FishAudio.s2.1-pro.b545c585f631496c914815291da4e893",
          name: "FishAudio.s2.1-pro.b545c585f631496c914815291da4e893",
          gender: "female",
          language: "en-US",
          model_id: "s2.1-pro",
        },
        {
          id: "FishAudio.s2.1-pro.c2623f0c075b4492ac367989aee1576f",
          name: "FishAudio.s2.1-pro.c2623f0c075b4492ac367989aee1576f",
          gender: "female",
          language: "en-US",
          model_id: "s2.1-pro",
        },
        {
          id: "FishAudio.s2.1-pro.536d3a5e000945adb7038665781a4aca",
          name: "FishAudio.s2.1-pro.536d3a5e000945adb7038665781a4aca",
          gender: "male",
          language: "en-US",
          model_id: "s2.1-pro",
        },
        {
          id: "FishAudio.s2.1-pro.c5f56a6cc2ec4fa8920cb4c5889a3fb7",
          name: "FishAudio.s2.1-pro.c5f56a6cc2ec4fa8920cb4c5889a3fb7",
          gender: "male",
          language: "en-US",
          model_id: "s2.1-pro",
        },
        {
          id: "FishAudio.s2.1-pro.802e3bc2b27e49c2995d23ef70e6ac89",
          name: "FishAudio.s2.1-pro.802e3bc2b27e49c2995d23ef70e6ac89",
          gender: "male",
          language: "en-US",
          model_id: "s2.1-pro",
        },
        {
          id: "FishAudio.s2.1-pro.bf322df2096a46f18c579d0baa36f41d",
          name: "FishAudio.s2.1-pro.bf322df2096a46f18c579d0baa36f41d",
          gender: "male",
          language: "en-US",
          model_id: "s2.1-pro",
        },
      ],
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          format: "pcm",
          sample_rate: 8000,
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Fish Audio text to speech test.",
    },
  }),

  "murfai-pcm": verified({
    id: "murfai-pcm",
    version: 2,
    aliases: ["murfai-wav"],
    displayName: "MurfAI FALCON",
    provider: "MurfAI via Telnyx",
    integrationName: "Telnyx TTS - MurfAI",
    description: "MurfAI FALCON",
    properties: staticVoiceProperties({
      provider: "murfai",
      voiceTypeAttribute: "model_id",
    }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      // The Telnyx voices endpoint currently does not return MurfAI records,
      // even when queried with provider=murfai. A remote catalog would let
      // Genesys select an unrelated provider voice. Keep the connector on a
      // Telnyx-verified FALCON voice until MurfAI catalog discovery is exposed.
      // Genesys substitutes the static voice `name` into $voice, so it must
      // remain the complete Telnyx voice identifier.
      voices: [
        {
          id: "murfai.FALCON.Alicia",
          name: "murfai.FALCON.Alicia",
          gender: "female",
          language: "en-US",
          model_id: "FALCON",
        },
      ],
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          format: "PCM",
          sample_rate: 8000,
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Murf AI text to speech test.",
    },
  }),

  "ultra-pcm": verified({
    id: "ultra-pcm",
    aliases: ["ultra-mp3"],
    displayName: "Telnyx Ultra",
    provider: "Telnyx Ultra",
    voiceCatalog: {
      provider: "telnyx",
      modelId: "Ultra",
    },
    integrationName: "Telnyx TTS - Ultra",
    description: "Telnyx Ultra",
    verifiedAt: "2026-08-14",
    verification: "Production Telnyx REST probe: raw PCM16LE mono at 8 kHz",
    properties: commonProperties({ provider: "telnyx", model: "Ultra" }),
    advanced: {
      outputFormatMapping: pcmMapping(),
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          response_format: "pcm",
          sampling_rate: 8000,
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Telnyx Ultra text to speech test.",
    },
  }),
  "bayan-16khz": blocked({
    id: "bayan-16khz",
    displayName: "Telnyx Bayan",
    aliases: ["bayan-wav"],
    reason: "Bayan exposes PCM at 16 kHz only; direct Genesys playback was degraded or crackled.",
  }),
  "sukhan-mp3": blocked({
    id: "sukhan-mp3",
    displayName: "Telnyx Sukhan",
    reason: "REST binary output returned MP3 at 22.05 kHz despite PCM settings and crackled in Genesys.",
  }),
  "humain-24khz": blocked({
    id: "humain-24khz",
    displayName: "Telnyx Humain",
    reason: "The available direct response is headerless PCM at 24 kHz, not native Genesys 8 kHz.",
  }),
  "azure-pcm": verified({
    id: "azure-pcm",
    aliases: ["azure-mp3"],
    displayName: "Azure",
    provider: "Azure via Telnyx",
    integrationName: "Telnyx TTS - Azure",
    description: "Azure",
    verifiedAt: "2026-08-14",
    verification: "Production Telnyx REST probe: raw PCM16LE mono at 8 kHz",
    properties: commonProperties({ provider: "azure", voiceTypeAttribute: "provider" }),
    advanced: {
      outputFormatMapping: pcmMapping("raw-8khz-16bit-mono-pcm"),
      synthesizeBody: {
        voice: "$voice",
        voice_settings: {
          output_format: "raw-8khz-16bit-mono-pcm",
        },
        text: "$text",
        output_type: "binary_output",
        disable_cache: true,
      },
    },
    responseContract: {
      container: "raw",
      codec: "pcm_s16le",
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
    },
    probe: {
      language: "en-US",
      text: "Hello. This is a short Azure text to speech test.",
    },
  }),
});

const aliases = new Map();
for (const profile of Object.values(TTS_CONNECTOR_PROFILES)) {
  aliases.set(profile.id.toLowerCase(), profile.id);
  for (const alias of profile.aliases || []) aliases.set(alias.toLowerCase(), profile.id);
}

export function listTtsConnectorProfiles() {
  return Object.values(TTS_CONNECTOR_PROFILES);
}

export function verifiedTtsConnectorProfiles() {
  return listTtsConnectorProfiles().filter((profile) => profile.status === "verified");
}

export function getTtsConnectorProfile(profileId) {
  const canonicalId = aliases.get(String(profileId || "").trim().toLowerCase());
  return canonicalId ? TTS_CONNECTOR_PROFILES[canonicalId] : undefined;
}

export function selectTtsConnectorProfiles(value) {
  const requested = String(value || "").trim();
  if (!requested) throw new Error("--profiles is required; use --profiles=all or a comma-separated list");
  const ids = requested.toLowerCase() === "all"
    ? verifiedTtsConnectorProfiles().map((profile) => profile.id)
    : requested.split(",").map((entry) => entry.trim()).filter(Boolean);
  const selected = [];
  const seen = new Set();

  for (const id of ids) {
    const profile = getTtsConnectorProfile(id);
    if (!profile) throw new Error(`Unknown TTS profile: ${id}`);
    if (profile.status !== "verified") {
      throw new Error(`TTS profile ${profile.id} is blocked: ${profile.reason}`);
    }
    if (!seen.has(profile.id)) {
      selected.push(profile);
      seen.add(profile.id);
    }
  }

  if (!selected.length) throw new Error("At least one verified TTS profile is required");
  return selected;
}

export function assertTtsConnectorProfile(profile) {
  if (!profile || profile.status !== "verified") {
    throw new Error(`Profile ${profile?.id || "<unknown>"} is not verified`);
  }
  const synthesizeUrl = new URL(profile.properties?.ttsConnectorSynthesizeURI);
  if (synthesizeUrl.origin !== TELNYX_API_ORIGIN || synthesizeUrl.protocol !== "https:") {
    throw new Error(`Profile ${profile.id} has a non-allowlisted ttsConnectorSynthesizeURI`);
  }
  const voices = profile.advanced?.voices;
  const voicesUri = String(profile.properties?.ttsConnectorVoicesURI || "").trim();
  if (voicesUri) {
    const voicesUrl = new URL(voicesUri);
    if (voicesUrl.origin !== TELNYX_API_ORIGIN || voicesUrl.protocol !== "https:") {
      throw new Error(`Profile ${profile.id} has a non-allowlisted ttsConnectorVoicesURI`);
    }
    if (profile.voiceCatalog) {
      const provider = String(profile.voiceCatalog.provider || "").trim().toLowerCase();
      const modelId = String(profile.voiceCatalog.modelId || "").trim();
      if (!provider || !modelId) {
        throw new Error(`Profile ${profile.id} has an incomplete voiceCatalog filter`);
      }
      if (String(voicesUrl.searchParams.get("provider") || "").toLowerCase() !== provider) {
        throw new Error(`Profile ${profile.id} voiceCatalog provider does not match its voices URI`);
      }
      if (String(voicesUrl.searchParams.get("model") || "") !== modelId) {
        throw new Error(`Profile ${profile.id} voiceCatalog model does not match its voices URI`);
      }
    }
  } else if (!Array.isArray(voices) || !voices.length) {
    throw new Error(`Profile ${profile.id} requires a voices URI or static voices`);
  }
  if (Array.isArray(voices) && voices.length) {
    const ids = new Set();
    for (const voice of voices) {
      for (const field of ["name", "language", "gender"]) {
        if (!String(voice?.[field] || "").trim()) {
          throw new Error(`Profile ${profile.id} has a static voice without ${field}`);
        }
      }
      const id = String(voice.id || voice.name).trim();
      if (ids.has(id)) throw new Error(`Profile ${profile.id} has duplicate static voice IDs`);
      ids.add(id);
    }
  }
  if (profile.properties.ttsConnectorSynthesizeMethod !== "post") {
    throw new Error(`Profile ${profile.id} must synthesize with POST`);
  }
  if (profile.advanced?.synthesizeBody?.output_type !== "binary_output") {
    throw new Error(`Profile ${profile.id} must request binary_output`);
  }
  if (!profile.advanced?.outputFormatMapping?.["audio/L16"]) {
    throw new Error(`Profile ${profile.id} must map audio/L16`);
  }
  const contract = profile.responseContract || {};
  if (
    contract.sampleRate !== 8000 ||
    contract.channels !== 1 ||
    contract.bitsPerSample !== 16 ||
    !["raw", "wav"].includes(contract.container)
  ) {
    throw new Error(`Profile ${profile.id} does not declare a supported 8 kHz PCM contract`);
  }
  if (!profile.probe?.language || !profile.probe?.text) {
    throw new Error(`Profile ${profile.id} must declare a language-based probe`);
  }
  return profile;
}

for (const profile of verifiedTtsConnectorProfiles()) assertTtsConnectorProfile(profile);
