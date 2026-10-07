import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramEditorInk } from '../src/features/diagram/diagramTheme';

test('dark sheet adjusts known dark inks without changing custom colours', () => {
  assert.equal(diagramEditorInk('#161616'), '#f4f4f4');
  assert.equal(diagramEditorInk('#333333'), '#c6c6c6');
  assert.equal(diagramEditorInk('#0F62FE'), '#78a9ff');
  assert.equal(diagramEditorInk('#abcdef'), '#abcdef');
  assert.equal(diagramEditorInk('none'), 'none');
});
