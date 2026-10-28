import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCanvasPanGesture } from '../src/features/diagram/canvasPan';

test('both canvases pan with Space plus left drag or middle drag, not plain left drag', () => {
  assert.equal(isCanvasPanGesture(0, false), false);
  assert.equal(isCanvasPanGesture(0, true), true);
  assert.equal(isCanvasPanGesture(1, false), true);
  assert.equal(isCanvasPanGesture(1, true), true);
  assert.equal(isCanvasPanGesture(2, false), false);
  assert.equal(isCanvasPanGesture(2, true), false);
});
