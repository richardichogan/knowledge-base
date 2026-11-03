import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasGroupsByProject } from '../src/features/canvas/canvasGroups';

test('groups top-level canvases by project and keeps unassigned canvases last', () => {
  const groups = canvasGroupsByProject([
    { id: 'z-first', project: 'z', parentCanvasId: null },
    { id: 'child', project: 'a', parentCanvasId: 'z-first' },
    { id: 'a-first', project: 'a', parentCanvasId: null },
    { id: 'unassigned', project: null, parentCanvasId: null },
    { id: 'z-second', project: 'z', parentCanvasId: null },
    { id: 'orphan', project: 'a', parentCanvasId: 'missing' },
  ], new Map([['a', 'Alpha'], ['z', 'Zulu']]));

  assert.deepEqual(groups.map(group => [group.label, group.canvases.map(canvas => canvas.id)]), [
    ['Alpha', ['a-first']],
    ['Zulu', ['z-first', 'z-second']],
    ['General', ['unassigned']],
  ]);
});

test('unresolved project assignments fall into General', () => {
  const groups = canvasGroupsByProject([
    { id: 'unknown-project', project: 'deleted-project', parentCanvasId: null },
  ], new Map());

  assert.deepEqual(groups.map(group => [group.label, group.canvases.map(canvas => canvas.id)]), [
    ['General', ['unknown-project']],
  ]);
  assert.deepEqual(canvasGroupsByProject([], new Map()), []);
});
