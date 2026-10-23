import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractNoteBlockText } from '../src/notes/noteText';

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
