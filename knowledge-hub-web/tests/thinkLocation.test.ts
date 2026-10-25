import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramLocation, readThinkLocation } from '../src/notes/thinkLocation';

test('Design workspaces are Think locations alongside the existing note and canvas locations', () => {
  assert.deepEqual(readThinkLocation(new URLSearchParams('view=designs&design=source-note')), { view: 'designs', id: 'source-note' });
  assert.deepEqual(readThinkLocation(new URLSearchParams('view=designs')), { view: 'designs' });
  assert.deepEqual(readThinkLocation(new URLSearchParams('design=parent')), { view: 'designs', id: 'parent' });
  assert.deepEqual(readThinkLocation(new URLSearchParams('noteId=source-note')), { view: 'notes', id: 'source-note' });
  assert.deepEqual(readThinkLocation(new URLSearchParams('mapId=diagram&footnote=2')), { view: 'canvas', id: 'diagram', footnote: 2 });
  assert.equal(diagramLocation(new URLSearchParams('view=designs&design=parent'), 'diagram').has('view'), false);
  assert.equal(diagramLocation(new URLSearchParams('design=parent'), 'diagram').has('design'), false);
});
