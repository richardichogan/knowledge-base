/**
 * SyllableDetector.ts
 *
 * Measures speaking rate (syllables/second) directly from the microphone
 * audio signal using energy-envelope peak detection in an AudioWorklet.
 *
 * No transcription, no machine learning, no network.
 * Latency: ~10ms (one audio worklet frame).
 */

import { SYLLABLE_PROCESSOR_CODE } from './syllable-processor-code';

// ── Tuning constants (exported for runtime tuning) ────────────────────────────

export const ATTACK_MS             = 30;
export const RELEASE_MS            = 100;
export const MIN_PEAK_INTERVAL_MS  = 80;
/** Smaller = faster response, less smooth. */
export const ROLLING_WINDOW_MS     = 800;
export const NOISE_PERCENTILE      = 0.10;
export const PEAK_PERCENTILE       = 0.90;
export const THRESHOLD_FACTOR      = 0.65;
export const MIN_ENVELOPE_RANGE    = 0.02;

// ── Public API ────────────────────────────────────────────────────────────────

export interface SyllableDetectorOptions {
  /** Called every updateIntervalMs with current syllables/second (0 = silence). */
  onRateUpdate: (syllablesPerSecond: number) => void;
  /** How often to fire onRateUpdate. Default 100ms. */
  updateIntervalMs?: number;
}

export class SyllableDetector {
  private onRateUpdate: (sps: number) => void;
  private updateIntervalMs: number;

  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private peakTimestamps: number[] = [];

  constructor(options: SyllableDetectorOptions) {
    this.onRateUpdate     = options.onRateUpdate;
    this.updateIntervalMs = options.updateIntervalMs ?? 100;
  }

  async start(): Promise<void> {
    // Mic
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // AudioContext
    this.audioCtx = new AudioContext();

    // Load worklet via Blob URL (avoids Vite bundling the worklet scope)
    const blob    = new Blob([SYLLABLE_PROCESSOR_CODE], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this.audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    // Connect: mic → worklet → (no output needed)
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'syllable-processor');

    this.workletNode.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'peak') {
        this.peakTimestamps.push(Date.now());
      }
    };

    this.sourceNode.connect(this.workletNode);
    // deliberately NOT connecting workletNode to destination — we don't want audio output

    // Rate update timer
    this.intervalId = setInterval(() => {
      const now         = Date.now();
      const windowStart = now - ROLLING_WINDOW_MS;
      this.peakTimestamps = this.peakTimestamps.filter((t) => t >= windowStart);
      const sps = this.peakTimestamps.length / (ROLLING_WINDOW_MS / 1000);
      this.onRateUpdate(sps);
    }, this.updateIntervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.workletNode  = null;
    this.sourceNode   = null;
    this.stream       = null;
    this.audioCtx     = null;
    this.peakTimestamps = [];
  }
}
