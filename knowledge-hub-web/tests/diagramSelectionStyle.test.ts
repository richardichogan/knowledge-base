import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiagramSelectionStyle, commonStyleValue } from '../src/features/diagram/diagramSelectionStyle';
import { emptyDiagram, type DiagramNode, type DiagramEdge } from '../src/features/diagram/diagramTypes';

const node = (id: string): DiagramNode => ({
  id, kind: 'process', label: id, x: 0, y: 0, width: 120, height: 60,
  parentId: null, fill: '#1c2d4a', stroke: '#78a9ff', textColor: '#f4f4f4', fontSize: 14, assetId: null,
});
const edge = (id: string): DiagramEdge => ({
  id, sourceId: 'a', targetId: 'b', sourcePort: 'right', targetPort: 'left',
  label: id, stroke: '#525252', dashed: false, route: 'straight', arrows: 'end', waypoints: [],
});

test('shared values distinguish mixed, uniform and empty selections', () => {
  assert.equal(commonStyleValue([2, 2]), 2);
  assert.equal(commonStyleValue([1, 2]), undefined);
  assert.equal(commonStyleValue([]), undefined);
});

test('mixed selection applies shared stroke and width in one immutable document change', () => {
  const doc = { ...emptyDiagram(), nodes: [node('a'), node('b'), node('outside')], edges: [edge('ab'), edge('outside-edge')] };
  const next = applyDiagramSelectionStyle(doc, { nodes: ['a', 'b'], edges: ['ab'] },
    { stroke: '#198038', strokeWidth: 4, strokeStyle: 'dotted', fontSize: 18 },
    { stroke: '#198038', strokeWidth: 4, dashed: true, fontSize: 18, arrows: 'both' });
  assert.equal(next.nodes[0]?.strokeWidth, 4);
  assert.equal(next.nodes[1]?.stroke, '#198038');
  assert.equal(next.nodes[1]?.strokeStyle, 'dotted');
  assert.equal(next.edges[0]?.strokeWidth, 4);
  assert.equal(next.edges[0]?.dashed, true);
  assert.equal(next.edges[0]?.arrows, 'both');
  assert.equal(next.edges[0]?.fontSize, 18);
  assert.equal(next.nodes[0]?.label, 'a');
  assert.equal(next.nodes[2], doc.nodes[2]);
  assert.equal(next.edges[1], doc.edges[1]);
  assert.equal(doc.nodes[0]?.strokeWidth, undefined);
});

test('fill changes keep legacy labels readable and skip line shapes and connectors', () => {
  const line = { ...node('line'), kind: 'line' as const };
  const doc = { ...emptyDiagram(), nodes: [node('a'), line], edges: [edge('ab')] };
  const next = applyDiagramSelectionStyle(doc, { nodes: ['a', 'line'], edges: ['ab'] }, { fill: '#a6c8ff' }, {});
  assert.equal(next.nodes[0]?.fill, '#a6c8ff');
  assert.equal(next.nodes[0]?.textColor, '#161616');
  assert.equal(next.nodes[1]?.fill, line.fill);
  assert.deepEqual(next.edges[0], doc.edges[0]);
});
