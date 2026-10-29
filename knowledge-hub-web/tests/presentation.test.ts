import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { presentationScript } from '../src/features/autocue/presentationScript';
import { appendVoiceTranscript, finishVoiceTranscript, submitVoiceTranscript } from '../src/services/voiceTranscript';
import { encodeWav, resampleVoiceAudio } from '../src/components/athena/speech';

test('desktop speech selects the available panel, restores earlier handlers and waits for a revealed panel', async () => {
  const bundled = await build({
    stdin: { contents: "export { useDesktopCommand, runDesktopCommand } from './desktopCommands'; export { cleanups } from 'react';",
      resolveDir: fileURLToPath(new URL('../src/services', import.meta.url)) },
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'command-hook-fixture', setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        'export const cleanups = []; export const useRef = value => ({ current: value }); export const useEffect = effect => { cleanups.push(effect()); };' }));
    } }],
  });
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0]!.text, { module, exports: module.exports, setTimeout, Date });
  const { useDesktopCommand: register, runDesktopCommand: run, cleanups } = module.exports as {
    useDesktopCommand: (command: 'speak', handler: () => Promise<void>, available?: () => boolean) => void;
    runDesktopCommand: (command: 'speak') => Promise<void>;
    cleanups: (() => void)[];
  };
  const calls: string[] = [];
  let visible = false;
  try {
    register('speak', async () => { calls.push('current'); });
    register('speak', async () => { calls.push('preserved'); }, () => visible);
    await run('speak');
    assert.deepEqual(calls, ['current']);
    visible = true;
    await run('speak');
    assert.deepEqual(calls, ['current', 'preserved']);
    cleanups.pop()!();
    await run('speak');
    assert.equal(calls.at(-1), 'current');
    cleanups.pop()!();
    visible = false;
    register('speak', async () => { calls.push('revealed'); }, () => visible);
    const pending = run('speak');
    visible = true;
    await pending;
    assert.equal(calls.at(-1), 'revealed');
    register('speak', async () => { throw new Error('Microphone access failed'); });
    await assert.rejects(run('speak'), /Microphone access failed/);
  } finally { for (const cleanup of cleanups) cleanup(); }
});

test('voice resampling delegates rate conversion to Web Audio without dropping input samples', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
  const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  const copied = new Float32Array(samples.length);
  const rendered = new Float32Array([0.2, 0.5]);
  let started = false;
  class OfflineFixture {
    destination = {};
    constructor(channels: number, length: number, rate: number) {
      assert.deepEqual([channels, length, rate], [1, 2, 16000]);
    }
    createBuffer(channels: number, length: number, rate: number) {
      assert.deepEqual([channels, length, rate], [1, 6, 48000]);
      return { getChannelData: () => copied };
    }
    createBufferSource() { return { buffer: null, connect: () => undefined, start: () => { started = true; } }; }
    async startRendering() { assert.ok(started); return { getChannelData: () => rendered }; }
  }
  Object.defineProperty(globalThis, 'OfflineAudioContext', { configurable: true, value: OfflineFixture });
  try {
    assert.equal(await resampleVoiceAudio(samples, 48000, 16000), rendered);
    assert.deepEqual(copied, samples);
    assert.equal(await resampleVoiceAudio(samples, 16000, 16000), samples);
    await assert.rejects(resampleVoiceAudio(new Float32Array(), 48000, 16000), /No valid microphone audio/);
    const wav = new DataView(await encodeWav(rendered, 16000).arrayBuffer());
    assert.equal(wav.getUint32(24, true), 16000);
    assert.equal(wav.getUint32(40, true), rendered.length * 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'OfflineAudioContext', original);
    else Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
  }
});

test('explicit voice review mode preserves the draft; on-screen mode remains send', async () => {
  let draft = 'Existing unsent work';
  let sent = '';
  await finishVoiceTranscript('  dictated text  ', true, text => { draft = appendVoiceTranscript(draft, text); }, async text => { sent = text; });
  assert.equal(draft, 'Existing unsent work\ndictated text');
  assert.equal(sent, '');
  await finishVoiceTranscript('on-screen', false, () => assert.fail('Should not change the draft'), async text => { sent = text; });
  assert.equal(sent, 'on-screen');
  await assert.rejects(finishVoiceTranscript(' ', true, () => assert.fail(), async () => assert.fail()), /No speech/);
});

test('voice submission sends through the composer exactly once, preserving the combined draft if blocked', async () => {
  let draft = 'Current draft';
  const sent: string[] = [];
  await submitVoiceTranscript(' new dictation ', draft, true, value => { draft = value; }, async value => { sent.push(value); });
  assert.deepEqual(sent, ['Current draft\nnew dictation']);
  await assert.rejects(submitVoiceTranscript('next dictation', draft, false, value => { draft = value; }, async () => { assert.fail('Must not send while busy'); }), /in your draft/);
  assert.equal(draft, 'Current draft\nnew dictation\nnext dictation');
  await assert.rejects(submitVoiceTranscript(' ', draft, true, () => assert.fail(), async () => assert.fail()), /No speech/);
  await assert.rejects(submitVoiceTranscript('retained speech', '', true, value => { draft = value; },
    async () => { throw new Error('Send failed'); }), /Send failed/);
  assert.equal(draft, 'retained speech');
});

test('on-screen dictation awaits the shared composer submission and preserves its errors', async () => {
  let draft = 'Existing context';
  const sent: string[] = [];
  const submit = (text: string): Promise<void> => submitVoiceTranscript(text, draft, true,
    value => { draft = value; }, async value => { sent.push(value); });
  await finishVoiceTranscript(' spoken instruction ', false, () => assert.fail('Not review mode'), submit);
  assert.deepEqual(sent, ['Existing context\nspoken instruction']);
  await assert.rejects(finishVoiceTranscript('more speech', false, () => assert.fail(),
    async () => { throw new Error('Composer submission failed'); }), /Composer submission failed/);
});

test('presentation scripts preserve nested order, inline links, lists and table text', () => {
  const blocks = [
    { type: 'heading', content: [{ text: 'Opening' }] },
    { type: 'paragraph', content: [{ text: 'A ' }, { type: 'link', content: [{ text: 'linked phrase' }] }],
      children: [{ type: 'bulletListItem', content: [{ text: 'Nested' }] }] },
    { type: 'numberedListItem', content: [{ text: 'First' }] },
    { type: 'numberedListItem', content: [{ text: 'Second' }] },
    { type: 'table', content: { type: 'tableContent', rows: [{ cells: [[{ text: 'A' }], { type: 'tableCell', content: [{ text: 'B' }] }] }] } },
    { type: 'image', props: { caption: 'Caption' } },
  ];
  const original = JSON.stringify(blocks);
  const result = presentationScript(original);
  assert.equal(result.text, 'Opening\n\nA linked phrase\n\n  - Nested\n\n1. First\n\n2. Second\n\nA | B\n\nCaption');
  assert.equal(result.warnings.length, 1);
  assert.equal(JSON.stringify(blocks), original);
});
test('presentation extraction rejects malformed, excessively large and unsupported documents', () => {
  assert.throws(() => presentationScript('{'));
  assert.throws(() => presentationScript('{}'), /block document/);
  assert.throws(() => presentationScript('[null]'), /invalid block/);
  assert.throws(() => presentationScript(JSON.stringify([{ type: 'table', content: { rows: [{}] } }])), /unsupported table/);
  assert.throws(() => presentationScript(JSON.stringify([{ content: 'a'.repeat(500_001) }])), /500,000/);
  assert.equal(presentationScript('[]').text, '');
});
