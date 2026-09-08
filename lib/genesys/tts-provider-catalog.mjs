const TELNYX_API_ORIGIN = "https://api.telnyx.com";
const VOICES_PATH = "/v2/text-to-speech/voices";

const CATALOG_DESCRIPTORS = Object.freeze({
  "aws-polly-pcm": { provider: "aws", prefixes: ["aws.polly."] },
  "xai-pcm": { provider: "xai", prefixes: ["xai."] },
  "inworld-pcm": { provider: "inworld", prefixes: ["inworld."] },
  "minimax-pcm": { provider: "minimax", prefixes: ["minimax."] },
  "rime-pcm": { provider: "rime", prefixes: ["rime."] },
  "naturalhd-pcm": {
    provider: "telnyx",
    modelId: "NaturalHD",
    prefixes: ["telnyx.naturalhd."],
  },
  "resemble-wav": { provider: "resemble", prefixes: ["resemble."] },
  "murfai-pcm": { provider: "murfai", prefixes: ["murfai."] },
  "ultra-pcm": {
    provider: "telnyx",
    modelId: "Ultra",
    prefixes: ["telnyx.ultra."],
  },
  "bayan-16khz": {
    provider: "telnyx",
    modelId: "Bayan",
    prefixes: ["telnyx.bayan."],
  },
  "sukhan-mp3": {
    provider: "telnyx",
    modelId: "Sukhan",
    prefixes: ["telnyx.sukhan."],
  },
  "humain-24khz": { provider: "murfai", prefixes: ["humain."] },
  "azure-pcm": { provider: "azure", prefixes: ["azure."] },
});

function catalogDescriptor(profile) {
  if (Array.isArray(profile.advanced?.voices) && profile.advanced.voices.length) return null;
  return CATALOG_DESCRIPTORS[profile.id] || null;
}

function voiceId(voice) {
  return String(voice?.id || voice?.voice_id || voice?.name || "").trim();
}

function languageValues(voice) {
  const raw = voice?.language ?? voice?.language_code ?? voice?.languages;
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      return [entry?.code || entry?.language || entry?.locale || ""];
    });
  }
  return typeof raw === "string" ? raw.split(",") : [];
}

export function normalizeCatalogVoice(voice) {
  const id = voiceId(voice);
  const languages = [...new Set(languageValues(voice).map((value) => String(value).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return {
    id,
    name: String(voice?.name || id).trim(),
    gender: String(voice?.gender || "").trim() || null,
    languages,
    model: String(voice?.model_id || voice?.model || voice?.type || voice?.provider || "").trim() || null,
  };
}

function descriptorKey(descriptor) {
  return `${descriptor.provider}\u0000${descriptor.modelId || ""}`;
}

function providerUrl({ provider, modelId }) {
  const url = new URL(VOICES_PATH, TELNYX_API_ORIGIN);
  url.searchParams.set("provider", provider);
  if (modelId) url.searchParams.set("model", modelId);
  return url;
}

function assertAllowlistedCatalogUrl(url) {
  if (url.origin !== TELNYX_API_ORIGIN || url.pathname !== VOICES_PATH) {
    throw new Error(`Refusing to send Telnyx credentials to ${url.origin}${url.pathname}`);
  }
  return url;
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

function extractVoices(body) {
  if (Array.isArray(body?.voices)) return body.voices;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.voices)) return body.data.voices;
  return [];
}

function matchesDescriptor(voice, descriptor) {
  const expectedModelId = String(descriptor.modelId || "").trim().toLowerCase();
  const actualModelId = String(
    voice?.model_id || voice?.modelId || ""
  ).trim().toLowerCase();
  if (expectedModelId && actualModelId) return actualModelId === expectedModelId;
  const id = voiceId(voice).toLowerCase();
  return descriptor.prefixes.some((prefix) => id.startsWith(prefix));
}

function summarize(
  profile,
  voices,
  {
    source,
    exact = source === "live",
    error = null,
    architectVoices = voices,
  } = {}
) {
  const normalized = voices.map(normalizeCatalogVoice).filter((voice) => voice.id);
  const normalizedArchitectVoices = architectVoices
    .map(normalizeCatalogVoice)
    .filter((voice) => voice.id);
  const languages = [...new Set(normalized.flatMap((voice) => voice.languages))]
    .sort((left, right) => left.localeCompare(right));
  return {
    profileId: profile.id,
    status: profile.status,
    source,
    exact,
    voiceCount: normalized.length,
    languages,
    languageCount: languages.length,
    voices: normalized.sort((left, right) => left.name.localeCompare(right.name)),
    architectVoices: normalizedArchitectVoices.sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    error,
  };
}

function voiceNameLanguageKeys(voice) {
  const normalized = normalizeCatalogVoice(voice);
  const name = normalized.name.toLowerCase();
  return normalized.languages.map((language) => `${name}\u0000${language.toLowerCase()}`);
}

export function staticProviderCatalog(profile) {
  const voices = Array.isArray(profile.advanced?.voices) ? profile.advanced.voices : [];
  return summarize(profile, voices, {
    source: voices.length ? "profile" : "unavailable",
    exact: voices.length > 0,
  });
}

export async function loadTtsProviderCatalog(
  profiles,
  {
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20_000,
  } = {}
) {
  const profileList = [...profiles];
  if (!String(apiKey || "").trim()) {
    return new Map(profileList.map((profile) => [profile.id, staticProviderCatalog(profile)]));
  }
  if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required");

  const descriptors = new Map(
    profileList.map((profile) => [profile.id, catalogDescriptor(profile)])
  );
  const requestDescriptors = new Map();
  for (const descriptor of [...descriptors.values()].filter(Boolean)) {
    requestDescriptors.set(descriptorKey(descriptor), descriptor);
  }
  const responses = new Map();

  await Promise.all([...requestDescriptors.entries()].map(async ([key, descriptor]) => {
    try {
      const url = assertAllowlistedCatalogUrl(providerUrl(descriptor));
      const response = await fetchWithTimeout(fetchImpl, url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Accept-Encoding": "identity",
        },
      }, timeoutMs);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      responses.set(key, { voices: extractVoices(body) });
    } catch (error) {
      responses.set(key, { error: error?.message || String(error) });
    }
  }));

  const catalogs = new Map();
  for (const profile of profileList) {
    const descriptor = descriptors.get(profile.id);
    const result = descriptor ? responses.get(descriptorKey(descriptor)) : null;
    if (!descriptor) {
      catalogs.set(profile.id, staticProviderCatalog(profile));
      continue;
    }
    if (result?.error) {
      const fallback = staticProviderCatalog(profile);
      catalogs.set(profile.id, {
        ...fallback,
        error: result.error,
      });
      continue;
    }
    const matching = result.voices.filter((voice) => matchesDescriptor(voice, descriptor));
    let architectVoices = matching;
    if (descriptor.modelId) {
      const otherModelKeys = new Set(
        result.voices
          .filter((voice) => !matchesDescriptor(voice, descriptor))
          .flatMap(voiceNameLanguageKeys)
      );
      architectVoices = matching.filter((voice) =>
        voiceNameLanguageKeys(voice).every((key) => !otherModelKeys.has(key))
      );
    }
    catalogs.set(
      profile.id,
      summarize(profile, matching, {
        source: "live",
        exact: true,
        architectVoices,
      })
    );
  }
  return catalogs;
}

export function providerCountLabel(catalog) {
  if (!catalog) return "catalog unavailable";
  const qualifier = catalog.exact ? "" : "known ";
  const voices = `${qualifier}${catalog.voiceCount} voice${catalog.voiceCount === 1 ? "" : "s"}`;
  const languages = `${catalog.languageCount} language${catalog.languageCount === 1 ? "" : "s"}`;
  return `${voices}, ${languages}`;
}
