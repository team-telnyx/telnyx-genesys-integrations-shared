import { getTtsConnectorProfile } from "./tts-connector-profiles.mjs";
import { loadTtsProviderCatalog } from "./tts-provider-catalog.mjs";

const TELNYX_TTS_ORIGIN = "https://api.telnyx.com";
const TELNYX_CHAT_COMPLETIONS_URL =
  "https://api.telnyx.com/v2/ai/openai/chat/completions";

export const ADMIN_TTS_SAMPLE_MODEL = "moonshotai/Kimi-K2.6";
export const ADMIN_TTS_SAMPLE_TEXT_MAX_LENGTH = 800;

const EXPRESSIVE_MODES = Object.freeze({
  "ultra-pcm": {
    label: "Telnyx Ultra",
    tags: [
      '<emotion value="excited" />',
      '<break time="0.2s"/>',
      "[laughter]",
    ],
  },
  "xai-pcm": {
    label: "xAI Grok",
    tags: ["[pause]", "[laugh]", "[sigh]"],
  },
});

function verifiedProfile(profileId) {
  const profile = getTtsConnectorProfile(profileId);
  if (!profile || profile.status !== "verified") {
    const error = new Error(`Unknown or unsupported TTS provider ${profileId}`);
    error.status = 404;
    throw error;
  }
  return profile;
}

function expressiveMode(profileId) {
  const mode = EXPRESSIVE_MODES[profileId];
  return mode ? { supported: true, ...mode } : { supported: false, label: null, tags: [] };
}

function normalizeLanguage(value) {
  const language = String(value || "").trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    const error = new Error("Select a valid language from the provider catalog");
    error.status = 400;
    throw error;
  }
  return language;
}

function languageName(language) {
  const base = language.split("-")[0].toLowerCase();
  const names = {
    ar: "Arabic", bn: "Bengali", bg: "Bulgarian", zh: "Chinese", cs: "Czech",
    da: "Danish", nl: "Dutch", en: "English", fi: "Finnish", fr: "French",
    de: "German", gu: "Gujarati", he: "Hebrew", hi: "Hindi", id: "Indonesian",
    it: "Italian", ja: "Japanese", ko: "Korean", ms: "Malay", mr: "Marathi",
    mi: "Māori", no: "Norwegian", pl: "Polish", pt: "Portuguese", pa: "Punjabi",
    ro: "Romanian", ru: "Russian", sk: "Slovak", es: "Spanish", sv: "Swedish",
    ta: "Tamil", te: "Telugu", th: "Thai", tr: "Turkish", uk: "Ukrainian",
    vi: "Vietnamese",
  };
  return names[base] || language;
}

function extractCompletionText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((entry) => entry?.text || entry?.content || "").join("");
  }
  return "";
}

function cleanCompletionText(value) {
  let text = String(value || "").trim();
  text = text.replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("“") && text.endsWith("”"))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.length > ADMIN_TTS_SAMPLE_TEXT_MAX_LENGTH) {
    throw new Error("Telnyx inference returned an invalid TTS sample phrase");
  }
  return text;
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

async function responseError(prefix, response) {
  const body = await response.text().catch(() => "");
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.errors?.[0]?.detail || parsed?.error?.message || parsed?.message || body;
  } catch {
    // Keep the bounded response text.
  }
  detail = String(detail || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const error = new Error(`${prefix} returned ${response.status}${detail ? `: ${detail}` : ""}`);
  error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
  return error;
}

export async function loadAdminTtsPreviewCatalog(
  profileId,
  { apiKey, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}
) {
  const profile = verifiedProfile(profileId);
  if (!String(apiKey || "").trim()) throw new Error("TELNYX_API_KEY is unavailable");
  const catalogs = await loadTtsProviderCatalog([profile], { apiKey, fetchImpl, timeoutMs });
  const catalog = catalogs.get(profile.id);
  if (!catalog?.voices?.length) {
    const error = new Error(
      catalog?.error
        ? `${profile.displayName} voice catalog is unavailable: ${catalog.error}`
        : `${profile.displayName} returned no available voices`
    );
    error.status = 502;
    throw error;
  }
  return {
    profileId: profile.id,
    providerName: profile.displayName,
    languages: catalog.languages,
    voices: catalog.voices,
    expressiveMode: expressiveMode(profile.id),
  };
}

export function defaultAdminTtsSampleLanguage(languages = []) {
  const normalized = languages.map((language) => String(language).trim()).filter(Boolean);
  return normalized.find((language) => language.toLowerCase() === "en-us") ||
    normalized.find((language) => language.toLowerCase() === "en") ||
    normalized.find((language) => language.toLowerCase().startsWith("en-")) ||
    normalized[0] || null;
}

export async function generateAdminTtsSampleText({
  profileId,
  language,
  useExpressiveMode = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  const profile = verifiedProfile(profileId);
  const normalizedLanguage = normalizeLanguage(language);
  const mode = expressiveMode(profile.id);
  if (useExpressiveMode && !mode.supported) {
    const error = new Error(`${profile.displayName} does not support expressive mode`);
    error.status = 400;
    throw error;
  }
  if (!String(apiKey || "").trim()) throw new Error("TELNYX_API_KEY is unavailable");

  const expressiveInstruction = useExpressiveMode
    ? `Include exactly 2 or 3 of these supported ${mode.label} speech tags, placed naturally: ${mode.tags.join(", ")}. Keep every tag verbatim and balance paired XML tags.`
    : "Do not include XML, SSML, stage directions, square-bracket tags, or labels.";
  const response = await fetchWithTimeout(fetchImpl, TELNYX_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: ADMIN_TTS_SAMPLE_MODEL,
      enable_thinking: false,
      temperature: 0.65,
      max_tokens: 160,
      messages: [
        {
          role: "system",
          content:
            "Write text for a text-to-speech voice demonstration. Return only one natural, self-contained sentence with no quotation marks, explanation, attribution, Markdown, or code fence. Use a short culturally recognizable public-domain quotation, traditional verse, or proverb when appropriate; never reproduce copyrighted modern lyrics or prose.",
        },
        {
          role: "user",
          content:
            `Create the sample in ${languageName(normalizedLanguage)} (${normalizedLanguage}). ` +
            `It should sound good aloud and stay under 45 words. ${expressiveInstruction}`,
        },
      ],
    }),
  }, timeoutMs);
  if (!response.ok) throw await responseError("Telnyx chat completion", response);
  const body = await response.json().catch(() => ({}));
  return {
    text: cleanCompletionText(extractCompletionText(body)),
    model: ADMIN_TTS_SAMPLE_MODEL,
    language: normalizedLanguage,
    expressiveMode: useExpressiveMode,
  };
}

function substitute(value, replacements) {
  if (typeof value === "string" && Object.hasOwn(replacements, value)) {
    return replacements[value];
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, replacements)])
    );
  }
  return value;
}

function supportsLanguage(voice, language) {
  const expected = language.toLowerCase();
  return (voice.languages || []).some((candidate) => candidate.toLowerCase() === expected);
}

function applyPreviewLanguage(profile, body, language) {
  body.language = language;
  body.voice_settings ||= {};
  if (profile.id === "xai-pcm") body.voice_settings.language = language.split("-")[0];
  if (profile.id === "inworld-pcm") body.voice_settings.language_code = language;
  if (["minimax-pcm", "ultra-pcm"].includes(profile.id)) {
    body.voice_settings.language_boost = languageName(language);
  }
  return body;
}

function wavHeader(dataLength, { sampleRate, channels, bitsPerSample }) {
  const header = Buffer.alloc(44);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function browserAudio(buffer, contract, responseContentType) {
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF") {
    return { buffer, contentType: "audio/wav" };
  }
  if (contract.container === "wav") {
    throw new Error("Telnyx speech synthesis returned an invalid WAV response");
  }
  if (contract.container === "raw" && contract.codec === "pcm_s16le") {
    return {
      buffer: Buffer.concat([wavHeader(buffer.length, contract), buffer]),
      contentType: "audio/wav",
    };
  }
  return { buffer, contentType: responseContentType || "application/octet-stream" };
}

export async function synthesizeAdminTtsPreview({
  profileId,
  voiceId,
  language,
  text,
  useExpressiveMode = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 45_000,
}) {
  const profile = verifiedProfile(profileId);
  const normalizedLanguage = normalizeLanguage(language);
  const sampleText = String(text || "").trim();
  if (!sampleText || sampleText.length > ADMIN_TTS_SAMPLE_TEXT_MAX_LENGTH) {
    const error = new Error(`Sample text must contain 1-${ADMIN_TTS_SAMPLE_TEXT_MAX_LENGTH} characters`);
    error.status = 400;
    throw error;
  }
  const mode = expressiveMode(profile.id);
  if (useExpressiveMode && !mode.supported) {
    const error = new Error(`${profile.displayName} does not support expressive mode`);
    error.status = 400;
    throw error;
  }
  const catalog = await loadAdminTtsPreviewCatalog(profile.id, {
    apiKey,
    fetchImpl,
    timeoutMs: Math.min(timeoutMs, 20_000),
  });
  const voice = catalog.voices.find((candidate) => candidate.id === String(voiceId || ""));
  if (!voice || !supportsLanguage(voice, normalizedLanguage)) {
    const error = new Error("Select a voice available for the chosen language");
    error.status = 400;
    throw error;
  }

  const url = new URL(profile.properties.ttsConnectorSynthesizeURI);
  if (url.origin !== TELNYX_TTS_ORIGIN || url.pathname !== "/v2/text-to-speech/speech") {
    throw new Error("TTS preview endpoint is not allowlisted");
  }
  const body = applyPreviewLanguage(
    profile,
    substitute(profile.advanced.synthesizeBody, { "$voice": voice.id, "$text": sampleText }),
    normalizedLanguage
  );
  body.output_type = "binary_output";
  body.disable_cache = true;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!response.ok) throw await responseError("Telnyx speech synthesis", response);
  const raw = Buffer.from(await response.arrayBuffer());
  if (!raw.length) throw new Error("Telnyx speech synthesis returned empty audio");
  const audio = browserAudio(raw, profile.responseContract, response.headers.get("content-type"));
  return {
    ...audio,
    profileId: profile.id,
    voiceId: voice.id,
    language: normalizedLanguage,
  };
}
