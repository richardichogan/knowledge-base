import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentationScript } from '../src/features/autocue/presentationScript';
import { appendVoiceTranscript, finishVoiceTranscript } from '../src/services/voiceTranscript';

test('Stream Deck transcription appends to a draft and never sends; on-screen mode remains send', () => {
  let draft = 'Existing unsent work';
  let sent = '';
  finishVoiceTranscript('  dictated text  ', true, text => { draft = appendVoiceTranscript(draft, text); }, text => { sent = text; });
  assert.equal(draft, 'Existing unsent work\ndictated text');
  assert.equal(sent, '');
  finishVoiceTranscript('on-screen', false, () => assert.fail('Should not change the draft'), text => { sent = text; });
  assert.equal(sent, 'on-screen');
  assert.throws(() => finishVoiceTranscript(' ', true, () => assert.fail(), () => assert.fail()), /No speech/);
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
  assert.equal(result.text, 'Opening\nA linked phrase\n- Nested\n1. First\n2. Second\nA | B\nCaption');
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
