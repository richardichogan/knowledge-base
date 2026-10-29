import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continueDescriptionBullet, toggleDescriptionBullets } from '../src/features/diagram/diagramDescription';
import { diagramEdgeAppearance } from '../src/features/diagram/diagramTheme';
import type { DiagramEdge } from '../src/features/diagram/diagramTypes';

test('bullets toggle complete selected lines without changing adjacent content', () => {
  const source = 'Before\nFirst\nSecond\nAfter';
  const result = toggleDescriptionBullets(source, 8, 20);
  assert.equal(result.text, 'Before\n- First\n- Second\nAfter');
  assert.equal(toggleDescriptionBullets(result.text, result.start, result.end).text, source);
  assert.equal(toggleDescriptionBullets('First\nSecond', 0, 6).text, '- First\nSecond');
  assert.equal(toggleDescriptionBullets('', 0, 0).text, '- ');
  assert.equal(toggleDescriptionBullets('- One\nTwo', 0, 9).text, '- One\n- Two');
});

test('Enter continues a bullet and removes an empty bullet without swallowing following text', () => {
  assert.deepEqual(continueDescriptionBullet('- One', 5, 5), { text: '- One\n- ', start: 8, end: 8 });
  assert.deepEqual(continueDescriptionBullet('- One\n- ', 8, 8), { text: '- One\n', start: 6, end: 6 });
  assert.deepEqual(continueDescriptionBullet('- One\n- \nAfter', 8, 8), { text: '- One\n\nAfter', start: 6, end: 6 });
  assert.equal(continueDescriptionBullet('Plain text', 10, 10), null);
  assert.equal(continueDescriptionBullet('- Selected', 2, 5), null);
});

test('Yes and No labels do not change connector appearance or override saved colours', () => {
  const base = { label: '', stroke: '#525252', dashed: false } as DiagramEdge;
  for (const label of ['Yes', 'No', 'YES', ' no ']) {
    assert.deepEqual(diagramEdgeAppearance({ ...base, label }), diagramEdgeAppearance(base));
    const authored = { ...base, stroke: '#d02670' };
    assert.deepEqual(diagramEdgeAppearance({ ...authored, label }), diagramEdgeAppearance(authored));
  }
});
