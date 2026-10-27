import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentationScript } from '../src/features/autocue/presentationScript';
import { appendVoiceTranscript, finishVoiceTranscript, finishDesktopVoiceTranscript } from '../src/services/voiceTranscript';
import { encodeWav, resampleVoiceAudio } from '../src/components/athena/speech';

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

test('explicit voice review mode preserves the draft; on-screen mode remains send', () => {
  let draft = 'Existing unsent work';
  let sent = '';
  finishVoiceTranscript('  dictated text  ', true, text => { draft = appendVoiceTranscript(draft, text); }, text => { sent = text; });
  assert.equal(draft, 'Existing unsent work\ndictated text');
  assert.equal(sent, '');
  finishVoiceTranscript('on-screen', false, () => assert.fail('Should not change the draft'), text => { sent = text; });
  assert.equal(sent, 'on-screen');
  assert.throws(() => finishVoiceTranscript(' ', true, () => assert.fail(), () => assert.fail()), /No speech/);
});

test('stopping desktop speech sends the transcript with the current draft exactly once, preserving it if blocked', async () => {
  let draft = 'Current draft';
  const sent: string[] = [];
  await finishDesktopVoiceTranscript(' new dictation ', draft, true, value => { draft = value; }, async value => { sent.push(value); });
  assert.deepEqual(sent, ['Current draft\nnew dictation']);
  await assert.rejects(finishDesktopVoiceTranscript('next dictation', draft, false, value => { draft = value; }, async () => { assert.fail('Must not send while busy'); }), /in your draft/);
  assert.equal(draft, 'Current draft\nnew dictation\nnext dictation');
  await assert.rejects(finishDesktopVoiceTranscript(' ', draft, true, () => assert.fail(), async () => assert.fail()), /No speech/);
  await assert.rejects(finishDesktopVoiceTranscript('retained speech', '', true, value => { draft = value; },
    async () => { throw new Error('Send failed'); }), /Send failed/);
  assert.equal(draft, 'retained speech');
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
