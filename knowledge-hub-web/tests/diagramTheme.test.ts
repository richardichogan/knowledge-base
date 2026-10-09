import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramEditorFill, diagramEditorInk, diagramEditorNodeColours } from '../src/features/diagram/diagramTheme';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { emptyDiagram } from '../src/features/diagram/diagramTypes';

test('dark sheet adjusts known dark inks without changing custom colours', () => {
  assert.equal(diagramEditorInk('#161616'), '#f4f4f4');
  assert.equal(diagramEditorInk('#000'), '#f4f4f4');
  assert.equal(diagramEditorInk('#333333'), '#c6c6c6');
  assert.equal(diagramEditorInk('#0F62FE'), '#78a9ff');
  assert.equal(diagramEditorInk('#abcdef'), '#abcdef');
  assert.equal(diagramEditorInk('none'), 'none');
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

test('existing white and pastel shapes render dark with readable borders and labels', () => {
  for (const fill of ['white', '#fff', '#FFFFFF', '#edf5ff', '#defbe6', '#fcf4d6', '#fff1f1', '#f6f2ff', '#f4f4f4']) {
    const node = { fill, stroke: '#525252', textColor: '#161616' };
    const colours = diagramEditorNodeColours(node);
    assert.notEqual(colours.fill, fill);
    assert.equal(colours.stroke, '#c6c6c6');
    assert.equal(colours.textColor, '#f4f4f4');
    assert.equal(node.fill, fill, 'Viewing an existing diagram does not rewrite saved artwork');
  }
  assert.equal(diagramEditorFill('none'), 'none');
  assert.equal(diagramEditorFill('#abcdef'), '#abcdef');
  assert.deepEqual(diagramEditorNodeColours({ fill: '#abcdef', stroke: '#161616', textColor: '#161616' }),
    { fill: '#abcdef', stroke: '#161616', textColor: '#161616' }, 'Custom colours remain unchanged');
  assert.equal(diagramEditorNodeColours({ fill: '#262626', stroke: '#161616', textColor: '#161616' }).textColor, '#f4f4f4');
});
