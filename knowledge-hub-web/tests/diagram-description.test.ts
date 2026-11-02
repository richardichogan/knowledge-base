import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continueDescriptionBullet, toggleDescriptionBullets } from '../src/features/diagram/diagramDescription';
import { diagramEdgeAppearance } from '../src/features/diagram/diagramTheme';
import type { DiagramEdge } from '../src/features/diagram/diagramTypes';
import { emptyDiagram, type DiagramNode } from '../src/features/diagram/diagramTypes';
import { diagramShapeText, diagramTextLayout, diagramTitleSource } from '../src/features/diagram/diagramText';
import { descriptionRuns, styledLines } from '../src/features/diagram/diagramMarkdown';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { diagramDrawioXml } from '../src/features/diagram/diagramDrawio';

const shape: DiagramNode = {
  id: 'shape', kind: 'process', label: 'Review claim', description: 'Check the policy.',
  x: 10, y: 20, width: 240, height: 160, fontSize: 14,
  fill: '#ffffff', stroke: '#161616', textColor: '#161616', parentId: null, assetId: null,
};

test('existing and new shape text uses a bold title, one blank line and normal description without rewriting data', () => {
  const before = JSON.stringify(shape);
  const layout = diagramTextLayout(shape);
  assert.equal(layout.source, '**Review claim**\n\nCheck the policy.');
  assert.deepEqual(layout.lines, ['Review claim', '', 'Check the policy.']);
  const runs = styledLines(layout.source, layout.lines);
  assert.equal(runs[0]!.every(run => run.bold), true);
  assert.equal(runs[2]!.every(run => !run.bold), true);
  assert.equal(JSON.stringify(shape), before);
  assert.equal(diagramTitleSource('**Review** the *claim*'), '**Review** the *claim*');
  assert.equal(diagramTitleSource('First\nSecond'), '**First**\n**Second**');
  assert.deepEqual(descriptionRuns(diagramTitleSource('  Cost * multiplier  ')),
    [{ text: '  ', bold: false, italic: false }, { text: 'Cost * multiplier', bold: true, italic: false }, { text: '  ', bold: false, italic: false }]);
  assert.equal(descriptionRuns(diagramShapeText({ ...shape, description: '**Check** the *policy*.' })).some(run => run.italic), true);
});

test('footnotes hide only the in-shape description and preserve authored content for the notes panel', () => {
  const before = JSON.stringify(shape);
  assert.equal(diagramTextLayout(shape, null, true).source, '**Review claim**');
  assert.deepEqual(diagramTextLayout(shape, null, true).lines, ['Review claim']);
  assert.equal(JSON.stringify(shape), before);
  assert.equal(diagramShapeText({ ...shape, label: '' }), 'Check the policy.');
  assert.equal(diagramShapeText({ ...shape, description: '' }), '**Review claim**');
});

test('description text stays within unchanged shape bounds and truncates long content', () => {
  for (const kind of ['process', 'decision', 'hexagon', 'document', 'terminator', 'arrow', 'text'] as const) {
    const node = { ...shape, kind, height: 100, description: 'Long explanation. '.repeat(60) };
    const before = JSON.stringify(node);
    const layout = diagramTextLayout(node);
    const halfHeight = (layout.lines.length - 1) * node.fontSize * 1.25 / 2 + node.fontSize / 2;
    assert.ok(layout.y - halfHeight >= node.y, kind);
    assert.ok(layout.y + halfHeight <= node.y + node.height, kind);
    assert.match(layout.lines.at(-1)!, /…$/);
    assert.equal(JSON.stringify(node), before);
  }
});

test('SVG and editable draw.io show descriptions or notes consistently and preserve a blank line', async () => {
  const doc = { ...emptyDiagram(), nodes: [shape] };
  const svg = await diagramSvg(doc, new Map(), 'white');
  assert.match(svg, /font-weight="700">Review claim/);
  assert.match(svg, /Check the policy/);
  assert.match(svg, /clip-path="url\(#diagram-node-text-0\)"/);
  const drawio = diagramDrawioXml(doc, new Map());
  assert.ok(drawio.includes('&lt;b&gt;Review claim&lt;/b&gt;&lt;br&gt;&lt;br&gt;Check the policy.'));
  const footnoted = { ...doc, footnotes: [{ id: 'note', targetId: shape.id, source: 'description' as const }] };
  const before = JSON.stringify(footnoted);
  const notesSvg = await diagramSvg(footnoted, new Map(), 'white');
  assert.ok(notesSvg.includes('Notes'));
  const withoutNotes = await diagramSvg(footnoted, new Map(), 'white', false, { footnotes: false });
  assert.equal(withoutNotes.includes('Check the policy.'), false);
  assert.equal(JSON.stringify(footnoted), before);
});

test('bullets toggle complete selected lines without changing adjacent content', () => {
  const source = 'Before\nFirst\nSecond\nAfter';
  const result = toggleDescriptionBullets(source, 8, 20);
  assert.equal(result.text, 'Before\n- First\n- Second\nAfter');
  assert.equal(toggleDescriptionBullets(result.text, result.start, result.end).text, source);
  assert.equal(toggleDescriptionBullets('First\nSecond', 0, 6).text, '- First\nSecond');
  assert.equal(toggleDescriptionBullets('', 0, 0).text, '- ');
  assert.equal(toggleDescriptionBullets('- One\nTwo', 0, 9).text, '- One\n- Two');
});

test('Enter continues a bullet and removes an empty bullet without swallowing following text', () => {
  assert.deepEqual(continueDescriptionBullet('- One', 5, 5), { text: '- One\n- ', start: 8, end: 8 });
  assert.deepEqual(continueDescriptionBullet('- One\n- ', 8, 8), { text: '- One\n', start: 6, end: 6 });
  assert.deepEqual(continueDescriptionBullet('- One\n- \nAfter', 8, 8), { text: '- One\n\nAfter', start: 6, end: 6 });
  assert.equal(continueDescriptionBullet('Plain text', 10, 10), null);
  assert.equal(continueDescriptionBullet('- Selected', 2, 5), null);
});

test('Yes and No labels do not change connector appearance or override saved colours', () => {
  const base = { label: '', stroke: '#525252', dashed: false } as DiagramEdge;
  for (const label of ['Yes', 'No', 'YES', ' no ']) {
    assert.deepEqual(diagramEdgeAppearance({ ...base, label }), diagramEdgeAppearance(base));
    const authored = { ...base, stroke: '#d02670' };
    assert.deepEqual(diagramEdgeAppearance({ ...authored, label }), diagramEdgeAppearance(authored));
  }
});
