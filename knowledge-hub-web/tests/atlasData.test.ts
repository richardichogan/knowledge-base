import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAtlasData, atlasContextIds, atlasInsights, shortestAtlasPath, atlasPathAnswer, mentionedAtlasIds } from '../src/components/graph/atlasData';
import type { GraphNode, GraphEdge } from '../src/services/api';

const now = Date.parse('2026-10-23T12:00:00Z');
const node = (id: string, title: string, projectIds: string[] = [], days = 0): GraphNode => ({
  id, refId: id.split(':')[1]!, refType: id.split(':')[0]!, title, projectIds, tags: [], conceptParent: null,
  createdAt: new Date(now - days * 86400000).toISOString(),
});
const edge = (source: string, target: string, edgeType = 'references'): GraphEdge => ({
  id: `${source}/${target}`, source, target, edgeType, confidence: 1, metadata: null,
});
const nodes = [node('project:a', 'Alpha', [], 25), node('project:b', 'Beta', [], 20),
  node('note:a', 'Alpha briefing', ['a']), node('note:b', 'Beta briefing', ['b'], 20),
  node('person:p', 'Person', ['a']), node('company:m', 'Microsoft'), node('note:m', 'Microsoft strategy'),
  node('note:alone', 'Unconnected', [], 40)];
const edges = [edge('note:a', 'project:a', 'belongs_to'), edge('note:b', 'project:b', 'belongs_to'),
  edge('person:p', 'note:a'), edge('person:p', 'note:b'), edge('company:m', 'note:m', 'mentions')];

test('adapter uses actual IDs, whole-day activity, project membership, island components and exact handoff colours', () => {
  const before = JSON.stringify({ nodes, edges });
  const data = buildAtlasData(nodes, edges, now);
  assert.equal(data.nodes.find(n => n.id === 'project:a')?.last, 0);
  assert.equal(data.nodes.find(n => n.id === 'project:b')?.last, 20);
  assert.equal(data.nodes.find(n => n.id === 'person:p')?.project, 'project:a');
  assert.equal(data.types['project']?.color, '#08bdba');
  assert.equal(data.types['person']?.color, '#ff7eb6');
  assert.equal(data.islandCount, 2);
  assert.equal(data.nodes.find(n => n.id === 'company:m')?.island, data.nodes.find(n => n.id === 'note:m')?.island);
  assert.equal(data.edges.find(e => e.a === 'person:p' && e.b === 'note:b')?.kind, 'cross');
  assert.equal(data.edges.find(e => e.a === 'note:a')?.kind, 'member');
  assert.equal(data.edges.find(e => e.a === 'person:p' && e.b === 'note:a')?.kind, 'internal');
  assert.equal(data.edges.find(e => e.a === 'company:m')?.kind, 'island');
  assert.equal(JSON.stringify({ nodes, edges }), before);
});

test('company focus retains note connections without adding transitive or invented relationships', () => {
  const data = buildAtlasData(nodes, edges, now);
  const hidden = Object.keys(data.types).filter(type => type !== 'company' && type !== 'project');
  const context = atlasContextIds(data, hidden);
  assert.ok(context.has('note:m'));
  assert.ok(!context.has('note:a'));
  assert.equal(atlasContextIds(data, hidden, false).size, 0);
  assert.equal(atlasContextIds(data, []).size, 0);
});

test('BFS is undirected, shortest, cycle-safe and never fabricates disconnected paths', () => {
  const data = buildAtlasData(nodes, [...edges, edge('project:a', 'note:b')], now);
  assert.deepEqual(shortestAtlasPath(data, 'project:a', 'project:b'), ['project:a', 'note:b', 'project:b']);
  assert.deepEqual(shortestAtlasPath(data, 'note:m', 'company:m'), ['note:m', 'company:m']);
  assert.deepEqual(shortestAtlasPath(data, 'project:a', 'company:m'), []);
  assert.deepEqual(shortestAtlasPath(data, 'missing', 'missing'), []);
  assert.match(atlasPathAnswer(data, 'project:a', 'project:b', ['project:a', 'note:b', 'project:b']), /2 steps.*hasn't been touched in 20 days/);
  assert.match(atlasPathAnswer(data, 'project:a', 'company:m', []), /loaded graph.*does not mean/);
});

test('insights report connector, single recorded bridge, quiet project and unlinked groups', () => {
  const insights = atlasInsights(buildAtlasData(nodes, edges, now));
  assert.deepEqual(insights.map(i => i.id), ['connector', 'single', 'quiet', 'unlinked']);
  assert.equal(insights[0]?.node, 'person:p');
  assert.deepEqual(insights[1]?.path, ['person:p', 'note:b']);
  assert.equal(insights[2]?.node, 'project:b');
  assert.equal(insights[3]?.islands, true);
});

test('endpoint matching honours full names, word boundaries, order and ambiguity', () => {
  const data = buildAtlasData(nodes, edges, now);
  assert.deepEqual(mentionedAtlasIds(data, 'How is Microsoft strategy connected to Beta?'), ['note:m', 'project:b']);
  assert.deepEqual(mentionedAtlasIds(data, 'Alphabet and Microsoftish'), []);
  const duplicate = buildAtlasData([...nodes, node('company:second', 'Microsoft')], edges, now);
  assert.throws(() => mentionedAtlasIds(duplicate, 'Microsoft to Beta'), /More than one/);
});

test('indexed explicit project links are retained; inferred membership is not treated as ownership', () => {
  const data = buildAtlasData([node('project:a', 'Alpha'), node('document:d', 'Doc'), node('document:e', 'Other')],
    [edge('document:d', 'project:a', 'belongs_to'), { ...edge('document:e', 'project:a', 'belongs_to'), origin: 'inferred' }], now);
  assert.equal(data.nodes.find(n => n.id === 'document:d')?.project, 'project:a');
  assert.equal(data.nodes.find(n => n.id === 'document:e')?.project, null);
  assert.equal(data.edges.find(e => e.a === 'document:e')?.inferred, true);
});

test('project activity comes from its members, not an unrelated edit to the project record', () => {
  const data = buildAtlasData([node('project:a', 'Alpha'), node('note:a', 'Old note', ['a'], 30)], [], now);
  assert.equal(data.nodes.find(n => n.id === 'project:a')?.last, 30);
});
