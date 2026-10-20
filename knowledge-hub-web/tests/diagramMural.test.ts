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
  assert.equal(result.objects[0]!.fill, '#FFFFFF00');
  assert.equal(result.objects[0]!.text, 'Editable label');
  assert.equal(result.connectors[0]!.sourceId, 'a');
  assert.equal(result.connectors[0]!.targetId, 'b');
  assert.equal(result.connectors[0]!.text, 'Yes');
});

test('Mural uses transparent boxes and readable text without modifying saved colours', async () => {
  const nodes = [node('area', 'container', 0), node('box', 'process', 20, 'area'), node('text', 'text', 400)]
    .map(n => ({ ...n, fill: '#202020', textColor: '#f4f4f4' }));
  const result = await diagramMural({ ...emptyDiagram(), nodes }, new Map(), options);
  for (const object of result.objects) {
    assert.equal(object.fill, '#FFFFFF00');
    assert.equal(object.textColor, '#161616FF');
  }
  assert.equal(result.objects.find(n => n.id === 'box')!.stroke, '#161616FF');
  assert.equal(nodes[1]!.fill, '#202020');
  assert.equal(nodes[1]!.textColor, '#f4f4f4');
});

test('Mural container headers are editable, parented and positioned above their contents', async () => {
  const area = { ...node('outer', 'container', 0), width: 600, height: 300 };
  const inner = { ...node('inner', 'container', 20, 'outer'), y: -40, width: 300, height: 150 };
  const result = await diagramMural({ ...emptyDiagram(), nodes: [area, inner] }, new Map(), options);
  const outer = result.objects.find(n => n.id === 'outer')!;
  const title = result.objects.find(n => n.id === 'outer-title')!;
  const nestedTitle = result.objects.find(n => n.id === 'inner-title')!;
  assert.equal(title.type, 'textbox');
  assert.equal(title.text, 'Editable label');
  assert.equal(title.parentId, 'outer');
  assert.equal(title.x, outer.x + 10);
  assert.ok(title.y >= outer.y);
  assert.ok(title.y + title.height < result.objects.find(n => n.id === 'inner')!.y);
  assert.equal(nestedTitle.parentId, 'inner');
});

test('Mural retains swimlane header rotation and skips empty area labels', async () => {
  const lane = { ...node('lane', 'swimlane', 0), width: 600, height: 300 };
  const result = await diagramMural({ ...emptyDiagram(), nodes: [lane, { ...node('empty', 'container', 800), label: '' }] }, new Map(), options);
  const area = result.objects.find(n => n.id === 'lane')!;
  const title = result.objects.find(n => n.id === 'lane-title')!;
  assert.equal(title.rotation, 270);
  assert.equal(title.align, 'center');
  assert.equal(title.parentId, 'lane');
  assert.equal(title.x + title.width / 2, area.x + 16);
  assert.equal(title.y + title.height / 2, area.y + area.height / 2);
  assert.ok(!result.objects.some(n => n.id === 'empty-title'));
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
