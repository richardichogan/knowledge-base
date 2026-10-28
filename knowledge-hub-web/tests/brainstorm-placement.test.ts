import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, initialPositions, positionNewCards, type GraphState } from '../src/features/canvas/canvasGraph';
import { snapMovingBounds } from '../src/features/diagram/diagramAlignment';
import type { MapOp } from '../src/services/api';

const canvasId = 'canvas';
const add = (id: string, parent?: string, position?: { x: number; y: number }): MapOp => ({
  op: 'add', id, label: id, ...(position ?? {}),
  ...(parent !== undefined && { connectTo: { nodeId: parent, edgeId: `${parent}-${id}` } }),
});
const graph = (ops: MapOp[]): GraphState => applyOps({ nodes: [], edges: [] }, ops, canvasId);
const positioned = (state: GraphState, ops: MapOp[], selected = 'root'): GraphState =>
  applyOps(state, positionNewCards(state, ops, canvasId, selected, new Map()), canvasId);

test('batch additions balance root branches and stack siblings without moving existing cards', () => {
  const before = graph([add('root', undefined, { x: 0, y: 0 })]);
  const after = positioned(before, [add('right', 'root'), add('left', 'root'), add('second-right', 'root')]);
  assert.deepEqual(after.nodes.map(n => [n.id, n.x, n.y]), [
    ['root', 0, 0], ['right', 260, 0], ['left', -260, 0], ['second-right', 260, 80],
  ]);
  assert.deepEqual(before.nodes.map(n => [n.x, n.y]), [[0, 0]]);
});

test('descendants follow their visual branch and avoid cards already in the column', () => {
  const before = graph([
    add('root', undefined, { x: 0, y: 0 }), add('left', 'root', { x: -260, y: 0 }),
    add('first', 'left', { x: -520, y: 0 }), add('obstacle', undefined, { x: -520, y: 80 }),
  ]);
  const after = positioned(before, [add('second', 'left')]);
  assert.deepEqual(after.nodes.find(n => n.id === 'second') && [after.nodes.at(-1)?.x, after.nodes.at(-1)?.y], [-520, 160]);
});

test('explicit positions are preserved and affect later placements in the same batch', () => {
  const before = graph([add('root', undefined, { x: 0, y: 0 })]);
  const after = positioned(before, [add('placed', 'root', { x: -400, y: 50 }), add('child', 'placed')]);
  assert.deepEqual(after.nodes.map(n => [n.id, n.x, n.y]), [['root', 0, 0], ['placed', -400, 50], ['child', -660, 50]]);
});

test('server-created unplaced cards use the same ordered branches without moving saved cards', () => {
  const state = graph([
    add('root', undefined, { x: 0, y: 0 }), add('saved', 'root', { x: -300, y: 50 }),
    add('right', 'root'), add('child', 'saved'), add('sibling', 'saved'),
  ]);
  const { positions } = initialPositions(state.nodes, state.edges, new Map());
  assert.deepEqual(positions.get('saved'), { x: -300, y: 50 });
  assert.deepEqual(positions.get('right'), { x: 260, y: 0 });
  assert.deepEqual(positions.get('child'), { x: -560, y: 50 });
  assert.deepEqual(positions.get('sibling'), { x: -560, y: 130 });
});

test('card bounds use the diagram snapping algorithm at the current zoom', () => {
  const moving = { x: -95, y: -28, width: 190, height: 56 };
  const other = { x: 205, y: 100, width: 190, height: 56 };
  const result = snapMovingBounds(moving, [other], { x: 302, y: 37 }, { zoom: 1, gridSize: 10, shapeSnapping: true });
  assert.equal(result.delta.x, 300);
  assert.equal(result.delta.y, 38);
  assert.ok(result.guides.some(guide => guide.axis === 'x' && guide.value === 205));
  const free = snapMovingBounds(moving, [other], { x: 302, y: 37 }, { zoom: 1, gridSize: null, shapeSnapping: false });
  assert.deepEqual(free.delta, { x: 302, y: 37 });
});
