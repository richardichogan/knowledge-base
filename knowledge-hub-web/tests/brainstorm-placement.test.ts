import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, cardTree, estimateSize, initialPositions, inverseOps, positionNewCards, type GraphState } from '../src/features/canvas/canvasGraph';
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

function assertSeparated(state: GraphState): void {
  const tree = cardTree(state.nodes, state.edges, 'root');
  for (const [i, a] of state.nodes.entries()) {
    const sa = estimateSize(a, tree.depth.get(a.id));
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
    for (const b of state.nodes.slice(i + 1)) {
      const sb = estimateSize(b, tree.depth.get(b.id));
      assert.ok(Math.abs(a.x - b.x) >= (sa.w + sb.w) / 2 || Math.abs(a.y - b.y) >= (sa.h + sb.h) / 2,
        `${a.id} overlaps ${b.id}`);
    }
  }
}

test('batch additions use available root sectors without moving existing cards', () => {
  const before = graph([add('root', undefined, { x: 0, y: 0 })]);
  const after = positioned(before, [add('right', 'root'), add('left', 'root'), add('second-right', 'root')]);
  assertSeparated(after);
  assert.deepEqual(after.nodes[0], before.nodes[0]);
  assert.ok(after.nodes.find(n => n.id === 'right')!.x > 0);
  assert.ok(after.nodes.find(n => n.id === 'left')!.x < 0);
  assert.deepEqual(before.nodes.map(n => [n.x, n.y]), [[0, 0]]);
});

test('descendants stay in a compact parent group without moving unrelated branches', () => {
  const before = graph([
    add('root', undefined, { x: 0, y: 0 }), add('left', 'root', { x: -300, y: 0 }),
    add('first', 'left', { x: -600, y: 0 }), add('obstacle', undefined, { x: -600, y: 80 }),
  ]);
  const after = positioned(before, [add('second', 'left')]);
  const first = after.nodes.find(n => n.id === 'first')!;
  const second = after.nodes.find(n => n.id === 'second')!;
  assert.equal(first.x, second.x);
  assert.ok(second.x < -300);
  for (const id of ['root', 'left', 'obstacle']) assert.deepEqual(after.nodes.find(n => n.id === id), before.nodes.find(n => n.id === id));
  assertSeparated(after);
});

test('explicit positions are preserved and affect later placements in the same batch', () => {
  const before = graph([add('root', undefined, { x: 0, y: 0 })]);
  const after = positioned(before, [add('placed', 'root', { x: -400, y: 50 }), add('child', 'placed')]);
  const placed = after.nodes.find(n => n.id === 'placed')!;
  const child = after.nodes.find(n => n.id === 'child')!;
  assert.deepEqual([placed.x, placed.y], [-400, 50]);
  assert.ok(child.x < placed.x);
  assertSeparated(after);
});

test('server-created unplaced cards use the same ordered branches without moving saved cards', () => {
  const state = graph([
    add('root', undefined, { x: 0, y: 0 }), add('saved', 'root', { x: -300, y: 50 }),
    add('right', 'root'), add('child', 'saved'), add('sibling', 'saved'),
  ]);
  const { positions } = initialPositions(state.nodes, state.edges, new Map());
  assert.deepEqual(positions.get('saved'), { x: -300, y: 50 });
  const ops: MapOp[] = [...positions].map(([id, point]) => ({ op: 'position', id, ...point }));
  const after = applyOps(state, ops, canvasId);
  const saved = after.nodes.find(n => n.id === 'saved')!;
  assert.ok(after.nodes.find(n => n.id === 'right')!.x > 0);
  assert.ok(after.nodes.find(n => n.id === 'child')!.x < saved.x);
  assert.ok(after.nodes.find(n => n.id === 'sibling')!.x < saved.x);
  assertSeparated(after);
});

test('undo restores the parent group together with the new card', () => {
  const before = graph([add('root', undefined, { x: 0, y: 0 }), add('parent', 'root', { x: 400, y: 0 }), add('child', 'parent', { x: 700, y: 0 })]);
  const ops = positionNewCards(before, [add('sibling', 'parent')], canvasId, 'parent', new Map());
  const after = applyOps(before, ops, canvasId);
  assert.deepEqual(applyOps(after, inverseOps(before, ops, canvasId), canvasId), before);
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
