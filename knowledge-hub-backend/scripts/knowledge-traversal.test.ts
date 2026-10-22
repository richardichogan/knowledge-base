import assert from 'node:assert/strict';
import { test } from 'node:test';
import { traverseRelationships, describeStep, mayAssertRelationship, type RelatedEdge, type TargetResolution } from '../src/ai/knowledge/traversal.js';

const ref = (id: string, kind = 'note') => ({ kind, id });
const graph = (map: Record<string, RelatedEdge[]>) => async (r: { kind: string; id: string }) => map[r.id] ?? [];
const ok = (projectId: string | null = 'p1') => async (): Promise<TargetResolution> => ({ status: 'ok', title: 't', projectId });
const edge = (id: string, relation = 'linked-task', explicit = true, extra: Partial<RelatedEdge> = {}): RelatedEdge => ({ to: ref(id), relation, explicit, ...extra });

test('REL-01: follows explicit path N1 -> R1 -> T1, read required before attributing', async () => {
  const r = await traverseRelationships({ start: ref('N1'), loadEdges: graph({ N1: [edge('R1', 'cites')], R1: [edge('T1')] }), resolveTarget: ok() });
  assert.deepEqual(r.steps.map((s) => s.key), ['note:R1', 'note:T1']);
  assert.deepEqual(r.steps[1]?.path, ['note:N1', 'note:R1', 'note:T1']);
  assert.ok(r.steps.every((s) => s.readRequired && s.label === 'explicit'));
  assert.deepEqual(mayAssertRelationship(r.steps[1]!, false), { relationship: true, contents: false });
});

test('REL-02: inferred similarity edges are labelled suggestions, not dependencies', async () => {
  const r = await traverseRelationships({ start: ref('N1'), loadEdges: graph({ N1: [edge('T9', 'similar', false, { confidence: 0.97, provenance: 'graph-inference' })] }), resolveTarget: ok() });
  const s = r.steps[0]!;
  assert.equal(s.label, 'inferred');
  assert.match(describeStep(s), /Inferred \(not confirmed\)/);
  assert.equal(mayAssertRelationship(s, true).relationship, false);
});

test('REL-03: cycles, self-edges and 1,000 neighbours terminate at limits with continuation', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => edge(`H${i}`));
  const r = await traverseRelationships({ start: ref('N1'), loadEdges: graph({ N1: [edge('N1'), edge('A'), ...many], A: [edge('N1'), edge('A')] }), resolveTarget: ok() });
  assert.equal(r.steps.filter((s) => s.key === 'note:N1').length, 0);
  assert.equal(r.steps.length, 20);
  assert.ok(r.truncated && r.truncatedBy.includes('neighbours'));
  assert.deepEqual(r.continuation[0], ref('N1'));

  const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`B${i}`, Array.from({ length: 20 }, (_, j) => edge(`C${i}_${j}`))]));
  const r2 = await traverseRelationships({ start: ref('S'), loadEdges: graph({ S: Array.from({ length: 20 }, (_, i) => edge(`B${i}`)), ...wide }), resolveTarget: ok() });
  assert.ok(r2.visited <= 60);
  assert.ok(r2.truncatedBy.includes('visited'));
  assert.ok(r2.steps.every((s) => s.hop <= 2));
});

test('REL-03b: two-hop maximum', async () => {
  const r = await traverseRelationships({ start: ref('A'), loadEdges: graph({ A: [edge('B')], B: [edge('C')], C: [edge('D')] }), resolveTarget: ok() });
  assert.deepEqual(r.steps.map((s) => s.ref.id), ['B', 'C']);
});

test('REL-04: dangling or deleted targets are rejected and never carry a title', async () => {
  const resolve = async (x: { id: string }): Promise<TargetResolution> => (x.id === 'X3' ? { status: 'deleted' } : { status: 'ok', title: 'Live', projectId: 'p1' });
  const r = await traverseRelationships({ start: ref('N1'), loadEdges: graph({ N1: [edge('X3'), edge('K')] }), resolveTarget: resolve });
  assert.deepEqual(r.steps.map((s) => s.ref.id), ['K']);
  assert.deepEqual(r.rejected, [{ key: 'note:X3', reason: 'deleted' }]);
  assert.ok(!JSON.stringify(r).includes('X3","title'));
});

test('REL-05: handoff lifecycle stays explicit, cross-project source retained, abort stops', async () => {
  const r = await traverseRelationships({
    start: ref('U1', 'use_case'), startProjectId: 'priv',
    loadEdges: graph({ U1: [{ to: ref('B1', 'build'), relation: 'spec-handoff', explicit: true }], B1: [{ to: ref('S1', 'spec'), relation: 'output-version', explicit: true }] }),
    resolveTarget: async (x) => ({ status: 'ok', title: null, projectId: x.id === 'S1' ? 'pub' : 'priv' }),
  });
  assert.deepEqual(r.steps.map((s) => s.relation), ['spec-handoff', 'output-version']);
  assert.equal(r.steps[1]?.crossProject, true);
  assert.equal(r.steps[1]?.sourceProjectId, 'priv');
  const c = new AbortController();
  c.abort();
  const stopped = await traverseRelationships({ start: ref('U1'), loadEdges: async () => { throw new Error('must not load'); }, resolveTarget: ok(), signal: c.signal });
  assert.equal(stopped.steps.length, 0);
  assert.ok(stopped.truncatedBy.includes('aborted'));
});

test('REL-06: explicit edges outrank inferred ones when the cap applies', async () => {
  const edges = [...Array.from({ length: 25 }, (_, i) => edge(`I${i}`, 'similar', false, { confidence: 0.9 })), edge('E1')];
  const r = await traverseRelationships({ start: ref('N'), loadEdges: graph({ N: edges }), resolveTarget: ok() });
  assert.ok(r.steps.some((s) => s.ref.id === 'E1'));
});
