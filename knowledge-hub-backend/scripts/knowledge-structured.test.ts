import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explicitUtcInterval, intervalContains, parseRelativePhrase, resolveRelativeInterval } from '../src/services/knowledge/intervalResolver.js';
import { countTasks, listContentChanges, listTasks, StructuredQueryError } from '../src/services/knowledge/structuredQuery.js';
import { asQuery, insertContent, phase2Db, PINNED_NOW } from './knowledge-phase2-fixture.js';

test('DATE-01 this week is Monday-to-Monday in Europe/London expressed in UTC', () => {
  const week = resolveRelativeInterval('this_week', PINNED_NOW);
  assert.equal(week.startUtc, '2026-10-18T23:00:00.000Z');
  assert.equal(week.endUtc, '2026-10-26T00:00:00.000Z');
  assert.equal(week.startLocalDate, '2026-10-19');
  assert.equal(week.endLocalDate, '2026-10-26');
  assert.equal(resolveRelativeInterval('last_week', PINNED_NOW).endUtc, week.startUtc);
  assert.equal(parseRelativePhrase('This  Week'), 'this_week');
  assert.equal(parseRelativePhrase('soonish'), null);
});

test('DATE-02 intervals are start-inclusive and end-exclusive', () => {
  const today = resolveRelativeInterval('today', PINNED_NOW);
  assert.ok(intervalContains(today, today.startUtc));
  assert.ok(!intervalContains(today, today.endUtc));
  assert.ok(!intervalContains(today, '2026-10-21T22:59:59.999Z'));
  assert.equal(today.startUtc, '2026-10-21T23:00:00.000Z');
  assert.throws(() => explicitUtcInterval('2026-10-02', '2026-10-01'));
});

test('DATE-03 DST transition days are 23/25 hours and weeks stay aligned to local midnight', () => {
  const spring = resolveRelativeInterval('today', new Date('2026-03-29T12:00:00Z'));
  assert.equal(spring.startUtc, '2026-03-29T00:00:00.000Z');
  assert.equal(spring.endUtc, '2026-03-29T23:00:00.000Z');
  const autumn = resolveRelativeInterval('today', new Date('2026-10-25T12:00:00Z'));
  assert.equal(Date.parse(autumn.endUtc) - Date.parse(autumn.startUtc), 25 * 3600_000);
  const week = resolveRelativeInterval('this_week', new Date('2026-03-25T12:00:00Z'));
  assert.equal(week.startUtc, '2026-03-23T00:00:00.000Z');
  assert.equal(week.endUtc, '2026-03-29T23:00:00.000Z');
});

async function taskFixture() {
  const db = await phase2Db();
  for (let i = 1; i <= 7; i++) {
    const due = i <= 5 ? `2026-10-${String(18 + i).padStart(2, '0')}` : null;
    await db.query(`INSERT INTO tasks (id, title, status, project_id, due_date) VALUES ($1,$2,$3,$4,$5)`,
      [`t${i}`, `Task ${i}`, i === 2 ? 'completed' : 'backlog', i % 2 === 0 ? 'p-a' : 'p-b', due]);
  }
  await db.query(`INSERT INTO tasks (id, title, archived, due_date) VALUES ('arch', 'Archived', TRUE, '2026-10-20')`);
  return db;
}

test('STATE-01 pages by keyset cursor with hasMore and no duplicates or gaps', async () => {
  const db = await taskFixture();
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listTasks(asQuery(db), { filter: {}, limit: 3, ...(cursor !== undefined && { cursor }) });
    seen.push(...page.items.map(t => t.id));
    assert.equal(page.hasMore, page.nextCursor !== null);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor !== undefined);
  assert.deepEqual(seen, ['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
  assert.equal(pages, 3);
});

test('STATE-02 total is exact in the same snapshot as every page', async () => {
  const db = await taskFixture();
  const first = await listTasks(asQuery(db), { filter: {}, limit: 2 });
  assert.equal(first.total, 7);
  assert.equal(first.totalExact, true);
  const second = await listTasks(asQuery(db), { filter: {}, limit: 2, cursor: first.nextCursor! });
  assert.equal(second.total, 7);
  assert.equal((await countTasks(asQuery(db), { includeArchived: true })).total, 8);
});

test('STATE-03 invalid or foreign cursors are rejected, not silently restarted', async () => {
  const db = await taskFixture();
  const page = await listTasks(asQuery(db), { filter: {}, limit: 2 });
  await assert.rejects(listTasks(asQuery(db), { filter: {}, cursor: 'not-a-cursor' }), StructuredQueryError);
  await assert.rejects(listTasks(asQuery(db), { filter: { projectIds: ['p-a'] }, cursor: page.nextCursor! }), StructuredQueryError);
});

test('STATE-04 zero is a real answer only when the query succeeded; failures throw', async () => {
  const db = await taskFixture();
  assert.equal((await countTasks(asQuery(db), { projectIds: ['none'] })).total, 0);
  const failing = { query: async () => { throw new Error('db down'); } };
  await assert.rejects(countTasks(failing, {}), /db down/);
  await assert.rejects(listTasks(failing, { filter: {} }), /db down/);
});

test('STATE-04 due-window and overdue filters use local calendar dates', async () => {
  const db = await taskFixture();
  const week = resolveRelativeInterval('this_week', PINNED_NOW);
  const due = await listTasks(asQuery(db), { filter: { dueWithin: week } });
  assert.deepEqual(due.items.map(t => t.id), ['t1', 't2', 't3', 't4', 't5']);
  const overdue = await listTasks(asQuery(db), { filter: { overdueAsOf: PINNED_NOW } });
  assert.deepEqual(overdue.items.map(t => t.id), ['t1', 't3']);
});

test('STATE-05 changes use the source timestamp, not our indexing time', async () => {
  const db = await phase2Db();
  const inWeek = await insertContent(db, { source: 'github-pr', sourceId: 'a', title: 'PR A', publishedAt: '2026-09-01T00:00:00Z',
    metadata: { updatedAt: '2026-10-21T10:00:00Z' } });
  await insertContent(db, { source: 'github-pr', sourceId: 'b', title: 'PR B', publishedAt: '2026-10-21T10:00:00Z',
    metadata: { updatedAt: '2026-09-02T10:00:00Z' } });
  await insertContent(db, { sourceId: 'c', title: 'Note C', publishedAt: '2026-10-20T08:00:00Z' });
  await insertContent(db, { sourceId: 'd', title: 'Bad stamp', publishedAt: '2026-10-20T09:00:00Z', metadata: { updatedAt: 'not a date' } });
  const result = await listContentChanges(asQuery(db), { filter: { within: resolveRelativeInterval('this_week', PINNED_NOW) } });
  assert.deepEqual(result.items.map(i => i.title), ['PR A', 'Bad stamp', 'Note C']);
  assert.equal(result.items[0]!.id, inWeek);
  assert.equal(result.total, 3);
  const paged = await listContentChanges(asQuery(db), { filter: { within: resolveRelativeInterval('this_week', PINNED_NOW) }, limit: 2 });
  assert.equal(paged.hasMore, true);
  const rest = await listContentChanges(asQuery(db), { filter: { within: resolveRelativeInterval('this_week', PINNED_NOW) }, limit: 2, cursor: paged.nextCursor! });
  assert.deepEqual(rest.items.map(i => i.title), ['Note C']);
});
