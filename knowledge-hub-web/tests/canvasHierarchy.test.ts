import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasHierarchy } from '../src/features/canvas/canvasHierarchy';

test('detail diagrams follow their parent regardless of last edit order', () => {
  const rows = canvasHierarchy([
    { id: 'detail', title: 'Observability', parentCanvasId: 'model' },
    { id: 'other', title: 'Other' },
    { id: 'model', title: 'Imagine Agentic Build & Run Model' },
    { id: 'deep', title: 'Telemetry', parentCanvasId: 'detail' },
  ]);
  assert.deepEqual(rows.map(row => [row.canvas.id, row.depth, row.parentTitle]), [
    ['other', 0, null], ['model', 0, null], ['detail', 1, 'Imagine Agentic Build & Run Model'],
    ['deep', 2, 'Observability'],
  ]);
});

test('filtered children and malformed cycles remain reachable exactly once', () => {
  const rows = canvasHierarchy([
    { id: 'orphan', title: 'Filtered', parentCanvasId: 'missing' },
    { id: 'self', title: 'Self', parentCanvasId: 'self' },
    { id: 'a', title: 'A', parentCanvasId: 'b' },
    { id: 'b', title: 'B', parentCanvasId: 'a' },
  ]);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.canvas.id)).size, 4);
  assert.deepEqual(rows.slice(0, 2).map(row => row.depth), [0, 0]);
  assert.deepEqual(canvasHierarchy([]), []);
});
