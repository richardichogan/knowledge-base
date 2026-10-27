import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playSpeechChunks, type SpeechPlaybackAudio } from '../src/components/athena/speechPlayback';
import { parseVoiceVolume } from '../src/components/athena/voiceVolume';

class AudioFixture extends EventTarget implements SpeechPlaybackAudio {
  volume = 1;
  paused = false;
  started = false;
  constructor(public src: string, private readonly rejectPlay = false) { super(); }
  play(): Promise<void> {
    this.started = true;
    return this.rejectPlay ? Promise.reject(new Error('Autoplay blocked')) : Promise.resolve();
  }
  pause(): void { this.paused = true; }
  end(): void { this.dispatchEvent(new Event('ended')); }
  fail(): void { this.dispatchEvent(new Event('error')); }
}

const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
const speech = (text: string) => ({ audioBase64: Buffer.from(text).toString('base64'), mimeType: 'audio/mpeg' });

test('playback preserves order, prepares only one chunk ahead and applies volume to each chunk', async () => {
  const requested: string[] = [];
  const audio: AudioFixture[] = [];
  let volume = 0.3;
  let current: SpeechPlaybackAudio | null = null;
  const run = playSpeechChunks(['one', 'two', 'three'], (text) => {
    requested.push(text); return Promise.resolve(speech(text));
  }, new AbortController().signal, item => { current = item; if (item) item.volume = volume; },
  source => { const item = new AudioFixture(source); audio.push(item); return item; });
  await tick();
  assert.deepEqual(requested, ['one', 'two']);
  assert.equal(audio.length, 1);
  assert.equal(audio[0]?.volume, 0.3);
  volume = 0;
  if (current) (current as SpeechPlaybackAudio).volume = volume;
  assert.equal(audio[0]?.volume, 0);
  audio[0]?.end();
  await tick();
  assert.deepEqual(requested, ['one', 'two', 'three']);
  assert.equal(audio[1]?.volume, 0);
  assert.equal(audio[0]?.paused, true);
  audio[1]?.end();
  await tick();
  assert.equal(audio[2]?.volume, 0);
  audio[2]?.end();
  await run;
  assert.equal(current, null);
});

test('failed synthesis retries exactly once in order, never silently skips a chunk', async () => {
  const requested: string[] = [];
  const audio: AudioFixture[] = [];
  const run = playSpeechChunks(['one', 'two', 'three'], text => {
    requested.push(text);
    return text === 'two' ? Promise.reject(new Error('Speech unavailable')) : Promise.resolve(speech(text));
  }, new AbortController().signal, () => {}, source => {
    const item = new AudioFixture(source); audio.push(item); return item;
  });
  const rejected = assert.rejects(run, /Speech unavailable/);
  await tick();
  assert.deepEqual(requested, ['one', 'two', 'two']);
  audio[0]?.end();
  await rejected;
  assert.equal(audio.length, 1);
  assert.ok(!requested.includes('three'));
});

test('a transient synthesis failure recovers without repeating or losing spoken chunks', async () => {
  let attempts = 0;
  const audio: AudioFixture[] = [];
  const run = playSpeechChunks(['one'], text => {
    attempts++;
    return attempts === 1 ? Promise.reject(new Error('Temporary error')) : Promise.resolve(speech(text));
  }, new AbortController().signal, () => {}, source => {
    const item = new AudioFixture(source); audio.push(item); return item;
  });
  await tick();
  assert.equal(attempts, 2);
  assert.equal(audio.length, 1);
  audio[0]?.end();
  await run;
});

test('media errors and blocked autoplay reject rather than advancing to the next chunk', async () => {
  for (const blocked of [false, true]) {
    const audio: AudioFixture[] = [];
    const run = playSpeechChunks(['one', 'two'], text => Promise.resolve(speech(text)),
      new AbortController().signal, () => {}, source => {
        const item = new AudioFixture(source, blocked); audio.push(item); return item;
      });
    const rejected = assert.rejects(run, blocked ? /Autoplay blocked/ : /Audio playback failed/);
    await tick();
    if (!blocked) audio[0]?.fail();
    await rejected;
    assert.equal(audio.length, 1);
    assert.equal(audio[0]?.paused, true);
  }
});

test('cancellation stops active audio and never plays late synthesis or retries cancelled requests', async () => {
  const controller = new AbortController();
  const audio: AudioFixture[] = [];
  let requested = 0;
  const run = playSpeechChunks(['one', 'two', 'three'], text => {
    requested++; return Promise.resolve(speech(text));
  }, controller.signal, () => {}, source => {
    const item = new AudioFixture(source); audio.push(item); return item;
  });
  const rejected = assert.rejects(run, { name: 'AbortError' });
  await tick();
  controller.abort();
  await rejected;
  assert.equal(audio[0]?.paused, true);
  assert.equal(audio.length, 1);
  assert.equal(requested, 2);

  const pendingController = new AbortController();
  const pending = playSpeechChunks(['one'], (_text, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
  }), pendingController.signal, () => assert.fail('Cancelled audio must not start'));
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  pendingController.abort();
  await cancelled;
});

test('empty service audio is rejected and saved volumes retain zero without accepting invalid values', async () => {
  await assert.rejects(playSpeechChunks(['one'], () => Promise.resolve({ audioBase64: '', mimeType: 'audio/mpeg' }),
    new AbortController().signal, () => assert.fail()), /no playable audio/);
  assert.equal(parseVoiceVolume('0'), 0);
  assert.equal(parseVoiceVolume('35'), 35);
  assert.equal(parseVoiceVolume('100'), 100);
  for (const invalid of [null, '', 'NaN', '-1', '101', 'Infinity']) assert.equal(parseVoiceVolume(invalid), 100);
});
