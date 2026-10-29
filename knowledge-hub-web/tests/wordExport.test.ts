import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';

test('Word export retains formatting and link labels without hyperlink targets', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: () => null },
  } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const { createWordExport } = await import('../src/notes/wordExport');
  const { setLinkLabel } = await import('../src/notes/linkLabels');
  setLinkLabel('note', 'linked-note', 'Meeting notes');
  const blob = await createWordExport([
    { type: 'heading', props: { level: 1 }, content: [{ text: 'Process review' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'Bold ', styles: { bold: true } },
      { type: 'text', text: 'Italic ', styles: { italic: true } },
      { type: 'link', href: 'https://example.com/private-target', content: [
        { type: 'text', text: 'Source label', styles: { bold: true } },
      ] },
      { type: 'noteMention', props: { noteId: 'linked-note' } },
    ] },
    { type: 'numberedListItem', content: [{ text: 'First step' }], children: [
      { type: 'bulletListItem', content: [{ text: 'Nested point' }] },
    ] },
    { type: 'table', content: { headerRows: 1, rows: [
      { cells: [[{ text: 'Header' }]] },
      { cells: [{ type: 'tableCell', content: [{ text: 'Value' }] }] },
    ] } },
  ], 'Process review');
  const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const xml = strFromU8(zip['word/document.xml']!);
  const relationships = strFromU8(zip['word/_rels/document.xml.rels']!);
  for (const text of ['Process review', 'Bold', 'Italic', 'Source label', 'Meeting notes', 'Nested point', 'Header', 'Value']) {
    assert.ok(xml.includes(text), text);
  }
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /<w:i\/>/);
  assert.match(xml, /<w:numPr>/);
  assert.match(xml, /<w:tbl>/);
  assert.doesNotMatch(xml, /w:hyperlink|private-target/);
  assert.doesNotMatch(relationships, /relationships\/hyperlink|private-target/);
  assert.equal(xml.match(/Process review/g)?.length, 1, 'Do not duplicate the document title');
});
