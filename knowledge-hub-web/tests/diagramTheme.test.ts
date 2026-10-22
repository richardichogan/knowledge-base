import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramEditorFill, diagramEditorInk, diagramEditorNodeColours } from '../src/features/diagram/diagramTheme';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { emptyDiagram } from '../src/features/diagram/diagramTypes';

test('light sheet maps dark-authored colours and keeps custom colours', () => {
  assert.equal(diagramEditorInk('#f4f4f4'), '#161616');
  assert.equal(diagramEditorInk('#78a9ff'), '#0f62fe');
  assert.equal(diagramEditorInk('#abcdef'), '#abcdef');
  assert.equal(diagramEditorFill('#262626'), '#ffffff');
  assert.equal(diagramEditorFill('none'), 'none');
});

test('legacy export colours remain intact while editor appearance is dark', async () => {
  const document = emptyDiagram();
  document.nodes.push({ id: 'legacy', kind: 'process', label: 'Original', x: 0, y: 0,
    width: 140, height: 64, parentId: null, assetId: null, fill: '#ffffff',
    stroke: '#161616', textColor: '#161616', fontSize: 14 });
  const svg = await diagramSvg(document, new Map(), 'transparent');
  assert.ok(svg.includes('fill="#ffffff" stroke="#161616"'));
  assert.ok(svg.includes('fill="#161616" text-anchor'));
});

test('dark-authored shapes render light with readable borders and labels', () => {
  assert.deepEqual(diagramEditorNodeColours({ fill: '#1c2d4a', stroke: '#78a9ff', textColor: '#f4f4f4' }),
    { fill: '#edf5ff', stroke: '#0f62fe', textColor: '#161616' });
  assert.deepEqual(diagramEditorNodeColours({ fill: 'none', stroke: '#c6c6c6', textColor: '#f4f4f4' }),
    { fill: 'none', stroke: '#525252', textColor: '#161616' });
  assert.deepEqual(diagramEditorNodeColours({ fill: '#abcdef', stroke: '#161616', textColor: '#161616' }),
    { fill: '#abcdef', stroke: '#161616', textColor: '#161616' });
});
