import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractNoteBlockText, scriptSectionContext } from '../src/notes/noteText';

test('RTR-style fixture, persona and acceptance tables reach Athena with row and cell boundaries', () => {
  const cell = (text: string) => ({ type: 'tableCell', content: [{ type: 'text', text }] });
  const rows = [
    ['Case', 'Ledger', 'Support'],
    ['CL-101', '1248600', '1311000'],
    ['CL-102', '800', '800'],
  ].map(values => ({ cells: values.map(cell) }));
  assert.equal(extractNoteBlockText([
    { type: 'heading', content: [{ text: 'Authoritative fixtures' }] },
    { type: 'table', content: { type: 'tableContent', rows } },
    { type: 'paragraph', content: [{ type: 'link', content: [{ text: 'Source' }] }], children: [
      { content: [{ text: 'Nested requirement' }] },
    ] },
  ]), 'Authoritative fixtures\nCase | Ledger | Support\nCL-101 | 1248600 | 1311000\nCL-102 | 800 | 800\nSource\nNested requirement');
});

test('legacy table cells and blank, image and ordinary paragraph blocks remain safe', () => {
  assert.equal(extractNoteBlockText([
    { type: 'image' },
    { content: null },
    { content: [{ text: 'One' }, { text: ' paragraph' }] },
    { type: 'table', content: { rows: [{ cells: [[{ text: 'Legacy' }], []] }] } },
  ]), 'One paragraph\nLegacy |');
});

test('Athena script context includes delivery cues and optional visual colour information', () => {
  const blocks = [{ type: 'paragraph', content: [
    { type: 'text', text: 'Start ' },
    { type: 'text', text: 'here', styles: { textColor: '#3ddbd9' } },
    { type: 'scriptCue', props: { cue: 'pause' } },
    { type: 'text', text: ' next', styles: { textColor: 'pink' } },
    { type: 'scriptCue', props: { cue: 'beat' } },
  ] }];
  assert.equal(extractNoteBlockText(blocks), 'Start here[pause] next[beat]');
  assert.equal(extractNoteBlockText(blocks, undefined, true),
    'Start [colour=teal]here[/colour][pause][colour=pink] next[/colour][beat]');
});

test('Athena receives script heading levels and their spoken content without changing ordinary note text', () => {
  const blocks = [
    { type: 'heading', props: { level: 1 }, content: [{ text: 'Script title' }] },
    { type: 'heading', props: { level: 2 }, content: [{ text: 'Chapter' }], children: [
      { type: 'paragraph', content: [{ text: 'Nested spoken words.' }] },
    ] },
    { type: 'paragraph', content: [{ text: 'More spoken words.' }] },
  ];
  assert.equal(extractNoteBlockText(blocks, undefined, true),
    '# Script title\n## Chapter\nNested spoken words.\nMore spoken words.');
  assert.equal(extractNoteBlockText(blocks), 'Script title\nChapter\nNested spoken words.\nMore spoken words.');
});

test('Script card context exposes stable section IDs and the full spoken body without hidden directions', () => {
  const blocks = [{ id: 'opening', type: 'heading',
    props: { level: 2, scriptSection: true, scriptDirection: 'Warm, then slow down.' },
    content: [{ text: 'Opening' }], children: [{ type: 'paragraph', content: [{ text: 'Actual spoken words.' }] }] }];
  assert.equal(extractNoteBlockText(blocks, undefined, true),
    '## Opening\n[Script section id: opening]\nActual spoken words.');
  assert.equal(extractNoteBlockText(blocks), 'Opening\nActual spoken words.');
});

test('active Script context identifies a deeply nested selection without claiming another section is active', () => {
  const blocks = [{ id: 'section', props: { scriptSection: true }, children: [
    { id: 'list', children: [{ id: 'nested' }] },
  ] }];
  assert.equal(scriptSectionContext(blocks, 'nested', 'selected words'),
    '\n[Active script section id: section]\n[Active block id: nested]\n[No presentation visuals for this section.]\n[Selected script text: selected words]');
  assert.equal(scriptSectionContext(blocks, 'missing', ''), '');
});
