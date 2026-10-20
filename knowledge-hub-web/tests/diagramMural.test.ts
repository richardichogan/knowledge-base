import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramMural } from '../src/features/diagram/diagramMural';
import { emptyDiagram, type DiagramNode } from '../src/features/diagram/diagramTypes';
const node = (id: string, kind: DiagramNode['kind'], x: number, parentId: string | null = null): DiagramNode => ({
  id, kind, label: '**Editable** label', x, y: -100, width: 160, height: 80, parentId,
  fill: '#fff', stroke: '#161616', textColor: '#161616', fontSize: 14, assetId: null,
});
const options = { boardUrl: 'https://app.mural.co/t/a/m/a/123', title: 'Diagram', footnotes: false, legend: false };

test('Mural projection keeps editable shape kinds, absolute positions and connected endpoints', async () => {
  const doc = { ...emptyDiagram(), nodes: [node('area', 'container', -200), node('a', 'decision', -180, 'area'), node('b', 'terminator', 200)],
    edges: [{ id: 'edge', sourceId: 'a', targetId: 'b', sourcePort: 'right' as const, targetPort: 'left' as const,
      route: 'orthogonal' as const, waypoints: [], label: 'Yes', stroke: '#161616', dashed: false, arrows: 'end' as const }] };
  const result = await diagramMural(doc, new Map(), options);
  assert.equal(result.objects[0]!.type, 'area');
  assert.equal(result.objects.find(n => n.id === 'a')!.shape, 'rhombus_smart');
  assert.equal(result.objects.find(n => n.id === 'b')!.shape, 'terminator');
  assert.equal(result.objects.find(n => n.id === 'a')!.parentId, 'area');
  assert.equal(result.objects[0]!.x, 100);
  assert.equal(result.objects[0]!.y, 100);
  assert.equal(result.objects[0]!.fill, '#FFFFFFFF');
  assert.equal(result.objects[0]!.text, 'Editable label');
  assert.equal(result.connectors[0]!.sourceId, 'a');
  assert.equal(result.connectors[0]!.targetId, 'b');
  assert.equal(result.connectors[0]!.text, 'Yes');
});

test('Mural exports standalone lines and expanded groups plus editable annotations and instructions', async () => {
  const process = { ...node('a', 'process', 0), description: 'Important description' };
  const doc = { ...emptyDiagram(), nodes: [process, { ...node('line', 'line', 400), lineStart: { x: 400, y: 0 }, lineEnd: { x: 600, y: 0 } }],
    footnotes: [{ id: 'fn', targetId: 'a', source: 'description' as const }],
    legend: { visible: true, position: 'bottom-left' as const, entries: [{ colour: '#161616', label: 'Process' }] } };
  const result = await diagramMural(doc, new Map(), { ...options, footnotes: true, legend: true });
  assert.equal(result.objects.find(n => n.id === 'a')!.instruction, 'Important description');
  assert.ok(result.objects.some(n => n.id === 'footnote-fn' && n.type === 'shape'));
  assert.ok(result.objects.some(n => n.id === 'note-fn' && n.text.includes('Important description')));
  assert.ok(result.objects.some(n => n.id === 'key-heading'));
  assert.equal(result.connectors[0]!.sourceId, null);
  assert.equal(result.connectors[0]!.arrows, 'none');
  const bare = await diagramMural(doc, new Map(), options);
  assert.equal(bare.objects.length, 1);
});

test('Mural rejects missing assets and invalid connector endpoints instead of silently dropping them', async () => {
  await assert.rejects(diagramMural({ ...emptyDiagram(), nodes: [{ ...node('image', 'image', 0), assetId: 'missing' }] }, new Map(), options), /still loading/);
  await assert.rejects(diagramMural({ ...emptyDiagram(), nodes: [node('a', 'process', 0)], edges: [
    { id: 'broken', sourceId: 'a', targetId: 'missing', sourcePort: 'right', targetPort: 'left', route: 'straight', waypoints: [], label: '', stroke: '#000', dashed: false, arrows: 'end' },
  ] }, new Map(), options), /missing endpoint/);
});
