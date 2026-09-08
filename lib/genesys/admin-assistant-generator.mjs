const TELNYX_CHAT_COMPLETIONS_URL = "https://api.telnyx.com/v2/ai/openai/chat/completions";

export const ADMIN_ASSISTANT_RECOMMENDED_MODEL = "moonshotai/Kimi-K2.6";

function completionText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((entry) => entry?.text || entry?.content || "").join("");
  return "";
}

function parsedAssistant(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Telnyx inference did not return assistant JSON");
  const parsed = JSON.parse(text.slice(start, end + 1));
  const name = String(parsed.name || "").trim();
  const instructions = String(parsed.instructions || "").trim();
  const greeting = String(parsed.greeting || "").trim();
  if (name.length < 3 || name.length > 120) {
    throw new Error("Generated assistant name has an invalid length");
  }
  if (instructions.length < 80 || instructions.length > 12_000) {
    throw new Error("Generated assistant instructions have an invalid length");
  }
  if (!greeting || greeting.length > 500) throw new Error("Generated assistant greeting is invalid");
  return { name, instructions, greeting };
}

export async function generateDefaultAudioAssistantContent({
  description,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 45_000,
} = {}) {
  const useCase = String(description || "").trim();
  if (useCase.length < 10 || useCase.length > 2_000) {
    const error = new Error("Short description must contain between 10 and 2000 characters");
    error.status = 400;
    throw error;
  }
  if (!String(apiKey || "").trim()) throw new Error("TELNYX_API_KEY is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(TELNYX_CHAT_COMPLETIONS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: ADMIN_ASSISTANT_RECOMMENDED_MODEL,
        enable_thinking: false,
        temperature: 0.45,
        max_tokens: 1400,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Design an English-language voice AI assistant. Return only a JSON object with string fields name, instructions and greeting. Name must be a concise, distinctive, professional assistant name of 3 to 120 characters tailored to the use case. Instructions must be practical, concise, voice-friendly, safe, and tailored to the described use case. Do not list Genesys queues, API keys, internal IDs, webhook details, or Markdown code fences. Explain when the assistant should offer a human handoff, but do not name the handoff tool because the application appends a managed section. Greeting must be one short natural sentence.",
          },
          { role: "user", content: `Use case: ${useCase}` },
        ],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const detail = String(await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    const error = new Error(`Telnyx chat completion returned ${response.status}${detail ? `: ${detail}` : ""}`);
    error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw error;
  }
  return {
    ...parsedAssistant(completionText(await response.json())),
    model: ADMIN_ASSISTANT_RECOMMENDED_MODEL,
    language: "en",
  };
}
