import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ideaTitleChange } from '../src/features/canvas/canvasTitle';
import { applyOps, inverseOps } from '../src/features/canvas/canvasGraph';

test('an untitled idea remains on the canvas and can be named later', () => {
  const empty = { nodes: [], edges: [] };
  const add = [{ op: 'add' as const, id: 'idea', label: '' }];
  const initial = applyOps(empty, add, 'canvas');
  assert.equal(initial.nodes[0]?.label, null);
  assert.equal(ideaTitleChange(null, '', true), undefined);
  assert.equal(ideaTitleChange(null, '   ', true), undefined);
  assert.equal(ideaTitleChange(null, 'First idea', true), 'First idea');
  const named = applyOps(initial, [{ op: 'update', id: 'idea', label: 'First idea' }], 'canvas');
  assert.equal(named.nodes[0]?.label, 'First idea');
  const undone = applyOps(initial, inverseOps(empty, add, 'canvas'), 'canvas');
  assert.equal(undone.nodes.length, 0);
});

test('clearing an idea title keeps the card; cancelling preserves the old title', () => {
  const initial = applyOps({ nodes: [], edges: [] }, [{ op: 'add', id: 'idea', label: 'Original' }], 'canvas');
  assert.equal(ideaTitleChange('Original', '', false), undefined);
  assert.equal(ideaTitleChange('Original', '', true), '');
  const cleared = applyOps(initial, [{ op: 'update', id: 'idea', label: '' }], 'canvas');
  assert.equal(cleared.nodes.length, 1);
  assert.equal(cleared.nodes[0]?.label, null);
});
