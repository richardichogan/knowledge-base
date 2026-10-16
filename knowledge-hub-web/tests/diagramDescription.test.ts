import assert from 'node:assert/strict';
import { test } from 'node:test';
import { descriptionPlainText, descriptionRuns, formatDescription, wrapDescription } from '../src/features/diagram/diagramDescription';
import { addFootnote, footnoteBlock } from '../src/features/diagram/diagramAnnotations';
import { emptyDiagram, type DiagramNode } from '../src/features/diagram/diagramTypes';
import { diagramDrawioXml } from '../src/features/diagram/diagramDrawio';
import { DIAGRAM_FILLS, DIAGRAM_STROKES, IBM_COLOURS } from '../src/features/diagram/diagramPalette';
import { diagramEditorNodeColours } from '../src/features/diagram/diagramTheme';

test('descriptions preserve plain text and safely represent markup as text', () => {
  const text = '<script>alert("test")</script> & an unmatched * or **';
  assert.equal(descriptionPlainText(text), text);
  assert.equal(descriptionPlainText('one\\* literal star'), 'one* literal star');
});
test('bold, italic, combined and nested emphasis become styled runs', () => {
  assert.deepEqual(descriptionRuns('**Bold** and *italic*'), [
    { text: 'Bold', bold: true, italic: false }, { text: ' and ', bold: false, italic: false }, { text: 'italic', bold: false, italic: true },
  ]);
  assert.deepEqual(descriptionRuns('***Both***'), [{ text: 'Both', bold: true, italic: true }]);
  assert.deepEqual(descriptionRuns('**Bold *both* bold**'), [
    { text: 'Bold ', bold: true, italic: false }, { text: 'both', bold: true, italic: true }, { text: ' bold', bold: true, italic: false },
  ]);
  assert.equal(descriptionPlainText('*italic **both***'), 'italic both');
  assert.equal(descriptionPlainText('**unclosed\nplain**'), '**unclosed\nplain**');
});
test('format buttons wrap, unwrap and combine emphasis with stable selection', () => {
  const bold = formatDescription('Hello world', 6, 11, 'bold');
  assert.deepEqual(bold, { text: 'Hello **world**', start: 8, end: 13 });
  assert.deepEqual(formatDescription(bold.text, bold.start, bold.end, 'bold'), { text: 'Hello world', start: 6, end: 11 });
  const both = formatDescription('**world**', 2, 7, 'italic');
  assert.equal(both.text, '***world***');
  assert.equal(formatDescription(both.text, both.start, both.end, 'italic').text, '**world**');
  assert.deepEqual(formatDescription('', 0, 0, 'italic'), { text: '**', start: 1, end: 1 });
  const multiline = formatDescription('First\n  Second\n\nThird', 0, 22, 'bold');
  assert.equal(multiline.text, '**First**\n  **Second**\n\n**Third**');
  assert.equal(descriptionPlainText(multiline.text), 'First\n  Second\n\nThird');
  assert.equal(formatDescription(multiline.text, multiline.start, multiline.end, 'bold').text, 'First\n  Second\n\nThird');
});
test('wrapping retains styled text across whitespace, long words and paragraphs', () => {
  const lines = wrapDescription('**Alpha   beta gamma**\n*longwordabcdefghijk*', 65, 12);
  assert.equal(lines.map(line => line.text).join(' ').replace(/\s/g, ''), 'Alphabetagammalongwordabcdefghijk');
  assert.ok(lines.every(line => line.runs.map(run => run.text).join('') === line.text));
  assert.ok(lines[0]!.runs.every(run => run.bold));
  assert.ok(lines.at(-1)!.runs.every(run => run.italic));
});
test('footnotes and draw.io retain emphasis without literal Markdown markers', () => {
  const node: DiagramNode = { id: 'a', kind: 'process', label: 'Step', x: 0, y: 0, width: 140, height: 64,
    parentId: null, fill: '#edf5ff', stroke: '#007d79', textColor: '#161616', fontSize: 16, assetId: null,
    description: '**Owner**: *Operations* <unsafe>' };
  const doc = addFootnote({ ...emptyDiagram(), nodes: [node] }, 'a', 'f1');
  const block = footnoteBlock(doc, node, 'bottom')!;
  assert.equal(block.items[0]!.lines[1]!.text, 'Owner: Operations <unsafe>');
  assert.ok(block.items[0]!.lines[1]!.runs?.some(run => run.bold));
  assert.ok(block.items[0]!.lines[1]!.runs?.some(run => run.italic));
  const xml = diagramDrawioXml(doc, new Map());
  assert.ok(xml.includes('&lt;b&gt;Owner&lt;/b&gt;'));
  assert.ok(xml.includes('&lt;i&gt;Operations&lt;/i&gt;'));
  assert.ok(xml.includes('#007d79'));
});
test('IBM colour subset has names and retains legacy palette choices', () => {
  for (const colour of ['#edf5ff', '#f6f2ff', '#e5f6ff', '#d9fbfb', '#defbe6', '#fff0f7', '#fff1f1', '#fcf4d6', '#fff2e8']) {
    assert.ok(DIAGRAM_FILLS.includes(colour));
    assert.ok(IBM_COLOURS[colour]?.startsWith('IBM '));
    const rendered = diagramEditorNodeColours({ fill: colour, stroke: '#161616', textColor: '#161616' });
    assert.equal(rendered.textColor, '#f4f4f4');
  }
  assert.ok(DIAGRAM_FILLS.includes('#1c2d4a'));
  assert.ok(DIAGRAM_STROKES.includes('#007d79'));
});
