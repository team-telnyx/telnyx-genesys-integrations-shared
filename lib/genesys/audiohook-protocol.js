import { randomUUID } from "node:crypto";

export const GENESYS_AUDIOHOOK_VERSION = "2";
export const GENESYS_AUDIOHOOK_MEDIA = Object.freeze({
  type: "audio",
  format: "PCMU",
  channels: ["external"],
  rate: 8000,
});

export const GENESYS_AUDIOHOOK_L16_MEDIA = Object.freeze({
  type: "audio",
  format: "L16",
  channels: ["external"],
  rate: 8000,
});

const AUDIOHOOK_MEDIA_FORMATS = Object.freeze(["L16", "PCMU"]);

export function preferredAudioHookMediaFormat(value) {
  const format = String(value || "PCMU").trim().toUpperCase();
  if (!AUDIOHOOK_MEDIA_FORMATS.includes(format)) {
    throw new AudioHookProtocolError(
      `Unsupported preferred AudioHook format ${format || "unknown"}; expected L16 or PCMU`,
      415
    );
  }
  return format;
}

export class AudioHookProtocolError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.name = "AudioHookProtocolError";
    this.code = code;
  }
}

export function parseAudioHookMessage(value) {
  let message;
  try {
    message = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new AudioHookProtocolError("AudioHook message is not valid JSON");
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AudioHookProtocolError("AudioHook message must be an object");
  }
  if (message.version !== GENESYS_AUDIOHOOK_VERSION) {
    throw new AudioHookProtocolError("Unsupported AudioHook protocol version", 415);
  }
  if (!message.id || !message.type || !Number.isInteger(message.seq)) {
    throw new AudioHookProtocolError("AudioHook message is missing id, type, or seq");
  }
  return message;
}

export function parseAudioHookOpenMessage(value) {
  const message = parseAudioHookMessage(value);
  if (message.type !== "open") {
    throw new AudioHookProtocolError("The first AudioHook message must be open", 409);
  }
  const parameters = message.parameters || {};
  if (!parameters.organizationId || !parameters.conversationId || !parameters.participant?.id) {
    throw new AudioHookProtocolError(
      "AudioHook open message is missing organization, conversation, or participant data"
    );
  }
  const media = Array.isArray(parameters.media) ? parameters.media : [];
  if (!selectAudioHookMedia(media)) {
    throw new AudioHookProtocolError(
      "AudioHook client must offer mono external PCMU or L16 audio at 8000 Hz",
      415
    );
  }
  return message;
}

export function selectAudioHookMedia(value, preferredFormat = "PCMU") {
  const media = Array.isArray(value) ? value : value?.parameters?.media;
  if (!Array.isArray(media)) return null;

  const preferred = preferredAudioHookMediaFormat(preferredFormat);
  const formatPreference = [
    preferred,
    ...AUDIOHOOK_MEDIA_FORMATS.filter((format) => format !== preferred),
  ];
  for (const format of formatPreference) {
    const selected = media.find(
      (candidate) =>
        candidate?.type === "audio" &&
        candidate?.format === format &&
        candidate?.rate === 8000 &&
        Array.isArray(candidate?.channels) &&
        candidate.channels.length === 1 &&
        candidate.channels[0] === "external"
    );
    if (selected) return selected;
  }
  return null;
}

export function decodeAudioHookAudio(value, media) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (media?.format === "L16") {
    if (input.length % 2 !== 0) {
      throw new AudioHookProtocolError("L16 audio must contain complete samples", 400);
    }
    // Genesys AudioHook L16 and the Telnyx Assistant WebSocket PCM16 contract
    // both carry signed 16-bit little-endian samples. Keep the original Buffer
    // so this route is a codec pass-through rather than a transcode.
    return input;
  }
  if (media?.format !== "PCMU") {
    throw new AudioHookProtocolError(`Unsupported AudioHook format ${media?.format || "unknown"}`, 415);
  }

  const output = Buffer.allocUnsafe(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const value = (~input[index]) & 0xff;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    output.writeInt16LE(sign ? -sample : sample, index * 2);
  }
  return output;
}

export function encodeAudioHookAudio(value, media) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (input.length % 2 !== 0) {
    throw new AudioHookProtocolError("PCM16 audio must contain complete samples", 400);
  }
  if (media?.format === "L16") return input;
  if (media?.format !== "PCMU") {
    throw new AudioHookProtocolError(`Unsupported AudioHook format ${media?.format || "unknown"}`, 415);
  }

  const output = Buffer.allocUnsafe(input.length / 2);
  for (let offset = 0; offset < input.length; offset += 2) {
    let sample = input.readInt16LE(offset);
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample = Math.min(sample, 32635) + 0x84;

    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) {
      exponent -= 1;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    output[offset / 2] = (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }
  return output;
}

export function audioHookFrameBytes(media, frameDurationMs = 20) {
  if (media?.rate !== 8000 || !Number.isInteger(frameDurationMs) || frameDurationMs <= 0) {
    throw new AudioHookProtocolError("Unsupported AudioHook frame configuration", 415);
  }
  const bytesPerSample = media.format === "PCMU" ? 1 : media.format === "L16" ? 2 : 0;
  if (!bytesPerSample) {
    throw new AudioHookProtocolError(`Unsupported AudioHook format ${media?.format || "unknown"}`, 415);
  }
  return (media.rate * frameDurationMs * bytesPerSample) / 1000;
}

export function requireAudioHookAssistantId(message) {
  const assistantId = message?.parameters?.inputVariables?.assistantId;
  if (typeof assistantId !== "string" || !assistantId.trim()) {
    throw new AudioHookProtocolError(
      "AudioHook input variable assistantId is required",
      422
    );
  }
  return assistantId.trim();
}

export class AudioHookServerSequence {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.serverSeq = 0;
    this.clientSeq = 0;
  }

  observe(message) {
    if (message.id !== this.sessionId) {
      throw new AudioHookProtocolError("AudioHook session id changed", 409);
    }
    if (message.seq <= this.clientSeq) {
      throw new AudioHookProtocolError("AudioHook client sequence is not increasing", 409);
    }
    this.clientSeq = message.seq;
  }

  message(type, parameters = {}) {
    this.serverSeq += 1;
    return {
      version: GENESYS_AUDIOHOOK_VERSION,
      type,
      seq: this.serverSeq,
      clientseq: this.clientSeq,
      id: this.sessionId,
      parameters,
    };
  }

  opened(media = GENESYS_AUDIOHOOK_MEDIA) {
    return this.message("opened", { media: [media], startPaused: false });
  }

  pong() {
    return this.message("pong", {});
  }

  updated() {
    return this.message("updated", {});
  }

  bargeIn() {
    return this.message("event", {
      entities: [{ type: "barge_in", data: {} }],
    });
  }

  disconnect({ reason = "completed", info, outputVariables } = {}) {
    return this.message("disconnect", {
      reason,
      ...(info ? { info: String(info).slice(0, 256) } : {}),
      ...(outputVariables ? { outputVariables } : {}),
    });
  }

  closed() {
    return this.message("closed", {});
  }

  error(code, message) {
    return this.message("error", {
      code,
      message: String(message || "AudioHook protocol error").slice(0, 1000),
    });
  }
}

export function unauthorizedAudioHookDisconnect(sessionId) {
  const sequence = new AudioHookServerSequence(sessionId || randomUUID());
  return sequence.disconnect({ reason: "unauthorized" });
}

export class StreamingPcm16Resampler {
  constructor(inputRate, outputRate = 8000) {
    if (!Number.isInteger(inputRate) || inputRate <= 0) {
      throw new TypeError("inputRate must be a positive integer");
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.ratio = inputRate / outputRate;
    this.samples = [];
    this.position = 0;
  }

  push(buffer) {
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (input.length % 2 !== 0) {
      throw new AudioHookProtocolError("PCM16 audio must contain complete samples", 400);
    }
    if (this.inputRate === this.outputRate) return input;

    for (let offset = 0; offset < input.length; offset += 2) {
      this.samples.push(input.readInt16LE(offset));
    }

    const output = [];
    while (Math.floor(this.position) + 1 < this.samples.length) {
      const leftIndex = Math.floor(this.position);
      const fraction = this.position - leftIndex;
      const left = this.samples[leftIndex];
      const right = this.samples[leftIndex + 1];
      output.push(Math.round(left + (right - left) * fraction));
      this.position += this.ratio;
    }

    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.samples = this.samples.slice(consumed);
      this.position -= consumed;
    }

    const result = Buffer.allocUnsafe(output.length * 2);
    output.forEach((sample, index) => {
      result.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
    });
    return result;
  }
}

export class AudioHookPcmPacketizer {
  constructor(frameBytes = 320) {
    this.frameBytes = frameBytes;
    this.pending = Buffer.alloc(0);
  }

  push(buffer) {
    this.pending = Buffer.concat([this.pending, Buffer.from(buffer)]);
    const frames = [];
    while (this.pending.length >= this.frameBytes) {
      frames.push(this.pending.subarray(0, this.frameBytes));
      this.pending = this.pending.subarray(this.frameBytes);
    }
    return frames;
  }

  flush() {
    if (this.pending.length === 0) return [];
    const frame = this.pending;
    this.pending = Buffer.alloc(0);
    return [frame];
  }

  clear() {
    this.pending = Buffer.alloc(0);
  }
}
