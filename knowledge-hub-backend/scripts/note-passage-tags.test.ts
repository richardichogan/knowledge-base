import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notePassageTags } from '../src/utils/notePassageTags.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const writing = (blocks: unknown): string => JSON.stringify({
  title: 'Example', contentType: 'note', contentJson: JSON.stringify(blocks),
});

test('passage identities survive formatting splits, overlaps, links and nested blocks', () => {
  const content = writing([{ type: 'paragraph', content: [
    { type: 'text', text: 'Repeated ', styles: { important: first, bold: true } },
    { type: 'link', href: 'https://example.test', content: [
      { type: 'text', text: 'word', styles: { important: first, question: second } },
    ] },
    { type: 'text', text: ' repeated word', styles: {} },
  ], children: [{ type: 'paragraph', content: [
    { type: 'text', text: ' again', styles: { important: first } },
  ] }] }]);
  assert.deepEqual(notePassageTags(content), [
    { id: first, kind: 'important', label: 'Important', text: 'Repeated word again' },
    { id: second, kind: 'question', label: 'Question', text: 'word' },
  ]);
});

test('deleted text and untagged repeated text are not returned', () => {
  assert.deepEqual(notePassageTags(writing([{ type: 'paragraph', content: [
    { type: 'text', text: '', styles: { followUp: first } },
    { type: 'text', text: 'Same words', styles: {} },
  ] }])), []);
  assert.deepEqual(notePassageTags('not JSON'), []);
});
