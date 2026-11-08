/**
 * Azure Voice Live relay (`/api/voice/live`).
 *
 * The browser streams microphone audio here and plays back the audio it
 * receives; the Voice Live key never leaves the server. Voice Live listens,
 * transcribes and speaks, but never answers on its own (`create_response:
 * false`): each transcript goes through Athena's normal chat pipeline, and the
 * finished reply comes back here to be spoken word for word as a
 * pre-generated assistant message.
 *
 * Modes:
 *  - conversation: hands-free turns with semantic VAD, transcription and speech.
 *  - dictation: transcription only; nothing is spoken.
 *  - speak: read-aloud only; no microphone.
 *
 * Client → relay: `{type:'auth', token}` first, then `input_audio_buffer.append`,
 * `input_audio_buffer.clear`, `response.cancel` or `{type:'relay.speak', text}`.
 * Relay → client: `{type:'relay.ready'}`, `{type:'relay.error', message}` and the
 * Voice Live server events.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { env } from '../../config/env.js';
import { verifyBearerToken } from '../../middleware/auth.js';

export type VoiceLiveMode = 'conversation' | 'dictation' | 'speak';

const RELAY_PATH = '/api/voice/live';
const AUTH_TIMEOUT_MS = 10_000;
const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
const MAX_SPOKEN_CHARS = 12_000;

function isMode(value: string | null): value is VoiceLiveMode {
  return value === 'conversation' || value === 'dictation' || value === 'speak';
}

function voiceLiveUrl(): string {
  const endpoint = env.VOICE_LIVE_ENDPOINT ?? env.AZURE_OPENAI_ENDPOINT;
  if (endpoint === undefined || endpoint === '') throw new Error('Voice Live is not configured (VOICE_LIVE_ENDPOINT or AZURE_OPENAI_ENDPOINT).');
  const url = new URL('/voice-live/realtime', endpoint);
  url.protocol = 'wss:';
  url.searchParams.set('api-version', env.VOICE_LIVE_API_VERSION);
  url.searchParams.set('profile', env.VOICE_LIVE_PROFILE);
  url.searchParams.set('model', env.VOICE_LIVE_MODEL);
  return url.toString();
}

function voiceLiveKey(): string {
  const key = env.AZURE_SPEECH_KEY ?? env.AZURE_OPENAI_API_KEY;
  if (key === undefined || key === '') throw new Error('Voice Live is not configured (AZURE_SPEECH_KEY or AZURE_OPENAI_API_KEY).');
  return key;
}

/** Voice Live session settings for each mode. */
export function voiceLiveSession(mode: VoiceLiveMode): Record<string, unknown> {
  const listening = mode !== 'speak';
  return {
    instructions: 'You are the voice of Athena. Only speak the assistant messages you are given; never answer on your own.',
    modalities: mode === 'dictation' ? ['text'] : ['text', 'audio'],
    voice: {
      name: env.VOICE_LIVE_VOICE,
      type: 'azure-standard',
      rate: env.VOICE_LIVE_RATE,
      // Temperature is only accepted by HD (Dragon) voices.
      ...(env.VOICE_LIVE_VOICE.includes('DragonHD') ? { temperature: Number(env.VOICE_LIVE_TEMPERATURE) } : {}),
    },
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    input_audio_sampling_rate: 24_000,
    ...(listening ? {
      input_audio_transcription: { model: 'azure-speech', language: env.VOICE_LIVE_LANGUAGE },
      input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
      input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
      turn_detection: {
        type: 'azure_semantic_vad',
        silence_duration_ms: 600,
        remove_filler_words: true,
        create_response: false,
        interrupt_response: mode === 'conversation',
      },
    } : { turn_detection: null }),
  };
}

/** Builds the event that makes Voice Live speak `text` exactly, without model inference. */
export function speakEvent(text: string): Record<string, unknown> {
  return {
    type: 'response.create',
    response: {
      pre_generated_assistant_message: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: text.slice(0, MAX_SPOKEN_CHARS) }],
      },
    },
  };
}

/** Which client events each mode may forward to Voice Live. */
export function allowedClientEvent(mode: VoiceLiveMode, type: unknown): boolean {
  if (type === 'response.cancel') return mode !== 'dictation';
  if (type === 'relay.speak') return mode !== 'dictation';
  if (type === 'input_audio_buffer.append' || type === 'input_audio_buffer.clear') return mode !== 'speak';
  return false;
}

function send(socket: WebSocket, event: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relay(client: WebSocket, mode: VoiceLiveMode): void {
  let upstream: WebSocket | null = null;
  let signedIn = false;
  let ready = false;
  let closed = false;

  const close = (message?: string): void => {
    if (closed) return;
    closed = true;
    if (message !== undefined) send(client, { type: 'relay.error', message });
    if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close();
    if (client.readyState <= WebSocket.OPEN) client.close(message === undefined ? 1000 : 1011);
  };

  const authTimer = setTimeout(() => { close('Voice sign-in timed out.'); }, AUTH_TIMEOUT_MS);

  const connectUpstream = (): void => {
    try {
      upstream = new WebSocket(voiceLiveUrl(), { headers: { 'api-key': voiceLiveKey() } });
    } catch (error) {
      close(errorMessage(error));
      return;
    }
    const azure = upstream;
    azure.on('open', () => { send(azure, { type: 'session.update', session: voiceLiveSession(mode) }); });
    azure.on('message', (data: RawData) => {
      const text = data.toString();
      let event: { type?: string; error?: { message?: string } };
      try { event = JSON.parse(text) as typeof event; } catch { return; }
      if (event.type === 'session.updated' && !ready) {
        ready = true;
        send(client, { type: 'relay.ready', mode });
        return;
      }
      if (event.type === 'error' && !ready) {
        close(`Voice Live rejected the session: ${event.error?.message ?? 'unknown error'}`);
        return;
      }
      if (client.readyState === WebSocket.OPEN) client.send(text);
    });
    azure.on('unexpected-response', (_req, res) => {
      close(`Voice Live connection failed (HTTP ${String(res.statusCode)}).`);
    });
    azure.on('error', (error) => {
      console.error('[voice-live] Upstream error:', errorMessage(error));
      close('Voice Live connection failed.');
    });
    azure.on('close', () => { close(ready ? undefined : 'Voice Live closed the connection before it was ready.'); });
  };

  client.on('message', (data: RawData) => {
    let event: { type?: unknown; token?: unknown; text?: unknown };
    try { event = JSON.parse(data.toString()) as typeof event; } catch { return; }
    if (!signedIn) {
      if (event.type !== 'auth') { close('Voice connection must sign in first.'); return; }
      signedIn = true;
      clearTimeout(authTimer);
      void verifyBearerToken(typeof event.token === 'string' ? event.token : undefined)
        .then(() => { if (!closed) connectUpstream(); })
        .catch(() => { close('Voice sign-in failed. Sign in to Athena again.'); });
      return;
    }
    if (!ready || !upstream || !allowedClientEvent(mode, event.type)) return;
    if (event.type === 'relay.speak') {
      const text = typeof event.text === 'string' ? event.text.trim() : '';
      if (text !== '') send(upstream, speakEvent(text));
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
  });
  client.on('close', () => { clearTimeout(authTimer); close(); });
  client.on('error', () => { clearTimeout(authTimer); close(); });
}

/** Attaches the Voice Live relay to the HTTP server's WebSocket upgrades. */
export function attachVoiceLiveRelay(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const mode = url.searchParams.get('mode');
    if (url.pathname !== RELAY_PATH || !isMode(mode)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => { relay(client, mode); });
  });
}
