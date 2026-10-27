import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/voice';
process.env.AZURE_SPEECH_KEY = 'fixture';
process.env.AZURE_SPEECH_REGION = 'uksouth';
const { AzureSpeechProvider, VoiceProviderFactory } = await import('../src/services/voice/voiceProvider.js');
const { env } = await import('../src/config/env.js');
const request = { audioBase64: Buffer.from('audio fixture').toString('base64'), mimeType: 'audio/wav', durationMilliseconds: 125000 };

test('full-recording transcription uses UK English and retains all combined phrases beyond sixty seconds', async () => {
  const fetch = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://uksouth.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    assert.ok(init.body instanceof FormData);
    assert.deepEqual(JSON.parse(String(init.body.get('definition'))), { locales: ['en-GB'] });
    const audio = init.body.get('audio');
    assert.ok(audio instanceof Blob);
    assert.equal(audio.type, 'audio/wav');
    assert.equal(Buffer.from(await audio.arrayBuffer()).toString('base64'), request.audioBase64);
    return Response.json({ durationMilliseconds: 125000, combinedPhrases: [{ text: 'First sentence.' }, { text: 'The final sentence after a pause.' }] });
  });
  try {
    assert.deepEqual(await new AzureSpeechProvider().transcribe(request), {
      text: 'First sentence.\nThe final sentence after a pause.', provider: 'Azure Speech (fast transcription)', durationMilliseconds: 125000,
    });
    assert.equal(fetch.mock.callCount(), 1);
  } finally { fetch.mock.restore(); }
});

test('incomplete processing, empty speech and malformed responses cannot become sent transcripts', async () => {
  for (const result of [
    { durationMilliseconds: 60000, combinedPhrases: [{ text: 'Only the beginning.' }] },
    { durationMilliseconds: 125000, combinedPhrases: [] },
    { durationMilliseconds: 125000, combinedPhrases: [{ text: 42 }] },
    { DisplayText: 'Legacy partial result.', RecognitionStatus: 'Success' },
  ]) {
    const fetch = mock.method(globalThis, 'fetch', async () => Response.json(result));
    try { await assert.rejects(new AzureSpeechProvider().transcribe(request), /complete recording|No speech|invalid/); }
    finally { fetch.mock.restore(); }
  }
});

test('provider failures do not fall back to short-audio recognition or canned words', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  try {
    await assert.rejects(new AzureSpeechProvider().transcribe(request), /HTTP 503/);
    assert.equal(fetch.mock.callCount(), 1);
  } finally { fetch.mock.restore(); }
  const key = mock.getter(env, 'AZURE_SPEECH_KEY', () => undefined);
  const fallbackKey = mock.getter(env, 'AZURE_OPENAI_API_KEY', () => undefined);
  const provider = env.VOICE_PROVIDER;
  try {
    env.VOICE_PROVIDER = undefined;
    assert.throws(() => VoiceProviderFactory.create(), /Missing required configuration/);
  } finally {
    key.mock.restore();
    fallbackKey.mock.restore();
    env.VOICE_PROVIDER = provider;
  }
});

test('invalid recording metadata is rejected before contacting Speech', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('Must not contact Speech'); });
  try {
    for (const change of [{ audioBase64: 'not base64!' }, { durationMilliseconds: -1 }, { language: 'invalid' }, { mimeType: 'text/plain' }]) {
      await assert.rejects(new AzureSpeechProvider().transcribe({ ...request, ...change }), /recording|duration|locale|format/);
    }
    assert.equal(fetch.mock.callCount(), 0);
  } finally { fetch.mock.restore(); }
});
