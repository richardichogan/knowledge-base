/**
 * syllable-processor-code.ts
 *
 * The AudioWorklet processor source as a string so it can be loaded via
 * Blob URL — this avoids Vite trying to bundle it as a module, which breaks
 * the AudioWorklet global scope (no `import` allowed in worklet context).
 */
export const SYLLABLE_PROCESSOR_CODE = /* javascript */ `
// Tuning constants
const ATTACK_COEFF  = 1 - Math.exp(-1 / (0.030 * 48000 / 128)); // 30ms attack
const RELEASE_COEFF = 1 - Math.exp(-1 / (0.100 * 48000 / 128)); // 100ms release
const MIN_PEAK_INTERVAL_SAMPLES = Math.round(0.080 * 48000);     // 80ms min gap (~12 syl/sec max)

class SyllableProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._envelope = 0;
    this._prevEnvelope = 0;
    this._samplesSincePeak = MIN_PEAK_INTERVAL_SAMPLES; // start ready
    this._envelopeHistory = [];   // max envelope per 128-sample block over 5s
    this._sampleRate = 48000;
  }

  static get parameterDescriptors() { return []; }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    // RMS of this frame
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    // Envelope follower — asymmetric attack/release
    const coeff = rms > this._envelope ? ATTACK_COEFF : RELEASE_COEFF;
    this._envelope += coeff * (rms - this._envelope);

    // Keep 5-second history of envelope values for adaptive threshold
    this._envelopeHistory.push(this._envelope);
    const maxHistory = Math.round(5 * (this._sampleRate / input.length));
    if (this._envelopeHistory.length > maxHistory) this._envelopeHistory.shift();

    // Adaptive threshold from 10th/90th percentiles
    const sorted = [...this._envelopeHistory].sort((a, b) => a - b);
    const noiseFloor  = sorted[Math.floor(sorted.length * 0.10)] ?? 0;
    const peakAverage = sorted[Math.floor(sorted.length * 0.90)] ?? 0;
    const range = peakAverage - noiseFloor;
    // range < 0.02 → not enough dynamic range to distinguish speech → suppress
    // THRESHOLD_FACTOR 0.65 → syllable must be well above noise floor
    const threshold = range < 0.02 ? Infinity : noiseFloor + range * 0.65;

    // Hard absolute floor — reject anything quieter than faint speech
    const ABSOLUTE_MIN_ENVELOPE = 0.015;

    // Peak detection: rising edge crossing threshold + min interval guard
    this._samplesSincePeak += input.length;
    const nowAbove = this._envelope > threshold && this._envelope > ABSOLUTE_MIN_ENVELOPE;
    const wasBelow = this._prevEnvelope <= threshold || this._prevEnvelope <= ABSOLUTE_MIN_ENVELOPE;

    if (nowAbove && wasBelow && this._samplesSincePeak >= MIN_PEAK_INTERVAL_SAMPLES) {
      this._samplesSincePeak = 0;
      this.port.postMessage({ type: 'peak' });
    }

    this._prevEnvelope = this._envelope;
    return true;
  }
}

registerProcessor('syllable-processor', SyllableProcessor);
`;
