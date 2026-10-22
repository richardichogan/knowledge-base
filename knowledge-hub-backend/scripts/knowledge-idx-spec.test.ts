import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexItemPassages, type PassageIndexDeps } from '../src/ai/foundryIqIndexer.js';
import { createAdmission } from '../src/services/knowledge/admission.js';
import {
  backoffMs, claimIndexingWork, completeIndexingWork, enqueueContentItemIndex, estimateIndexingBackfill, getWork, IndexingFailure,
  INDEXING_MAX_ATTEMPTS, reconcileIndexingBacklog, retryFailedWork, runIndexingBatch, summariseIndexingWork, type IndexingHandlers,
} from '../src/services/knowledge/indexingWork.js';
import { createDbSearchBackends, searchKnowledge, type SearchRecord } from '../src/services/knowledge/search.js';
import { insertContent, phase2Db } from './knowledge-phase2-fixture.js';

const T0 = new Date(Date.now() + 3_600_000);
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const noop: IndexingHandlers = { index: async () => undefined, remove: async () => undefined };
const outage: IndexingHandlers = { index: async () => { throw new IndexingFailure('semantic_unavailable'); }, remove: noop.remove };
const lexical = async (db: Awaited<ReturnType<typeof phase2Db>>, query: string): Promise<string[]> =>
  (await searchKnowledge({ query }, createDbSearchBackends({ db, admission: createAdmission() }))).hits.map((h) => h.title);

test('IDX-01 a native edit during a semantic outage persists, reads current lexically and shows partial state', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', title: 'Retention note', body: 'retention is thirty days' });
  await runIndexingBatch(db, outage, { now: T0 });
  await db.query(`UPDATE content_items SET body = 'retention is ninety days' WHERE id = $1`, [id]);
  await runIndexingBatch(db, outage, { now: at(backoffMs(1) + 1000) });
  assert.equal((await db.query<{ body: string }>(`SELECT body FROM content_items WHERE id = $1`, [id])).rows[0]!.body, 'retention is ninety days');
  assert.deepEqual(await lexical(db, 'ninety'), ['Retention note'], 'lexical read is current without semantic indexing');
  const work = await getWork(db, id);
  assert.equal(work?.status, 'pending');
  assert.equal(work?.errorCode, 'semantic_unavailable');
  const summary = await summariseIndexingWork(db);
  assert.equal(summary.pending, 1, 'partial state is visible, not swallowed');
  assert.equal(summary.done, 0);
});

test('IDX-02 an HTTP 200 with one failed item is failed/pending and never counted indexed', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', title: 'T', body: 'hello world' });
  const deps: PassageIndexDeps = {
    embedBatch: async (texts) => texts.map(() => [0]),
    post: async (_i, actions) => ({ value: actions.map((a, n) => ({ key: String(a['id']), status: n !== 0 })) }),
  };
  const handlers: IndexingHandlers = {
    index: async () => { await indexItemPassages({ id, source: 'note', title: 'T', body: 'hello world', projectContext: 'x' }, new Map(), deps); },
    remove: noop.remove,
  };
  const result = await runIndexingBatch(db, handlers, { now: T0 });
  assert.equal(result.done, 0);
  assert.notEqual((await getWork(db, id))?.status, 'done');
  assert.equal((await summariseIndexingWork(db)).done, 0);
});

test('IDX-03 a delayed v1 completion after an edit to v2 cannot regress the effective revision', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'v1' });
  const v1 = await claimIndexingWork(db, { now: T0 });
  const v1Revision = v1.items[0]!.revision;
  await db.query(`UPDATE content_items SET body = 'v2' WHERE id = $1`, [id]);
  assert.equal(await completeIndexingWork(db, v1.items[0]!, v1.token, at(1000)), 'superseded');
  const pending = await getWork(db, id);
  assert.equal(pending?.status, 'pending');
  assert.notEqual(pending?.revision, v1Revision, 'work targets v2');
  const v2 = await claimIndexingWork(db, { now: at(2000) });
  assert.equal(await completeIndexingWork(db, v2.items[0]!, v2.token, at(3000)), 'done');
  assert.equal(await completeIndexingWork(db, v1.items[0]!, v1.token, at(4000)), 'superseded', 'a second late v1 ack is still rejected');
  assert.equal((await getWork(db, id))?.revision, pending?.revision);
});

test('IDX-04 deletion followed by delayed indexing or retry cannot resurrect the record', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  const claimed = await claimIndexingWork(db, { now: T0 });
  await db.query(`DELETE FROM content_items WHERE id = $1`, [id]);
  assert.equal(await completeIndexingWork(db, claimed.items[0]!, claimed.token, at(1000)), 'superseded');
  assert.equal(await enqueueContentItemIndex(db, id, at(2000)), false, 'a delayed enqueue is rejected by the tombstone');
  assert.equal(await retryFailedWork(db, id, at(3000)), false);
  const indexed: string[] = [];
  await runIndexingBatch(db, { index: async (r) => { indexed.push(r); }, remove: noop.remove }, { now: at(4000) });
  assert.deepEqual(indexed, []);
  assert.equal((await getWork(db, id))?.operation, 'delete');
});

test('IDX-05 a worker that dies after writing but before acking recovers by lease and posts the same chunk ids', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i.toString()} ${'text '.repeat(150)}`).join('\n\n');
  const posted: string[][] = [];
  const deps: PassageIndexDeps = {
    embedBatch: async (texts) => texts.map(() => [0]),
    post: async (_i, actions) => { posted.push(actions.map((a) => String(a['id']))); return { value: actions.map((a) => ({ key: String(a['id']), status: true })) }; },
  };
  const item = { id, source: 'note', title: 'T', body, projectContext: 'x' };
  const crashed = await claimIndexingWork(db, { now: T0 });
  await indexItemPassages(item, new Map(), deps); // write landed; the worker died before completeIndexingWork
  assert.equal(crashed.items.length, 1);
  assert.equal((await claimIndexingWork(db, { now: at(60_000) })).items.length, 0, 'live lease is respected');
  const recovered = await runIndexingBatch(db, { index: async () => { await indexItemPassages(item, new Map(), deps); }, remove: noop.remove }, { now: at(6 * 60_000) });
  assert.equal(recovered.done, 1);
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[1], posted[0], 'idempotent keys: the retry overwrites rather than duplicating logical chunks');
  assert.equal(new Set(posted[0]).size, posted[0]!.length);
});

test('IDX-06 repeated edits and a backfill rerun coalesce; unchanged hashes are not re-embedded', async () => {
  const db = await phase2Db();
  await insertContent(db, { sourceId: 'a', body: 'one' });
  await insertContent(db, { sourceId: 'b', body: 'two' });
  const first = await reconcileIndexingBacklog(db, { now: T0 });
  const second = await reconcileIndexingBacklog(db, { now: at(1000) });
  assert.equal(first.enqueued, 0, 'already queued by the write path');
  assert.equal(second.enqueued, 0);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM knowledge_indexing_work`)).rows[0]!.n, '2');
  const body = Array.from({ length: 20 }, (_, i) => `Paragraph ${i.toString()} ${'word '.repeat(150)}`).join('\n\n');
  let embedded = 0;
  const deps: PassageIndexDeps = {
    embedBatch: async (texts) => { embedded += texts.length; return texts.map(() => [0]); },
    post: async (_i, actions) => ({ value: actions.map((a) => ({ key: String(a['id']), status: true })) }),
  };
  const item = { id: 'p', source: 'note', title: 'T', body, projectContext: 'x' };
  const run1 = await indexItemPassages(item, new Map(), deps);
  const afterFirst = embedded;
  await indexItemPassages(item, run1.indexed, deps);
  assert.equal(embedded, afterFirst, 'a rerun embeds nothing');
});

test('IDX-07 a permanent failure and a fifth transient failure both stop with a safe reason and a manual recovery path', async () => {
  const db = await phase2Db();
  const permanent = await insertContent(db, { sourceId: 'p', body: 'x' });
  await runIndexingBatch(db, { index: async () => { throw new IndexingFailure('index_item_failed', true); }, remove: noop.remove }, { now: T0 });
  assert.equal((await getWork(db, permanent))?.status, 'failed');
  const transient = await insertContent(db, { sourceId: 't', body: 'y' });
  const failing: IndexingHandlers = { index: async (r) => { if (r === transient) throw new IndexingFailure('timeout'); }, remove: noop.remove };
  for (let attempt = 1; attempt <= INDEXING_MAX_ATTEMPTS; attempt++) await runIndexingBatch(db, failing, { now: at(attempt * 10 * 3_600_000) });
  const work = (await getWork(db, transient))!;
  assert.equal(work.status, 'failed');
  assert.equal(work.errorCode, 'attempts_exhausted');
  assert.equal((await claimIndexingWork(db, { now: at(1000 * 3_600_000) })).items.length, 0, 'no further automatic attempts');
  const summary = await summariseIndexingWork(db);
  assert.equal(summary.failed, 2);
  assert.ok(Object.keys(summary.failedCodes).length > 0);
  assert.equal(await retryFailedWork(db, transient, at(1000 * 3_600_000)), true, 'explicit manual recovery');
  assert.equal((await getWork(db, transient))?.status, 'pending');
});

test('IDX-08 reconcile counts canonical eligible parents; tombstones and published mirrors are not counted, pending is not current', async () => {
  const db = await phase2Db();
  await insertContent(db, { sourceId: 'n1', title: 'Real note', body: 'content' });
  const gone = await insertContent(db, { sourceId: 'n2', title: 'Deleted', body: 'content' });
  await db.query(`DELETE FROM content_items WHERE id = $1`, [gone]);
  await insertContent(db, { source: 'github-doc', sourceId: 'g1', title: 'Mirror of note', body: 'content', metadata: { repo: 'o/r', path: 'a.md' } });
  await db.query(`INSERT INTO note_github_publications (repo, path) VALUES ('o/r', 'a.md')`);
  const estimate = await estimateIndexingBackfill(db);
  assert.equal(estimate.items, 1, 'one canonical eligible parent: the tombstone and the alias mirror are not counted');
  const summary = await summariseIndexingWork(db);
  assert.equal(summary.done, 0, 'queued, missing and partial work is never reported as current');
  assert.ok(summary.pending >= 1);
});

test('IDX-09 semantic disabled or unavailable still serves lexical hits and says why', async () => {
  const db = await phase2Db();
  await insertContent(db, { sourceId: 'n', title: 'Retention policy', body: 'ninety days' });
  const base = createDbSearchBackends({ db, admission: createAdmission() });
  const disabled = await searchKnowledge({ query: 'retention' }, { ...base, semantic: undefined });
  assert.deepEqual(disabled.hits.map((h) => h.title), ['Retention policy']);
  assert.ok(disabled.issues.includes('semantic_not_configured'));
  const down = await searchKnowledge({ query: 'retention' }, { ...base, semantic: async (): Promise<SearchRecord[]> => { throw new Error('down'); } });
  assert.deepEqual(down.hits.map((h) => h.title), ['Retention policy']);
  assert.ok(down.issues.includes('semantic_unavailable'));
  assert.notEqual(down.status, 'ok');
});

test('IDX-10 with both FTS and semantic unavailable the outcome is explicitly unavailable, not an empty success', async () => {
  const boom = async (): Promise<SearchRecord[]> => { throw new Error('down'); };
  const result = await searchKnowledge({ query: 'retention' }, { exact: async () => [], lexical: boom, semantic: boom });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.hits, []);
  assert.ok(result.issues.includes('lexical_unavailable'));
});

test('IDX-11 a fresh native edit is lexically searchable at once and semantic work is claimable and retried inside five minutes', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', title: 'Fresh edit', body: 'zebrafish protocol' });
  assert.deepEqual(await lexical(db, 'zebrafish'), ['Fresh edit'], 'lexical projection is current with the write (target 5 s)');
  const work = (await getWork(db, id))!;
  assert.ok(Date.parse(work.nextAttemptAt) <= Date.now() + 5_000, 'work is due immediately');
  assert.equal((await claimIndexingWork(db, { now: new Date(Date.parse(work.nextAttemptAt) + 1000) })).items.length, 1);
  assert.ok(backoffMs(1) < 5 * 60_000, 'the first retry after a transient failure lands inside the five-minute target');
  const result = await runIndexingBatch(db, noop, { now: at(0) });
  assert.equal(result.done, 0 + (result.claimed > 0 ? 1 : 0));
});

test('IDX-12 with no worker running the semantic state is truthfully pending and nothing schedules itself', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', title: 'Night edit', body: 'nocturnal heron' });
  const before = (await getWork(db, id))!;
  assert.deepEqual(await lexical(db, 'nocturnal'), ['Night edit'], 'lexical read stays available without the worker');
  const summary = await summariseIndexingWork(db);
  assert.equal(summary.pending, 1, 'the delay is visible rather than reported as current');
  assert.equal(summary.done, 0);
  const after = (await getWork(db, id))!;
  assert.equal(after.attempts, 0);
  assert.equal(after.status, 'pending');
  assert.equal(after.leaseToken, null);
  assert.equal(after.nextAttemptAt, before.nextAttemptAt, 'no covert processing or rescheduling');
});
