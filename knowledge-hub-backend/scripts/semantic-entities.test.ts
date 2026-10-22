import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceOf, resolveEntity, type SemanticReaders } from '../src/services/semantic/bindings.js';
import { confirmDecisionAcceptance, setDecisionReviewDate } from '../src/services/semantic/decisionStore.js';
import { inferredEdges, listEdges, recordEdge, resolveSupersession, satisfyingEdges } from '../src/services/semantic/relationships.js';
import { ctx, fixtureDb, N1, N1_REF, P1, R1, SD1, SD2, SD3, S1 } from './semantic-fixture.js';

const decision = (id: string): { kind: 'decision'; id: string } => ({ kind: 'decision', id });

test('SEM-01 five entity kinds resolve through live bindings', async () => {
  const { db } = await fixtureDb();
  for (const ref of [{ kind: 'project', id: P1 }, { kind: 'task', id: 't1' }, decision(SD1), { kind: 'source', id: `note:${N1}` }, { kind: 'risk', id: R1 }] as const) {
    const access = await resolveEntity(db, ref, ctx());
    assert.equal(access.status, 'ok', ref.kind);
    if (access.status === 'ok') {
      assert.equal(access.data.ref.kind, ref.kind);
      assert.match(access.data.version, /^[0-9a-f]{16}$/);
      assert.equal(access.data.readAt, '2026-10-22T09:00:00.000Z');
    }
  }
  const sd1 = await resolveEntity(db, decision(SD1), ctx());
  assert.equal(sd1.status === 'ok' && sd1.data.projectId, P1);
  const edges = await listEdges(db, decision(SD1));
  const relationships = new Set(edges.edges.map((e) => e.relationship));
  for (const name of ['belongs_to', 'recorded_in', 'supported_by', 'implements', 'affects', 'supersedes']) assert.ok(relationships.has(name as never), name);
  assert.equal(edges.invalid.length, 0);
});

test('SEM-02 bindings are live: a changed record changes the next read and its version', async () => {
  const { db, raw } = await fixtureDb();
  const before = await resolveEntity(db, { kind: 'task', id: 't1' }, ctx());
  await raw.query(`UPDATE tasks SET title = 'Renamed', due_date = '2026-11-01' WHERE id = 't1'`);
  const after = await resolveEntity(db, { kind: 'task', id: 't1' }, ctx());
  assert.ok(before.status === 'ok' && after.status === 'ok');
  if (before.status === 'ok' && after.status === 'ok') {
    assert.equal(after.data.title, 'Renamed');
    assert.equal(after.data.fields['dueDate'], '2026-11-01');
    assert.notEqual(before.data.version, after.data.version);
  }
  const copies = await raw.query(`SELECT COUNT(*)::int AS n FROM semantic_edges WHERE from_id = 't1' AND note LIKE '%Renamed%'`);
  assert.equal((copies.rows[0] as { n: number }).n, 0);
});

test('SEM-03 invalid relationships are rejected: endpoints, dangling, self, inferred or undated supersession', async () => {
  const { db, raw } = await fixtureDb();
  const base = { origin: 'explicit', effectiveAt: null } as const;
  const code = async (e: Parameters<typeof recordEdge>[1]): Promise<string> => {
    const r = await recordEdge(db, e, ctx());
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(await code({ ...base, relationship: 'implements', from: decision(SD1), to: { kind: 'task', id: 't1' } }), 'invalid_endpoint');
  assert.equal(await code({ ...base, relationship: 'implements', from: { kind: 'task', id: 'ghost' }, to: decision(SD1) }), 'dangling');
  assert.equal(await code({ ...base, relationship: 'supersedes', from: decision(SD1), to: decision(SD1), effectiveAt: '2026-10-01T00:00:00Z' }), 'self_edge');
  assert.equal(await code({ relationship: 'supersedes', from: decision(SD2), to: decision(SD3), origin: 'inferred', effectiveAt: '2026-10-01T00:00:00Z' }), 'inferred_supersession');
  assert.equal(await code({ ...base, relationship: 'supersedes', from: decision(SD2), to: decision(SD3) }), 'missing_effective_date');
  assert.equal(await code({ ...base, relationship: 'affects', from: { kind: 'risk', id: R1 }, to: decision(SD1) }), 'mapped_relationship');
  assert.equal(await code({ ...base, relationship: 'implements', from: { kind: 'task', id: 't1' }, to: decision(SD3) }), 'ok');
  const rows = await raw.query(`SELECT COUNT(*)::int AS n FROM semantic_edges WHERE to_id = $1 AND relationship = 'implements'`, [SD3]);
  assert.equal((rows.rows[0] as { n: number }).n, 1);
});

test('SEM-04 inferred links are leads only and never satisfy explicit relationships', async () => {
  const { db } = await fixtureDb();
  const { edges } = await listEdges(db, decision(SD1));
  assert.deepEqual(satisfyingEdges(edges, 'implements').map((e) => e.from.id).sort(), ['t1', 't2', 't3']);
  assert.deepEqual(inferredEdges(edges, 'implements').map((e) => e.from.id), ['t4']);
});

test('SEM-05 historic and assistant decisions stay acceptance unknown until the user confirms', async () => {
  const { db, raw } = await fixtureDb();
  await raw.query(`INSERT INTO chat_decisions (session_id, status, text, source) VALUES ($1,'decided','Historic row','user')`, [S1]);
  const historic = (await raw.query(`SELECT id::text AS id FROM chat_decisions WHERE text = 'Historic row'`)).rows[0] as { id: string };
  const read = async (id: string): Promise<unknown> => { const a = await resolveEntity(db, decision(id), ctx()); return a.status === 'ok' ? a.data.fields['acceptance'] : a.status; };
  assert.equal(await read(historic.id), 'unknown');
  assert.equal(await read(SD2), 'unknown');
  assert.equal(await read(SD1), 'accepted');
  assert.equal(acceptanceOf({ accepted_at: new Date(), acceptance_origin: null }), 'unknown');
  const refused = await confirmDecisionAcceptance(db, historic.id, { confirmedByUser: false as unknown as true }, ctx().now);
  assert.equal(refused.ok, false);
  assert.equal(await read(historic.id), 'unknown');
  assert.equal((await confirmDecisionAcceptance(db, historic.id, { confirmedByUser: true }, ctx().now)).ok, true);
  assert.equal(await read(historic.id), 'accepted');
  await raw.query(`UPDATE chat_decisions SET status = 'open' WHERE id::text = $1`, [SD2]);
  const open = await confirmDecisionAcceptance(db, SD2, { confirmedByUser: true }, ctx().now);
  assert.equal(open.ok === false && open.code, 'not_decided');
  assert.equal((await setDecisionReviewDate(db, SD2, '2026-02-30')).ok, false);
});

test('SEM-06 excluded, deleted and failing records are never read or treated as empty', async () => {
  const { db, raw } = await fixtureDb();
  let calls = 0;
  const readers: SemanticReaders = { decision: async () => { calls += 1; return { status: 'not_found' }; } };
  assert.equal((await resolveEntity(db, decision(SD1), ctx({ excludedIds: new Set([SD1]) }), readers)).status, 'excluded');
  assert.equal((await resolveEntity(db, N1_REF, ctx({ excludedIds: new Set([N1]) }))).status, 'excluded');
  assert.equal(calls, 0);
  await raw.query(`DELETE FROM tasks WHERE id = 't2'`);
  assert.equal((await resolveEntity(db, { kind: 'task', id: 't2' }, ctx())).status, 'not_found');
  const failing: SemanticReaders = { task: async () => { throw new Error('boom'); } };
  const failed = await resolveEntity(db, { kind: 'task', id: 't1' }, ctx(), failing);
  assert.deepEqual(failed, { status: 'unavailable', code: 'reader_failed' });
});

test('SEM-07 self supersession and cycles are an invalid state, not an arbitrary current decision', async () => {
  const { db, raw } = await fixtureDb();
  const insert = (a: string, b: string): Promise<unknown> => raw.query(
    `INSERT INTO semantic_edges (relationship, from_kind, from_id, to_kind, to_id, origin, effective_at) VALUES ('supersedes','decision',$1,'decision',$2,'explicit','2026-10-01T00:00:00Z')`, [a, b]);
  await insert(SD2, SD3);
  await insert(SD3, SD2);
  const cyc = await resolveSupersession(db, decision(SD2), ctx());
  assert.equal(cyc.state, 'invalid');
  await raw.query(`DELETE FROM semantic_edges WHERE from_id = $1 AND to_id = $2`, [SD3, SD2]);
  const rejected = await recordEdge(db, { relationship: 'supersedes', from: decision(SD3), to: decision(SD2), origin: 'explicit', effectiveAt: '2026-10-02T00:00:00Z' }, ctx());
  assert.equal(rejected.ok === false && rejected.code, 'cycle');
  await insert(SD1, SD1);
  const self = await resolveSupersession(db, decision(SD1), ctx());
  assert.equal(self.state === 'invalid' && self.code, 'self_supersession');
});

test('SEM-08 supersession takes effect only from its effective date and only when the successor is accepted', async () => {
  const { db } = await fixtureDb();
  const before = await resolveSupersession(db, decision(SD1), ctx());
  assert.equal(before.state, 'current');
  if (before.state === 'current') {
    assert.equal(before.pending.length, 1);
    assert.equal(before.unconfirmed[0]?.reason, 'successor_not_accepted');
  }
  const after = await resolveSupersession(db, decision(SD1), { now: new Date('2026-10-23T00:00:00Z') });
  assert.equal(after.state, 'superseded');
  if (after.state === 'superseded') {
    assert.equal(after.by.id, SD3);
    assert.equal(after.effectiveAt, '2026-10-23T00:00:00.000Z');
  }
});
