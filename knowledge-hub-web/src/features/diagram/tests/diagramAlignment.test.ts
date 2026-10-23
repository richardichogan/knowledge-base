import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignMovingBounds, gridSnapEnabled, shapeSnapEnabled, spaceMovingBounds } from '../diagramAlignment';
import { normalizeDocument } from '../diagramGeometry';
import { emptyDiagram, type DiagramNode } from '../diagramTypes';

const node = (id: string, x: number, y: number, width = 100, height = 50): DiagramNode => ({
  id, x, y, width, height, kind: 'process', label: id, parentId: null,
  fill: '#fff', stroke: '#161616', textColor: '#161616', fontSize: 16, assetId: null,
});

test('guides show all left/centre/right and top/middle/bottom matches, not only the first', () => {
  const moving = node('moving', 0, 0);
  const aligned = alignMovingBounds(moving, [node('other', 200, 100)], { x: 198, y: 98 }, 5);
  assert.deepEqual(aligned.delta, { x: 200, y: 100 });
  assert.deepEqual(aligned.guides, [
    { axis: 'x', value: 200, kind: 'edge' }, { axis: 'x', value: 250, kind: 'centre' }, { axis: 'x', value: 300, kind: 'edge' },
    { axis: 'y', value: 100, kind: 'edge' }, { axis: 'y', value: 125, kind: 'centre' }, { axis: 'y', value: 150, kind: 'edge' },
  ]);
});

test('snap off leaves free movement intact; exact guides still appear', () => {
  const moving = node('moving', 0, 0);
  const free = alignMovingBounds(moving, [node('other', 200, 100)], { x: 198, y: 100 }, 0.5, false);
  assert.deepEqual(free.delta, { x: 198, y: 100 });
  assert.ok(free.guides.every(guide => guide.axis === 'y'));
});

test('guide tolerance scales with zoom and works with negative coordinates', () => {
  const moving = node('moving', 0, 0);
  const other = node('other', -300, -100);
  assert.equal(alignMovingBounds(moving, [other], { x: -294, y: -94 }, 5 / 0.5).delta.x, -300);
  assert.equal(alignMovingBounds(moving, [other], { x: -294, y: -94 }, 5 / 2).delta.x, -294);
});

test('spacing measures nearest shapes and snaps a moving shape into an equal gap', () => {
  const result = spaceMovingBounds(node('moving', 0, 0), [node('left', 0, 0), node('right', 300, 0)],
    { x: 147, y: 0 }, 5);
  assert.equal(result.delta.x, 150);
  const horizontal = result.indicators.filter(indicator => indicator.axis === 'x');
  assert.deepEqual(horizontal.map(indicator => [indicator.gap, indicator.equal]), [[50, true], [50, true]]);
});

test('spacing can repeat the gap alongside two neighbours', () => {
  const result = spaceMovingBounds(node('moving', 0, 0), [node('first', 0, 0), node('second', 140, 0)],
    { x: 277, y: 0 }, 5);
  assert.equal(result.delta.x, 280);
  assert.deepEqual(result.indicators.filter(indicator => indicator.axis === 'x').map(indicator => [indicator.gap, indicator.equal]), [[40, true], [40, true]]);
});

test('vertical spacing and multi-selection bounds use the same geometry', () => {
  const result = spaceMovingBounds({ x: 0, y: 0, width: 240, height: 100 },
    [node('above', 0, 0, 240, 100), node('below', 0, 400, 240, 100)], { x: 0, y: 197 }, 5);
  assert.equal(result.delta.y, 200);
  assert.deepEqual(result.indicators.filter(indicator => indicator.axis === 'y').map(indicator => indicator.gap), [100, 100]);
});

test('measurements never pull a shape off an edge/centre already snapped on that axis', () => {
  const result = spaceMovingBounds(node('moving', 0, 0), [node('left', 0, 0), node('right', 300, 0)],
    { x: 147, y: 0 }, 5, true, ['x']);
  assert.equal(result.delta.x, 147);
  assert.deepEqual(result.indicators.map(indicator => indicator.gap), [47, 53]);
});

test('free movement still reports unequal gaps without snapping', () => {
  const result = spaceMovingBounds(node('moving', 0, 0), [node('left', 0, 0), node('right', 300, 0)],
    { x: 147, y: 0 }, 5, false);
  assert.equal(result.delta.x, 147);
  assert.deepEqual(result.indicators.map(indicator => indicator.equal), [false, false]);
});

test('shapes in unrelated rows do not produce horizontal gap measurements', () => {
  const result = spaceMovingBounds(node('moving', 0, 0), [node('other-row', 300, 200)], { x: 0, y: 0 }, 5);
  assert.deepEqual(result.indicators, []);
});

test('legacy snap defaults are preserved and explicit preferences survive document normalization', () => {
  assert.equal(gridSnapEnabled({ grid: true }), true);
  assert.equal(gridSnapEnabled({ grid: false }), false);
  assert.equal(shapeSnapEnabled({}), true);
  const doc = { ...emptyDiagram(), grid: false, snapToGrid: true, snapToShapes: false };
  assert.equal(gridSnapEnabled(doc), true);
  assert.equal(shapeSnapEnabled(doc), false);
  assert.deepEqual(normalizeDocument(doc), doc);
});
