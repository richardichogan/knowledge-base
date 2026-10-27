/**
 * Voice layer for the AI chat widget.
 *
 * Ported from IBM-Project-Imagine/client-demo (docs/voice-integration.md,
 * backend/src/services/voice/voiceProvider.ts) — the same pattern already
 * proven against this Azure Speech / Foundry instance. The voice layer sits
 * *on top of* the existing text chat: audio is transcribed to text (STT), the
 * text is sent through the normal /api/ai/chat path, and the reply is
 * synthesised back to audio (TTS). This module only owns the STT/TTS seam —
 * the chat agent has no voice-aware logic.
 *
 * Speech<->text uses the Azure Speech REST API directly (no browser-native
 * fallback). MockVoiceProvider is explicitly opt-in for isolated testing;
 * missing Speech credentials fail rather than substituting invented words.
 */

import { env } from '../../config/env.js';
import { ConfigurationError, IntegrationError, ValidationError } from '../../types/errors.js';

export interface TranscribeRequest {
  /** Base64-encoded audio payload (no data: URL prefix). */
  audioBase64: string;
  /** MIME type of the audio, e.g. 'audio/wav', 'audio/webm', 'audio/mp4'. */
  mimeType: string;
  /** BCP-47 language hint; defaults to UK English (en-GB). */
  language?: string;
  /** Duration of the uploaded recording, used to reject incomplete processing. */
  durationMilliseconds?: number;
}

export interface TranscribeResult {
  text: string;
  provider: string;
  durationMilliseconds?: number;
}

export interface SynthesizeRequest {
  text: string;
  /** Optional named voice; provider chooses a sensible default otherwise. */
  voice?: string;
}

export interface SynthesizeResult {
  audioBase64: string;
  mimeType: string;
  provider: string;
}

export interface VoiceProvider {
  name: string;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  synthesize(request: SynthesizeRequest): Promise<SynthesizeResult>;
}

/**
 * Mock provider — deterministic, no network. Enabled only by VOICE_PROVIDER=mock.
 * Transcription echoes a fixed transcript; synthesis returns a
 * tiny silent WAV so the playback path is exercisable end-to-end.
 */
export class MockVoiceProvider implements VoiceProvider {
  name = 'Mock Voice';

  // eslint-disable-next-line @typescript-eslint/require-await
  async transcribe(_request: TranscribeRequest): Promise<TranscribeResult> {
    return {
      text: 'This is a mock transcript — set AZURE_SPEECH_KEY (or AZURE_OPENAI_API_KEY) to use real Azure Speech.',
      provider: this.name,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    // 100ms of 8kHz 8-bit mono silence (800 zero bytes) wrapped in a valid WAV.
    // A 0-byte data chunk is rejected by some browsers, so we need at least some samples.
    const sampleRate = 8000;
    const durationMs = 100;
    const numSamples = Math.floor((sampleRate * durationMs) / 1000); // 800
    const pcm = Buffer.alloc(numSamples, 128); // 128 = silence in unsigned 8-bit PCM

    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + numSamples, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate, 28); // byte rate (1 byte/sample * 8000 samples/s)
    header.writeUInt16LE(1, 32); // block align
    header.writeUInt16LE(8, 34); // bits per sample
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(numSamples, 40);
    void request.text;
    return {
      audioBase64: Buffer.concat([header, pcm]).toString('base64'),
      mimeType: 'audio/wav',
      provider: this.name,
    };
  }
}

function speechApiKey(): string {
  // The multi-service Azure AI Services key also covers the Speech REST API —
  // AZURE_SPEECH_KEY falls back to the existing AZURE_OPENAI_API_KEY when a
  // dedicated Speech key hasn't been set separately.
  const key = env.AZURE_SPEECH_KEY ?? env.AZURE_OPENAI_API_KEY;
  if (key === undefined) throw new Error('AZURE_SPEECH_KEY (or AZURE_OPENAI_API_KEY) not set');
  return key;
}

const VOICE_TIMEOUT_MS = 60_000;
const STT_DURATION_TOLERANCE_MS = 1_000;
const BASE64_BLOCK_CHARS = 4;

function transcribedAudio(data: unknown, expectedDuration?: number): TranscribeResult {
  if (typeof data !== 'object' || data === null || !('durationMilliseconds' in data)
    || typeof data.durationMilliseconds !== 'number' || !Number.isFinite(data.durationMilliseconds)
    || data.durationMilliseconds <= 0 || !('combinedPhrases' in data) || !Array.isArray(data.combinedPhrases)) {
    throw new IntegrationError('Azure Speech', 'Transcription returned an invalid full-recording result.');
  }
  if (expectedDuration !== undefined && Math.abs(data.durationMilliseconds - expectedDuration) > STT_DURATION_TOLERANCE_MS) {
    throw new IntegrationError('Azure Speech', 'The complete recording was not processed. No partial transcript was sent.');
  }
  const text = data.combinedPhrases.map((phrase: unknown) => {
    if (typeof phrase !== 'object' || phrase === null || !('text' in phrase) || typeof phrase.text !== 'string') {
      throw new IntegrationError('Azure Speech', 'Transcription returned an invalid phrase.');
    }
    return phrase.text.trim();
  }).filter(Boolean).join('\n');
  if (!text) throw new ValidationError('No speech was recognised. Your existing draft is unchanged.');
  return { text, provider: 'Azure Speech (fast transcription)', durationMilliseconds: data.durationMilliseconds };
}

/**
 * Azure Speech Service provider.
 *
 * Uses Azure Speech fast transcription for the complete recording.
 * No MAI or enhanced transcription model is implicitly selected.
 *
 * MAI-Voice-2 is the preferred TTS voice (`en-US-Harper:MAI-Voice-2` by
 * default, via AZURE_SPEECH_VOICE). It uses the same cognitiveservices/v1
 * endpoint as all Azure Neural voices — only the SSML voice name and output
 * format differ. If MAI voices are not enabled on the resource, synthesize()
 * auto-retries with AZURE_SPEECH_FALLBACK_VOICE (en-US-SaraNeural by default) and logs a warning.
 *
 * TTS:  POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *       Body: SSML with mstts namespace, headers: Ocp-Apim-Subscription-Key + X-Microsoft-OutputFormat
 *
 * STT:  POST https://{region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe
 *       Multipart audio and definition; all recognised phrases are retained.
 */
export class AzureSpeechProvider implements VoiceProvider {
  name = 'Azure Speech';

  private get region(): string {
    return env.AZURE_SPEECH_REGION;
  }

  private get key(): string {
    return speechApiKey();
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    if (!request.audioBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(request.audioBase64) || request.audioBase64.length % BASE64_BLOCK_CHARS !== 0) {
      throw new ValidationError('Provide a complete base64-encoded audio recording.');
    }
    const audio = Buffer.from(request.audioBase64, 'base64');
    const lang = request.language ?? 'en-GB';
    if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})+$/.test(lang)) throw new ValidationError('Provide a valid speech locale, such as en-GB.');
    if (request.durationMilliseconds !== undefined
      && (!Number.isFinite(request.durationMilliseconds) || request.durationMilliseconds <= 0)) {
      throw new ValidationError('Recording duration must be a positive number of milliseconds.');
    }
    const mime = request.mimeType.split(';')[0]?.trim().toLowerCase();
    const extensions: Record<string, string> = { 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/webm': 'webm' };
    const extension = mime ? extensions[mime] : undefined;
    if (!mime || !extension) throw new ValidationError('Unsupported recording format. Use WAV, OGG, MP4, MP3 or WebM audio.');
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(audio)], { type: mime }), `recording.${extension}`);
    form.append('definition', JSON.stringify({ locales: [lang] }));

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
    try {
      const url = `https://${this.region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.key,
          'Accept': 'application/json',
        },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        console.error(`[AzureSpeechProvider] Fast transcription failed (HTTP ${response.status}).`);
        throw new IntegrationError('Azure Speech', `Full-recording transcription failed (HTTP ${response.status}). No partial transcript was sent.`);
      }
      return transcribedAudio(await response.json(), request.durationMilliseconds);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new IntegrationError('Azure Speech', 'Full-recording transcription timed out. No partial transcript was sent.');
      }
      throw error;
    } finally {
      clearTimeout(tid);
    }
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    // MAI-Voice-2 is the preferred voice (same cognitiveservices/v1 endpoint, different SSML voice name).
    // Falls back to AZURE_SPEECH_FALLBACK_VOICE automatically if MAI voices are not enabled on the resource.
    const preferredVoice = request.voice ?? env.AZURE_SPEECH_VOICE;
    const isMaiVoice = preferredVoice.includes('MAI-Voice');

    // MAI voices support 24khz 160kbps; standard neural voices use 16khz 32kbps on multi-service keys.
    const preferredFormat = isMaiVoice ? 'audio-24khz-160kbitrate-mono-mp3' : 'audio-16khz-32kbitrate-mono-mp3';

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
    try {
      const result = await this.callTts(preferredVoice, preferredFormat, prepareTtsText(request.text), controller.signal);
      return { ...result, provider: `${this.name} (${preferredVoice})` };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Azure Speech TTS timed out after ${VOICE_TIMEOUT_MS}ms`);
      }
      // MAI voices return 400 when not enabled on the resource — auto-retry with the configured fallback voice.
      if (isMaiVoice && err instanceof Error && err.message.includes('400')) {
        const fallbackVoice = env.AZURE_SPEECH_FALLBACK_VOICE;
        console.warn(`[AzureSpeechProvider] ${preferredVoice} not available on this resource — falling back to ${fallbackVoice}`);
        clearTimeout(tid);
        const fallbackController = new AbortController();
        const fallbackTid = setTimeout(() => fallbackController.abort(), VOICE_TIMEOUT_MS);
        try {
          const result = await this.callTts(fallbackVoice, 'audio-16khz-32kbitrate-mono-mp3', prepareTtsText(request.text), fallbackController.signal);
          return { ...result, provider: `${this.name} (${fallbackVoice}, MAI fallback)` };
        } finally {
          clearTimeout(fallbackTid);
        }
      }
      throw err;
    } finally {
      clearTimeout(tid);
    }
  }

  private async callTts(voice: string, outputFormat: string, text: string, signal: AbortSignal): Promise<Omit<SynthesizeResult, 'provider'>> {
    // Full SSML with mstts namespace — MAI-Voice-2 uses mstts:express-as for style control.
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
      `xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">` +
      `<voice name="${voice}">${escapeXml(text)}</voice></speak>`;

    const response = await fetch(
      `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': outputFormat,
          'User-Agent': 'KnowledgeHub/1.0',
        },
        body: Buffer.from(ssml, 'utf8') as unknown as BodyInit,
        signal,
      },
    );
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Azure Speech TTS error (${response.status}): ${err}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { audioBase64: buffer.toString('base64'), mimeType: 'audio/mpeg' };
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const TTS_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`;
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 10;
  return `${n}${s[v] ?? 'th'}`;
}

/**
 * Pre-process text before sending to TTS so ISO dates are spoken naturally.
 * "2026-06-08" → "the 8th of June 2026"
 */
export function prepareTtsText(text: string): string {
  return text
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, yyyy: string, mm: string, dd: string) => {
      const month = TTS_MONTH_NAMES[parseInt(mm, 10) - 1];
      if (month === undefined) return match;
      return `the ${ordinal(parseInt(dd, 10))} of ${month} ${yyyy}`;
    })
    .trim();
}

/**
 * gpt-4o-mini-tts (Azure OpenAI audio/speech) for spoken replies — a more
 * natural voice whose tone is steered by plain-English instructions.
 * Transcription stays on Azure Speech, and synthesis falls back to it if the
 * TTS call fails (e.g. a reply longer than the model's input limit).
 */
export class OpenAiTtsProvider implements VoiceProvider {
  name = 'gpt-4o-mini-tts';
  private readonly fallback = new AzureSpeechProvider();

  transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    return this.fallback.transcribe(request);
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResult> {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
    try {
      const response = await fetch(env.AZURE_TTS_ENDPOINT ?? '', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': env.AZURE_TTS_API_KEY ?? '' },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          input: prepareTtsText(request.text),
          voice: env.AZURE_TTS_VOICE,
          instructions: env.AZURE_TTS_INSTRUCTIONS,
          response_format: 'mp3',
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`gpt-4o-mini-tts error (${response.status}): ${await response.text()}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return { audioBase64: buffer.toString('base64'), mimeType: 'audio/mpeg', provider: `${this.name} (${env.AZURE_TTS_VOICE})` };
    } catch (err) {
      console.warn(`[OpenAiTtsProvider] ${err instanceof Error ? err.message : String(err)} — falling back to Azure Speech`);
      return this.fallback.synthesize(request);
    } finally {
      clearTimeout(tid);
    }
  }
}

/**
 * Selects the voice provider.
 * - VOICE_PROVIDER=mock forces the mock (silent WAV, canned transcript)
 * - AZURE_TTS_ENDPOINT + AZURE_TTS_API_KEY set → OpenAiTtsProvider (Azure Speech fallback)
 * - Otherwise AzureSpeechProvider is used (requires AZURE_SPEECH_KEY or AZURE_OPENAI_API_KEY)
 */
export class VoiceProviderFactory {
  static create(): VoiceProvider {
    if ((env.VOICE_PROVIDER ?? '').toLowerCase() === 'mock') {
      return new MockVoiceProvider();
    }
    if (env.AZURE_SPEECH_KEY === undefined && env.AZURE_OPENAI_API_KEY === undefined) {
      throw new ConfigurationError('AZURE_SPEECH_KEY (or AZURE_OPENAI_API_KEY)');
    }
    if (env.AZURE_TTS_ENDPOINT !== undefined && env.AZURE_TTS_API_KEY !== undefined) {
      return new OpenAiTtsProvider();
    }
    return new AzureSpeechProvider();
  }
}
