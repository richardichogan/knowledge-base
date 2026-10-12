/**
 * Annotation tests (footnotes, colour key, collapse, versions, text check). Run from knowledge-hub-backend:
 *   node --import tsx/esm ../knowledge-hub-web/src/features/diagram/tests/diagramAnnotations.test.ts
 */
import type { DiagramDocument, DiagramEdge, DiagramNode } from '../diagramTypes';
import {
  addFootnote, collapseView, diffDocuments, fixTextIssues, footnoteBlock, footnoteHref, footnoteText, legendRows, moveFootnote,
  presentationSteps, pruneFootnotes, removeFootnote, textIssues,
} from '../diagramAnnotations';

let failures = 0;
let passes = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passes++; } catch (e) { failures++; console.error(`✗ ${name}\n  ${e instanceof Error ? e.message : String(e)}`); }
}
function eq(actual: unknown, expected: unknown, msg = ''): void {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b} but got ${a}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id, kind: 'process', label: id, x: 0, y: 0, width: 100, height: 50, parentId: null,
  fill: '#fff', stroke: '#000', textColor: '#000', fontSize: 14, assetId: null, ...extra,
});
const edge = (id: string, s: string, t: string, extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id, sourceId: s, targetId: t, sourcePort: 'right', targetPort: 'left', route: 'straight', waypoints: [],
  label: '', stroke: '#000', dashed: false, arrows: 'end', ...extra,
});
const doc = (nodes: DiagramNode[], edges: DiagramEdge[] = [], extra: Partial<DiagramDocument> = {}): DiagramDocument =>
  ({ version: 1, nodes, edges, grid: true, viewport: { x: 0, y: 0, zoom: 1 }, ...extra });

// ── Footnotes ──
test('addFootnote always shows the description and never duplicates', () => {
  let d = doc([node('a', { description: 'Alpha desc' }), node('b')]);
  d = addFootnote(d, 'a', 'f1');
  d = addFootnote(d, 'b', 'f2');
  d = addFootnote(d, 'a', 'f3');
  eq(d.footnotes?.map((f) => [f.id, f.source]), [['f1', 'description'], ['f2', 'description']]);
  eq(footnoteText(d, d.footnotes![0]!), 'Alpha desc');
  eq(footnoteText(d, d.footnotes![1]!), '');
  eq(addFootnote(d, 'missing', 'f4'), d, 'unknown target ignored');
});
test('moveFootnote reorders and removeFootnote drops the empty array', () => {
  let d = addFootnote(addFootnote(doc([node('a'), node('b')]), 'a', 'f1'), 'b', 'f2');
  d = moveFootnote(d, 'f2', -1);
  eq(d.footnotes?.map((f) => f.id), ['f2', 'f1']);
  eq(moveFootnote(d, 'f2', -1), d, 'cannot move past start');
  d = removeFootnote(removeFootnote(d, 'f1'), 'f2');
  ok(!('footnotes' in d), 'footnotes key removed when empty');
});
test('pruneFootnotes removes footnotes for deleted elements', () => {
  const d = doc([node('a')], [], { footnotes: [{ id: 'f1', targetId: 'a', source: 'description' }, { id: 'f2', targetId: 'gone', source: 'description' }] });
  eq(pruneFootnotes(d).footnotes?.map((f) => f.id), ['f1']);
  const clean = doc([node('a')], [], { footnotes: [{ id: 'f1', targetId: 'a', source: 'description' }] });
  ok(pruneFootnotes(clean) === clean, 'unchanged doc returned as-is');
});
test('footnoteBlock lays notes out beneath or beside the content, numbered in order', () => {
  const d = doc([node('a', { label: 'Alpha', description: 'Alpha desc' }), node('b', { label: 'Beta' })], [], {
    footnotes: [{ id: 'f1', targetId: 'a', source: 'description' }, { id: 'f2', targetId: 'b', source: 'description' }],
  });
  const content = { x: 0, y: 0, width: 500, height: 200 };
  const below = footnoteBlock(d, content, 'bottom', 'empty')!;
  ok(below.rect.y > 200 && below.rect.x === 0, 'bottom block sits under the content');
  eq(below.items.map((i) => [i.number, i.lines.map((l) => l.text)]), [[1, ['Alpha', 'Alpha desc']], [2, ['Beta', 'empty']]]);
  ok(below.items[1]!.lines[1]!.muted, 'missing description is muted');
  ok(below.items[1]!.rect.y >= below.items[0]!.rect.y + below.items[0]!.rect.height - 1, 'items do not overlap');
  const right = footnoteBlock(d, content, 'right')!;
  ok(right.rect.x > 500 && right.rect.y === 0, 'right block sits beside the content');
  eq(right.items[1]!.lines.map((l) => l.text), ['Beta'], 'exports omit the empty placeholder');
  ok(footnoteBlock(doc([node('a')]), content, 'bottom') === null, 'no footnotes, no block');
});
test('footnoteHref deep-links to the numbered note', () => {
  ok(footnoteHref('c1', 3).includes('footnote=3'), footnoteHref('c1', 3));
  ok(footnoteHref('c1', 3).includes('c1'), 'includes canvas id');
});
test('notes divider follows diagram width rather than column or viewport width', () => {
  const nodes = Array.from({ length: 9 }, (_, i) => node(`n${i}`));
  const d = doc(nodes, [], { footnotes: nodes.map(n => ({ id: `f-${n.id}`, targetId: n.id, source: 'description' })) });
  for (const width of [180, 600, 2400]) {
    for (const position of ['bottom', 'right'] as const) {
      const block = footnoteBlock(d, { x: -80, y: 20, width, height: 300 }, position)!;
      eq(block.divider.width, width);
      eq(block.divider.x, position === 'bottom' ? -80 : -80 + width + 40);
      ok(block.rect.width >= width, 'fit and export bounds include the full divider');
      ok(block.divider.y < block.heading.y, 'divider remains above Notes');
    }
  }
});
test('footnotes flow down four per column with non-overlapping variable-height text', () => {
  for (const count of [4, 5, 8, 9]) {
    const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`, {
      description: i === 1 ? 'A longer description that wraps across multiple lines. '.repeat(12) : `Description ${i}`,
    }));
    const d = doc(nodes, [], { footnotes: nodes.map((n, i) => ({ id: `f${i}`, targetId: n.id, source: 'description' })) });
    for (const position of ['bottom', 'right'] as const) {
      const block = footnoteBlock(d, { x: 20, y: 30, width: 600, height: 200 }, position)!;
      eq(block.items.map(i => i.number), Array.from({ length: count }, (_, i) => i + 1));
      block.items.forEach((item, i) => {
        eq(item.rect.x, block.items[Math.floor(i / 4) * 4]!.rect.x);
        if (i % 4 === 0) eq(item.rect.y, block.items[0]!.rect.y, 'new columns start at the same height');
        else ok(item.rect.y >= block.items[i - 1]!.rect.y + block.items[i - 1]!.rect.height, 'rows do not overlap');
        if (i >= 4) ok(item.rect.x > block.items[i - 4]!.rect.x + block.items[i - 4]!.rect.width, 'columns do not overlap');
        ok(item.rect.x + item.rect.width <= block.rect.x + block.rect.width, 'bounds include every column');
        ok(item.rect.y + item.rect.height <= block.rect.y + block.rect.height, 'bounds include the tallest column');
      });
    }
  }
});

// ── Colour key ──
test('legendRows counts border colours case-insensitively and merges saved labels', () => {
  const d = doc([node('a', { stroke: '#FF0000' }), node('b', { stroke: '#ff0000' }), node('c', { stroke: '#00f' }), node('d', { stroke: 'none' }), node('l', { kind: 'line', stroke: '#abc' })],
    [], { legend: { visible: true, position: 'bottom-right', entries: [{ colour: '#ff0000', label: 'Azure' }, { colour: '#00F', label: 'M365', hidden: true }] } });
  eq(legendRows(d), [
    { colour: '#ff0000', count: 2, label: 'Azure', hidden: false },
    { colour: '#00f', count: 1, label: 'M365', hidden: true },
  ]);
});

// ── Collapse ──
test('collapseView hides descendants, shrinks the container and reroutes connectors', () => {
  const d = doc([
    node('box', { kind: 'container', height: 300, collapsed: true }),
    node('inner', { parentId: 'box' }),
    node('deep', { parentId: 'inner' }),
    node('out'),
  ], [edge('e1', 'out', 'inner'), edge('e2', 'out', 'deep'), edge('e3', 'inner', 'deep'), edge('e4', 'out', 'box')]);
  const v = collapseView(d);
  eq(v.nodes.map((n) => n.id), ['box', 'out']);
  ok((v.nodes[0]?.height ?? 300) < 300, 'container shrunk to header');
  eq(v.hiddenCount.get('box'), 2);
  eq(v.hiddenBy.get('deep'), 'box');
  eq(v.edges.map((e) => [e.id, e.sourceId, e.targetId]), [['e1', 'out', 'box'], ['e4', 'out', 'box']]);
});
test('collapseView is a no-op without collapsed containers', () => {
  const d = doc([node('a', { collapsed: true }), node('b')], [edge('e', 'a', 'b')]);
  const v = collapseView(d);
  ok(v.nodes === d.nodes && v.edges === d.edges, 'same arrays');
});

// ── Versions ──
test('diffDocuments reports added, removed, changed and moved', () => {
  const from = doc([node('a'), node('b'), node('c')], [edge('e1', 'a', 'b')]);
  const to = doc([node('a', { x: 40 }), node('b', { label: 'Bee' }), node('d')], [edge('e1', 'a', 'b', { label: 'calls' }), edge('e2', 'a', 'd')]);
  const changes = diffDocuments(from, to).map((c) => `${c.change}:${c.id}`).sort();
  eq(changes, ['added:d', 'added:e2', 'changed:b', 'changed:e1', 'moved:a', 'removed:c']);
  eq(diffDocuments(from, from), []);
});

// ── Text check ──
test('textIssues catches misspellings, repeats and padded labels; fixTextIssues applies them', () => {
  const d = doc([node('a', { label: 'Dependancy  map' }), node('b', { label: ' Cntrols ' }), node('c', { label: 'the the plan' })],
    [edge('e', 'a', 'b', { description: 'Fine text' })]);
  const issues = textIssues(d);
  const kinds = issues.map((i) => `${i.targetId}:${i.kind}:${i.fix}`).sort();
  ok(kinds.includes('a:spelling:Dependency'), kinds.join());
  ok(kinds.includes('b:spelling:Controls'), kinds.join());
  ok(kinds.some((k) => k.startsWith('a:spacing')), 'double space');
  ok(kinds.some((k) => k.startsWith('b:spacing')), 'padding');
  ok(kinds.includes('c:repeat:the'), kinds.join());
  ok(!kinds.some((k) => k.startsWith('e:')), 'clean connector has no issues');
  const fixed = fixTextIssues(d, issues);
  eq(fixed.nodes.map((n) => n.label), ['Dependency map', 'Controls', 'the plan']);
  eq(textIssues(fixed), []);
});

// ── Presentation ──
test('presentationSteps follows footnote order', () => {
  const d = doc([node('a', { label: 'A', description: 'about a' }), node('b', { label: 'B', description: 'about b' })], [], {
    footnotes: [{ id: 'f2', targetId: 'b', source: 'description' }, { id: 'f1', targetId: 'a', source: 'description' }],
  });
  eq(presentationSteps(d).map((s) => [s.targetId, s.number, s.text]), [['b', 1, 'about b'], ['a', 2, 'about a']]);
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1;
