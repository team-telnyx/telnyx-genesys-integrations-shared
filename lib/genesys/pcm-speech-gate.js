const DEFAULT_SAMPLE_RATE = 8000;

export function pcm16AudioLevel(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buffer.length < 2) return { rms: 0, peak: 0, durationMs: 0 };

  const completeBytes = buffer.length - (buffer.length % 2);
  const samples = completeBytes / 2;
  let sumSquares = 0;
  let peak = 0;

  for (let offset = 0; offset < completeBytes; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    const magnitude = Math.abs(sample);
    peak = Math.max(peak, magnitude);
    sumSquares += sample * sample;
  }

  return {
    rms: Math.sqrt(sumSquares / samples),
    peak,
    durationMs: (samples / DEFAULT_SAMPLE_RATE) * 1000,
  };
}

export class Pcm16SpeechGate {
  constructor({
    rmsThreshold = 700,
    peakThreshold = 1800,
    minSpeechMs = 40,
  } = {}) {
    this.rmsThreshold = rmsThreshold;
    this.peakThreshold = peakThreshold;
    this.minSpeechMs = minSpeechMs;
    this.voicedMs = 0;
    this.latched = false;
  }

  observe(value) {
    if (this.latched) return false;
    const level = pcm16AudioLevel(value);
    if (level.rms >= this.rmsThreshold && level.peak >= this.peakThreshold) {
      this.voicedMs += level.durationMs;
    } else {
      this.voicedMs = 0;
    }

    if (this.voicedMs < this.minSpeechMs) return false;
    this.latched = true;
    return true;
  }

  reset() {
    this.voicedMs = 0;
    this.latched = false;
  }
}
