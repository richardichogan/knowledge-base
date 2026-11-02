import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { rankFlowNodes } from '../src/services/aiFlow.js';
import { layoutGeneralDiagram } from '../src/services/diagramLayout.js';
import { validateDiagramDocument } from '../src/services/diagramValidation.js';
import { emptyDiagram, type DiagramDocument, type DiagramEdge, type DiagramNode } from '../src/types/diagram.js';
import { buildDesignedDiagram, parseDiagramPlan, type DiagramPlan } from '../src/services/diagramDesigner.js';

test('Daedalus validates its grid, sizes readable groups and retains original shape identity', () => {
  const original = node('Original', { description: 'Original description' });
  const plan: DiagramPlan = { title: 'Reviewed flow', description: '', legend: [], nodes: [
    { key: 'group', originalId: null, kind: 'container', label: 'Process', description: '', parent: null, row: 0, column: 0, colour: 'grey' },
    { key: 'start', originalId: original.id, kind: 'process', label: 'Start', description: 'Read the request', parent: 'group', row: 0, column: 0, colour: 'blue' },
    { key: 'finish', originalId: null, kind: 'process', label: 'Finish', description: '', parent: 'group', row: 0, column: 1, colour: 'green' },
  ], edges: [{ from: 'start', to: 'finish', label: '', role: 'primary' }] };
  const output = buildDesignedDiagram(parseDiagramPlan(plan), doc([original]));
  assert.equal(output.nodes.find(n => n.label === 'Start')?.id, original.id);
  const group = output.nodes.find(n => n.kind === 'container')!;
  const children = output.nodes.filter(n => n.parentId === group.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.ok(child.x > group.x && child.x + child.width < group.x + group.width);
    assert.ok(child.y > group.y && child.y + child.height < group.y + group.height);
  }
  assert.ok(children[0]!.x + children[0]!.width < children[1]!.x);
  assert.equal(output.edges.length, 1);
  assert.equal(original.label, 'Original', 'candidate generation never mutates the original');
  assert.throws(() => parseDiagramPlan({ ...plan, nodes: [...plan.nodes, { ...plan.nodes[2], key: 'duplicate' }] }), /same grid cell/);
  assert.throws(() => buildDesignedDiagram({ ...plan, nodes: plan.nodes.map(n => n.key === 'start' ? { ...n, originalId: randomUUID() } : n) }, doc([original])), /outside the source/);
});

const node = (label: string, over: Partial<DiagramNode> = {}): DiagramNode => ({
  id: randomUUID(), kind: 'process', label, x: 0, y: 0, width: 160, height: 64,
  parentId: null, fill: '#fff', stroke: '#161616', textColor: '#161616', fontSize: 16, assetId: null, ...over,
});
const edge = (source: DiagramNode, target: DiagramNode): DiagramEdge => ({
  id: randomUUID(), sourceId: source.id, targetId: target.id, sourcePort: 'right', targetPort: 'left',
  route: 'orthogonal', waypoints: [], label: '', stroke: '#525252', dashed: false, arrows: 'end',
});
const doc = (nodes: DiagramNode[], edges: DiagramEdge[] = []): DiagramDocument => ({ ...emptyDiagram(), nodes, edges });
const centreY = (node: DiagramNode): number => node.y + node.height / 2;

test('feedback loops leave the main path in consecutive columns, independent of edge order', () => {
  for (const links of [
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
    [{ from: 'c', to: 'a' }, { from: 'b', to: 'c' }, { from: 'a', to: 'b' }],
  ]) assert.deepEqual([...rankFlowNodes(['a', 'b', 'c', 'd'], links).values()], [0, 1, 2, 0]);
  assert.deepEqual([...rankFlowNodes(['a'], [{ from: 'a', to: 'a' }, { from: 'missing', to: 'a' }]).values()], [0]);
});

test('mixed-height steps share a centreline and have an exact 80-unit horizontal gap', () => {
  const a = node('Start', { height: 52 });
  const b = node('Gate', { kind: 'decision', height: 90, width: 140 });
  const c = node('Finish', { height: 80 });
  const input = doc([a, b, c], [edge(a, b), edge(b, c), edge(c, a)]);
  const out = layoutGeneralDiagram(input);
  const [x, y, z] = out.nodes as [DiagramNode, DiagramNode, DiagramNode];
  assert.equal(centreY(x), centreY(y));
  assert.equal(centreY(y), centreY(z));
  assert.equal(y.x - x.x - x.width, 80);
  assert.equal(z.x - y.x - y.width, 80);
  assert.ok(out.edges[2]!.waypoints.every(point => point.y < Math.min(...out.nodes.map(node => node.y))));
  assert.deepEqual(layoutGeneralDiagram(out), out, 'repeated layout is stable');
  assert.deepEqual(input.nodes, [a, b, c], 'input is unchanged');
  assert.deepEqual(validateDiagramDocument(out, new Set()), out);
});

test('forks and joins are centred with equal sibling gaps, not pinned to the top branch', () => {
  const a = node('Start');
  const b = node('Branch A');
  const c = node('Branch B');
  const d = node('Join');
  const out = layoutGeneralDiagram(doc([a, b, c, d], [edge(a, b), edge(a, c), edge(b, d), edge(c, d)]));
  const [start, first, second, join] = out.nodes as [DiagramNode, DiagramNode, DiagramNode, DiagramNode];
  assert.equal(centreY(start), (centreY(first) + centreY(second)) / 2);
  assert.equal(centreY(join), centreY(start));
  assert.equal(first.x, second.x);
  assert.equal(second.y - first.y - first.height, 40);
});

test('unconnected architectural components form an aligned grid with 20/16-unit gaps', () => {
  const out = layoutGeneralDiagram(doc(Array.from({ length: 6 }, (_, i) => node(`Component ${i}`, { width: 140 }))));
  const [a, b, c, d] = out.nodes as [DiagramNode, DiagramNode, DiagramNode, DiagramNode];
  assert.equal(a.y, b.y);
  assert.equal(b.y, c.y);
  assert.equal(d.x, a.x);
  assert.equal(b.x - a.x - a.width, 20);
  assert.equal(d.y - a.y - a.height, 16);
});

test('nested semantic groups retain their children, padding and geometry across relayout', () => {
  const group = node('Group', { kind: 'container', width: 100, height: 100 });
  const inner = node('Inner', { kind: 'container', width: 100, height: 100, parentId: group.id });
  const a = node('A', { parentId: inner.id });
  const b = node('B', { parentId: inner.id });
  const out = layoutGeneralDiagram(doc([group, inner, a, b], [edge(a, b)]));
  for (const child of out.nodes.filter(node => node.parentId !== null)) {
    const parent = out.nodes.find(node => node.id === child.parentId)!;
    assert.ok(child.x >= parent.x + 20 && child.x + child.width <= parent.x + parent.width - 20);
    assert.ok(child.y >= parent.y + 60 && child.y + child.height <= parent.y + parent.height - 20);
  }
  assert.deepEqual(layoutGeneralDiagram(out), out);
  assert.deepEqual(validateDiagramDocument(out, new Set()), out);
});

test('self-links have a visible outside loop and long links route around intermediate columns', () => {
  const a = node('A'); const b = node('B'); const c = node('C');
  const out = layoutGeneralDiagram(doc([a, b, c], [edge(a, b), edge(b, c), edge(a, c), edge(a, a)]));
  assert.equal(out.edges[2]!.waypoints.length, 2);
  assert.equal(out.edges[3]!.waypoints.length, 3);
  assert.ok(out.edges[3]!.waypoints[0]!.x > out.nodes[0]!.x + a.width);
});
