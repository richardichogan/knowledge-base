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
 * fallback), matching the client-demo decision. A MockVoiceProvider is
 * provided so the seam is testable without reaching Azure and so the app
 * stays operable locally when Speech credentials aren't configured.
 */

import { env } from '../../config/env.js';

export interface TranscribeRequest {
  /** Base64-encoded audio payload (no data: URL prefix). */
  audioBase64: string;
  /** MIME type of the audio, e.g. 'audio/wav', 'audio/webm', 'audio/mp4'. */
  mimeType: string;
  /** Optional BCP-47 language hint, e.g. 'en-US'. */
  language?: string;
}

export interface TranscribeResult {
  text: string;
  provider: string;
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
 * Mock provider — deterministic, no network. Used when Speech credentials are
 * not configured. Transcription echoes a fixed transcript; synthesis returns a
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

/**
 * Azure Speech Service provider.
 *
 * Uses the Azure Cognitive Services Speech REST API — the same underlying
 * service that backs MAI-Voice-2 and MAI-Transcribe-1.
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
 * STT:  POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
 *       Body: binary audio, headers: Ocp-Apim-Subscription-Key + Content-Type
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
    const audio = Buffer.from(request.audioBase64, 'base64');
    const lang = request.language ?? 'en-US';
    // Map browser MIME type → Content-Type the Speech REST API expects.
    // Safari records audio/mp4; Chrome records audio/webm;codecs=opus; our
    // AudioContext capture path sends audio/wav.
    const mime = request.mimeType || 'audio/wav';
    const contentType = mime.startsWith('audio/wav')
      ? 'audio/wav; codecs=audio/pcm; samplerate=16000'
      : mime.startsWith('audio/ogg')
        ? 'audio/ogg; codecs=opus'
        : mime.startsWith('audio/mp4') || mime.startsWith('audio/mpeg')
          ? 'audio/mp4'
          : 'audio/webm; codecs=opus';

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
    try {
      // Use simple format — detailed format omits top-level DisplayText and
      // puts the transcript under NBest[0].Display instead.
      const url =
        `https://${this.region}.stt.speech.microsoft.com/speech/recognition/conversation` +
        `/cognitiveservices/v1?language=${lang}&format=simple`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.key,
          'Content-Type': contentType,
        },
        body: audio as unknown as BodyInit,
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Azure Speech STT error (${response.status}): ${err}`);
      }
      const data = (await response.json()) as {
        DisplayText?: string;
        RecognitionStatus?: string;
        NBest?: Array<{ Display?: string }>;
      };
      if (data.RecognitionStatus !== undefined && data.RecognitionStatus !== 'Success') {
        throw new Error(`Speech recognition failed: ${data.RecognitionStatus}`);
      }
      // Simple format → DisplayText; detailed format fallback → NBest[0].Display
      const text = data.DisplayText ?? data.NBest?.[0]?.Display ?? '';
      return { text, provider: this.name };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Azure Speech STT timed out after ${VOICE_TIMEOUT_MS}ms`);
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
 * Selects the voice provider.
 * - VOICE_PROVIDER=mock forces the mock (silent WAV, canned transcript)
 * - Otherwise AzureSpeechProvider is used (requires AZURE_SPEECH_KEY or AZURE_OPENAI_API_KEY)
 */
export class VoiceProviderFactory {
  static create(): VoiceProvider {
    if ((env.VOICE_PROVIDER ?? '').toLowerCase() === 'mock') {
      return new MockVoiceProvider();
    }
    if (env.AZURE_SPEECH_KEY === undefined && env.AZURE_OPENAI_API_KEY === undefined) {
      console.warn('[VoiceProviderFactory] No Speech key configured — falling back to mock voice provider');
      return new MockVoiceProvider();
    }
    return new AzureSpeechProvider();
  }
}
