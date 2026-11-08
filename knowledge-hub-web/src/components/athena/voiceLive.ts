import { voiceLiveConnection } from '../../services/api';
import { microphoneLevel } from '../../chat/athenaMotion';
import { nextSpeechId } from './streamedSpeech';

export type VoiceLiveMode = 'conversation' | 'dictation' | 'speak';

export interface VoiceLiveHandlers {
  /** A finished transcript of something the user said. */
  onTranscript?: (text: string) => void;
  /** The user started talking (Athena stops speaking). */
  onSpeechStarted?: () => void;
  /** Athena's audio started or finished playing. */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Microphone level, 0–1, for the presence dots. */
  onLevel?: (level: number) => void;
  /** The connection failed or closed unexpectedly. */
  onError?: (message: string) => void;
  /** The session ended (after `close()` or an error). */
  onClosed?: () => void;
}

const SAMPLE_RATE = 24_000;
const READY_TIMEOUT_MS = 15_000;
/** How long to wait for Voice Live to confirm a cancelled piece before speaking the next. */
const CANCEL_SETTLE_MS = 2_000;

function base64FromPcm(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function pcmFromBase64(data: string): Float32Array {
  const binary = atob(data);
  const samples = new Float32Array(binary.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
  }
  return samples;
}

/**
 * One Azure Voice Live session through the backend relay: streams the
 * microphone (conversation and dictation), reports transcripts and plays
 * Athena's spoken replies. Athena's answers themselves come from the normal
 * chat pipeline; `speak()` only voices finished text.
 */
export class VoiceLiveSession {
  readonly mode: VoiceLiveMode;
  private readonly handlers: VoiceLiveHandlers;
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  /** Audio being played, with the spoken piece it belongs to and when it ends. */
  private sources = new Map<AudioBufferSourceNode, { id: number; end: number }>();
  /** Pieces waiting to be spoken; Voice Live speaks one response at a time. */
  private queue: Array<{ text: string; id: number }> = [];
  /** The piece Voice Live is generating now. */
  private active: number | null = null;
  /** Audio for this piece is dropped (it was cancelled while generating). */
  private dropping: number | null = null;
  private settleTimer: number | undefined;
  private playhead = 0;
  private speaking = false;
  private closed = false;
  private volume: number;

  constructor(mode: VoiceLiveMode, handlers: VoiceLiveHandlers, volume: number) {
    this.mode = mode;
    this.handlers = handlers;
    this.volume = volume;
  }

  get isOpen(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }

  /** Connects, signs in and (except in speak mode) starts the microphone. */
  async start(): Promise<void> {
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new AudioContextCtor({ sampleRate: SAMPLE_RATE });
    await this.context.resume();
    this.gain = this.context.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.context.destination);
    try {
      if (this.mode !== 'speak') {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }
    } catch {
      this.close();
      throw new Error('Could not access the microphone. Check your browser permissions and try again.');
    }
    await this.connect();
    if (this.stream) this.startMicrophone(this.stream);
  }

  private async connect(): Promise<void> {
    const { url, token } = await voiceLiveConnection(this.mode);
    if (this.closed) throw new Error('Voice session was closed.');
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let ready = false;
      const timer = window.setTimeout(() => {
        reject(new Error('Voice Live did not respond. Try again in a moment.'));
        this.close();
      }, READY_TIMEOUT_MS);
      socket.onopen = () => { socket.send(JSON.stringify({ type: 'auth', token })); };
      socket.onmessage = (message: MessageEvent<string>) => {
        let event: { type?: string; message?: string; delta?: string; transcript?: string; error?: { message?: string } };
        try { event = JSON.parse(message.data) as typeof event; } catch { return; }
        if (event.type === 'relay.ready') {
          ready = true;
          window.clearTimeout(timer);
          resolve();
          return;
        }
        if (event.type === 'relay.error') {
          const text = event.message ?? 'Voice Live failed.';
          window.clearTimeout(timer);
          if (!ready) reject(new Error(text));
          else this.fail(text);
          return;
        }
        this.handleEvent(event);
      };
      socket.onerror = () => {
        if (!ready) {
          window.clearTimeout(timer);
          reject(new Error('Could not connect to Voice Live. Check the Athena server is running.'));
        }
      };
      socket.onclose = () => {
        window.clearTimeout(timer);
        if (!ready) reject(new Error('Voice Live closed the connection.'));
        else if (!this.closed) this.fail('Voice Live disconnected.');
      };
    });
  }

  private handleEvent(event: { type?: string; delta?: string; transcript?: string; error?: { message?: string } }): void {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.stopSpeaking();
        this.handlers.onSpeechStarted?.();
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = event.transcript?.trim() ?? '';
        if (text !== '') this.handlers.onTranscript?.(text);
        break;
      }
      case 'response.audio.delta':
        if (event.delta && this.active !== null && this.active !== this.dropping) this.play(pcmFromBase64(event.delta), this.active);
        break;
      case 'response.done':
        this.responseFinished();
        break;
      case 'error':
        if (event.error?.message && !/no active response|cancel/i.test(event.error.message)) {
          console.warn('[Voice Live]', event.error.message);
          // A failed piece never sends response.done; move on to the next.
          if (this.active !== null && this.active !== this.dropping) this.responseFinished();
        }
        break;
      default:
        break;
    }
  }

  private startMicrophone(stream: MediaStream): void {
    const context = this.context;
    if (!context) return;
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but gives synchronous PCM everywhere Athena runs.
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      const samples = e.inputBuffer.getChannelData(0);
      this.handlers.onLevel?.(microphoneLevel(samples));
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64FromPcm(samples) }));
      }
    };
    source.connect(processor);
    processor.connect(context.destination);
    this.processor = processor;
  }

  private play(samples: Float32Array, id: number): void {
    const context = this.context;
    if (!context || !this.gain || samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.playhead = Math.max(this.playhead, context.currentTime + 0.05);
    source.start(this.playhead);
    this.playhead += buffer.duration;
    this.sources.set(source, { id, end: this.playhead });
    this.setSpeaking(true);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.setSpeaking(false);
    };
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.handlers.onSpeakingChange?.(speaking);
  }

  /** Speaks `text` word for word in Athena's voice, after anything already queued. */
  speak(text: string, id = nextSpeechId()): void {
    const clean = text.trim();
    if (clean === '' || this.mode === 'dictation' || this.closed) return;
    this.queue.push({ text: clean, id });
    this.pump();
  }

  private pump(): void {
    if (this.active !== null || this.socket?.readyState !== WebSocket.OPEN) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next.id;
    this.socket.send(JSON.stringify({ type: 'relay.speak', text: next.text }));
  }

  private responseFinished(): void {
    window.clearTimeout(this.settleTimer);
    this.active = null;
    this.dropping = null;
    this.pump();
  }

  /** Stops the piece with this id and everything after it; earlier pieces carry on. */
  cancelFrom(id: number): void {
    this.queue = this.queue.filter(piece => piece.id < id);
    if (this.active !== null && this.active >= id && this.dropping !== this.active) {
      this.dropping = this.active;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'response.cancel' }));
      window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => { this.responseFinished(); }, CANCEL_SETTLE_MS);
    }
    for (const [source, piece] of this.sources) {
      if (piece.id < id) continue;
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
      this.sources.delete(source);
    }
    this.playhead = Math.max(0, ...[...this.sources.values()].map(piece => piece.end));
    if (this.sources.size === 0) this.setSpeaking(false);
  }

  /** Stops anything Athena is saying now. */
  stopSpeaking(): void {
    this.cancelFrom(0);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.handlers.onError?.(message);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSpeaking();
    window.clearTimeout(this.settleTimer);
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach(track => { track.stop(); });
    this.stream = null;
    this.handlers.onLevel?.(0);
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    this.handlers.onClosed?.();
  }
}
