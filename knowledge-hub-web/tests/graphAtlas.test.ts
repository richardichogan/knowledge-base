import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphNode, GraphEdge } from '../src/services/api';
import { atlasLayout, atlasBounds, forceGraphData, placeAtlasLabels, activityWindow, graphNodeHref, neighbourhood, isInferred } from '../src/components/graph/atlasModel';

const node = (id: string, projectIds: string[] = []): GraphNode => ({
  id, refId: id.split(':')[1]!, refType: id.split(':')[0]!, title: id, tags: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', conceptParent: null, projectIds,
});
const edge = (source: string, target: string): GraphEdge => ({
  id: `${source}-${target}`, source, target, edgeType: 'references', confidence: 1, metadata: null,
});

test('project layout is deterministic under reordering and separates nodes in 3D', () => {
  const nodes = [node('note:b', ['alpha']), node('project:alpha', ['alpha']), node('company:c', ['alpha']), node('note:a')];
  const a = atlasLayout(nodes), b = atlasLayout([...nodes].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.positions.size, nodes.length);
  assert.equal(a.clusters.find(c => c.id === 'project:alpha')?.count, 3);
  assert.equal(a.positions.get('project:alpha')?.z, 0);
  assert.ok([...a.positions.values()].some(point => point.z !== 0));
  assert.ok(atlasLayout([]).width > 0);
});

test('mini graph keeps the root, caps neighbours and has no dangling edges', () => {
  const root = node('note:z');
  const others = Array.from({ length: 15 }, (_, i) => node(`note:${i}`));
  const edges = others.map(n => edge(root.id, n.id));
  const preview = neighbourhood([...others, root], edges, root.id, 9);
  assert.equal(preview.nodes[0]?.id, root.id);
  assert.equal(preview.nodes.length, 9);
  assert.equal(preview.omitted, 7);
  assert.equal(preview.edges.length, 8);
  assert.deepEqual(neighbourhood([], [], root.id), { nodes: [], edges: [], omitted: 0 });
});

test('activity retains one-hop older context, but not unrelated or transitive records', () => {
  const nodes = [node('note:active'), node('note:old'), node('note:unrelated')];
  nodes[1]!.updatedAt = nodes[2]!.updatedAt = '2025-01-01T00:00:00Z';
  const from = Date.parse('2026-02-01T00:00:00Z');
  const result = activityWindow(nodes, [edge('note:active', 'note:old'), edge('note:old', 'note:unrelated')], from, from);
  assert.deepEqual([...result.active], ['note:active']);
  assert.deepEqual([...result.context], ['note:active', 'note:old']);
  assert.equal(activityWindow(nodes, [], from + 1, from + 1000).active.size, 0);
});

test('native links encode IDs and inferred semantic links remain distinguishable', () => {
  assert.equal(graphNodeHref({ ...node('note:a'), refId: 'a&b' }), '/think?view=notes&noteId=a%26b');
  assert.equal(graphNodeHref(node('company:a')), '/companies?companyId=a');
  assert.equal(graphNodeHref(node('person:a')), '/people?personId=a');
  assert.equal(graphNodeHref(node('project:a')), '/projects?projectId=a');
  assert.equal(graphNodeHref(node('chat:a')), '/chat?session=a');
  assert.equal(isInferred({ ...edge('a', 'b'), origin: 'inferred', edgeType: 'supported_by' }), true);
  assert.equal(isInferred({ ...edge('a', 'b'), edgeType: 'thematically_related' }), true);
  assert.equal(isInferred({ ...edge('a', 'b'), origin: 'user_confirmed' }), false);
});

test('screen labels never overlap or escape the viewport and preserve selection priority', () => {
  const candidates = Array.from({ length: 500 }, (_, i) => ({
    id: String(i), text: 'A very long project name '.repeat(4), x: (i % 20) * 35 + 10, y: Math.floor(i / 20) * 25 + 90,
  }));
  const labels = placeAtlasLabels(candidates, 728, 600);
  assert.equal(labels[0]?.id, '0');
  assert.ok(labels.length > 5 && labels.length <= 30);
  for (const label of labels) {
    assert.ok(label.x >= 0 && label.x + label.width <= 728);
    assert.ok(label.y >= 60 && label.y + label.height <= 570);
    for (const other of labels) {
      if (label.id === other.id) continue;
      assert.ok(label.x >= other.x + other.width || label.x + label.width <= other.x
        || label.y >= other.y + other.height || label.y + label.height <= other.y);
    }
  }
  assert.deepEqual(placeAtlasLabels([{ id: 'outside', text: 'x', x: -100, y: 90 }], 728, 600), []);
});

test('large groups do not inflate every small group and entities have physical separation', () => {
  const nodes = [...Array.from({ length: 450 }, (_, i) => node(`note:${i}`, ['large'])),
    ...Array.from({ length: 30 }, (_, i) => node(`project:p${i}`, [`p${i}`]))];
  const layout = atlasLayout(nodes);
  const large = layout.clusters.find(c => c.id === 'project:large')!;
  assert.ok(layout.clusters.filter(c => c.id !== large.id).every(c => c.radius < large.radius / 5));
  const points = [...layout.positions.values()];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      assert.ok(Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y) > 50);
    }
  }
  const small = atlasLayout(nodes.slice(-3));
  assert.ok(small.width < layout.width / 2);
  const bounds = atlasBounds([...small.positions.values()]);
  assert.ok(bounds.width < layout.width);
  assert.ok(atlasBounds([]).width > 0);
});

test('2D force nodes are unpinned, deterministic and isolated from API cache mutations', () => {
  const nodes = [node('note:b'), node('project:a', ['a'])];
  const edges = [edge('note:b', 'project:a')];
  const before = JSON.stringify({ nodes, edges });
  const graph = forceGraphData(nodes, edges);
  assert.deepEqual(graph, forceGraphData([...nodes].reverse(), edges));
  assert.ok(graph.nodes.every(n => Number.isFinite(n.x + n.y) && !('fx' in n) && !('fy' in n)));
  graph.nodes[0]!.x = 999;
  graph.links[0]!.source = 'changed-by-renderer';
  assert.equal(JSON.stringify({ nodes, edges }), before);
  assert.deepEqual(forceGraphData([], []), { nodes: [], links: [] });
});
