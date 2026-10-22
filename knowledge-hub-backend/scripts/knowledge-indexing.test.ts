import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAllPassagesIndexed, indexItemPassages, PassageIndexError, type PassageIndexDeps } from '../src/ai/foundryIqIndexer.js';
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS, chunkText, planChunks } from '../src/services/knowledge/chunking.js';
import {
  backoffMs, claimIndexingWork, completeIndexingWork, enqueueContentItemIndex, estimateIndexingBackfill, getWork, IndexingFailure,
  INDEXING_MAX_ATTEMPTS, reconcileIndexingBacklog, retryFailedWork, runIndexingBatch, summariseIndexingWork, type IndexingHandlers,
} from '../src/services/knowledge/indexingWork.js';
import { createAdmission } from '../src/services/knowledge/admission.js';
import { insertContent, phase2Db } from './knowledge-phase2-fixture.js';

const T0 = new Date(Date.now() + 3_600_000);
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const noop: IndexingHandlers = { index: async () => undefined, remove: async () => undefined };

test('IDX-01 content writes enqueue durable work atomically; a semantic outage never loses the edit', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', title: 'Note', body: 'v1' });
  assert.equal((await getWork(db, id))?.status, 'pending');
  const outage: IndexingHandlers = { index: async () => { throw new IndexingFailure('semantic_unavailable'); }, remove: noop.remove };
  const result = await runIndexingBatch(db, outage, { now: T0 });
  assert.equal(result.retried, 1);
  const work = await getWork(db, id);
  assert.equal(work?.status, 'pending');
  assert.equal(work?.attempts, 1);
  assert.equal(work?.errorCode, 'semantic_unavailable');
  const stored = await db.query<{ body: string }>(`SELECT body FROM content_items WHERE id = $1`, [id]);
  assert.equal(stored.rows[0]!.body, 'v1');
  // Provider recovers: the same work completes.
  const again = await runIndexingBatch(db, noop, { now: at(backoffMs(1) + 1000) });
  assert.equal(again.done, 1);
  assert.equal((await getWork(db, id))?.status, 'done');
});

test('IDX-02 a batch-level success with any failed item result is a failure, never "indexed"', async () => {
  assert.throws(() => assertAllPassagesIndexed(['a_0', 'a_1'], { value: [{ key: 'a_0', status: true }, { key: 'a_1', status: false }] }), PassageIndexError);
  assert.throws(() => assertAllPassagesIndexed(['a_0'], { value: [] }), PassageIndexError);
  const deps: PassageIndexDeps = {
    embedBatch: async texts => texts.map(() => [0]),
    post: async (_i, actions) => ({ value: actions.map((a, n) => ({ key: String(a['id']), status: n !== 0 })) }),
  };
  await assert.rejects(indexItemPassages({ id: 'p', source: 'note', title: 'T', body: 'hello', projectContext: 'x' }, new Map(), deps), PassageIndexError);
});

test('IDX-03 repeated edits coalesce to one row at the newest revision', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', title: 'T', body: 'one' });
  const first = await getWork(db, id);
  await db.query(`UPDATE content_items SET body = 'two' WHERE id = $1`, [id]);
  await db.query(`UPDATE content_items SET body = 'three' WHERE id = $1`, [id]);
  const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM knowledge_indexing_work`);
  assert.equal(rows.rows[0]!.n, '1');
  const last = await getWork(db, id);
  assert.notEqual(last?.revision, first?.revision);
  assert.equal(await enqueueContentItemIndex(db, id), false, 'same revision does not re-enqueue');
});

test('IDX-04 deletion wins over pending index work and leaves a tombstone', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  await db.query(`DELETE FROM content_items WHERE id = $1`, [id]);
  const work = await getWork(db, id);
  assert.equal(work?.operation, 'delete');
  assert.equal(work?.status, 'pending');
  assert.equal(await enqueueContentItemIndex(db, id), false);
  const removed: string[] = [];
  const indexed: string[] = [];
  const result = await runIndexingBatch(db, { index: async r => { indexed.push(r); }, remove: async r => { removed.push(r); } }, { now: T0 });
  assert.deepEqual(removed, [id]);
  assert.deepEqual(indexed, []);
  assert.equal(result.done, 1);
  assert.equal((await getWork(db, id))?.operation, 'delete');
  assert.equal((await getWork(db, id))?.status, 'done');
});

test('IDX-05 a late index completion cannot overwrite a newer revision or a delete', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'v1' });
  const { token, items } = await claimIndexingWork(db, { now: T0 });
  await db.query(`UPDATE content_items SET body = 'v2' WHERE id = $1`, [id]);
  assert.equal(await completeIndexingWork(db, items[0]!, token, at(1000)), 'superseded');
  assert.equal((await getWork(db, id))?.status, 'pending');
  const second = await claimIndexingWork(db, { now: at(2000) });
  await db.query(`DELETE FROM content_items WHERE id = $1`, [id]);
  assert.equal(await completeIndexingWork(db, second.items[0]!, second.token, at(3000)), 'superseded');
  assert.equal((await getWork(db, id))?.operation, 'delete');
});

test('IDX-05 compensates when an index write lands after a delete', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'v1' });
  const removed: string[] = [];
  const handlers: IndexingHandlers = {
    index: async () => { await db.query(`DELETE FROM content_items WHERE id = $1`, [id]); },
    remove: async r => { removed.push(r); },
  };
  const result = await runIndexingBatch(db, handlers, { now: T0 });
  assert.equal(result.superseded, 1);
  assert.deepEqual(removed, [id]);
});

test('IDX-06 retries back off and stop after five attempts; explicit retry resets', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  const failing: IndexingHandlers = { index: async () => { throw new IndexingFailure('timeout'); }, remove: noop.remove };
  let clock = 0;
  const delays: number[] = [];
  for (let attempt = 1; attempt <= INDEXING_MAX_ATTEMPTS; attempt++) {
    clock += 10 * 3_600_000;
    await runIndexingBatch(db, failing, { now: at(clock) });
    const w = (await getWork(db, id))!;
    delays.push(Date.parse(w.nextAttemptAt) - at(clock).getTime());
  }
  const work = (await getWork(db, id))!;
  assert.equal(work.status, 'failed');
  assert.equal(work.attempts, INDEXING_MAX_ATTEMPTS);
  assert.equal(work.errorCode, 'attempts_exhausted');
  assert.ok(delays[1]! > delays[0]!);
  assert.equal((await claimIndexingWork(db, { now: at(clock + 100 * 3_600_000) })).items.length, 0);
  assert.equal((await summariseIndexingWork(db)).failed, 1);
  assert.equal(await retryFailedWork(db, id, at(clock)), true);
  assert.equal((await getWork(db, id))?.attempts, 0);
});

test('IDX-07 expired leases are recovered; a lease lost on the last attempt fails safely', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  const first = await claimIndexingWork(db, { now: T0 });
  assert.equal(first.items.length, 1);
  assert.equal((await claimIndexingWork(db, { now: at(60_000) })).items.length, 0, 'live lease is not stolen');
  const recovered = await claimIndexingWork(db, { now: at(6 * 60_000) });
  assert.equal(recovered.items.length, 1);
  assert.equal(recovered.items[0]!.attempts, 1);
  await db.query(`UPDATE knowledge_indexing_work SET attempts = $2 WHERE ref_id = $1`, [id, INDEXING_MAX_ATTEMPTS - 1]);
  await claimIndexingWork(db, { now: at(20 * 60_000) });
  assert.equal((await getWork(db, id))?.status, 'failed');
  assert.equal((await getWork(db, id))?.errorCode, 'lease_expired');
});

test('IDX-08 work is claimed in keyset batches of at most 100 with at most 2 concurrent handlers', async () => {
  const db = await phase2Db();
  for (let i = 0; i < 250; i++) await db.query(`INSERT INTO content_items (source, source_id, title, body) VALUES ('note', $1, 'T', $2)`, [`n${i}`, `b${i}`]);
  let live = 0;
  let peak = 0;
  const handlers: IndexingHandlers = {
    index: async () => { live += 1; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 1)); live -= 1; },
    remove: noop.remove,
  };
  const admission = createAdmission();
  const sizes: number[] = [];
  let afterId = 0;
  for (;;) {
    const batch = await runIndexingBatch(db, handlers, { now: T0, afterId, concurrency: 8, admission });
    if (batch.claimed === 0) break;
    sizes.push(batch.claimed);
    afterId = batch.lastId;
  }
  assert.deepEqual(sizes, [100, 100, 50]);
  assert.equal(peak, 2);
  assert.equal(admission.stats().indexMaxInFlight, 1);
  assert.equal((await summariseIndexingWork(db)).done, 250);
});

test('IDX-09 chunking is deterministic, heading-aware, bounded and offset-exact', () => {
  const sections = Array.from({ length: 12 }, (_, s) => `## Section ${s}\n\n${Array.from({ length: 6 }, (_, p) => `Paragraph ${s}.${p} ${'word '.repeat(120)}`).join('\n\n')}`);
  const text = `${sections.join('\n\n')}\n\nTAIL-FACT: the launch code is 7421.`;
  assert.ok(text.length > 36_000);
  const chunks = chunkText('doc', text);
  assert.deepEqual(chunks, chunkText('doc', text));
  assert.ok(chunks.length > 8);
  for (const c of chunks) {
    assert.ok(c.text.length <= CHUNK_MAX_CHARS, `chunk ${c.ordinal} is ${c.text.length}`);
    assert.equal(text.slice(c.startOffset, c.endOffset), c.text);
    assert.equal(c.id, `doc_${c.ordinal}`);
  }
  assert.equal(chunks[0]!.startOffset, 0);
  assert.equal(chunks[chunks.length - 1]!.endOffset, text.length);
  assert.ok(chunks[chunks.length - 1]!.text.includes('TAIL-FACT: the launch code is 7421.'));
  assert.ok(chunks.some(c => c.headingPath.includes('Section 5')));
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i]!.startOffset <= chunks[i - 1]!.endOffset, 'no gaps');
  assert.ok(CHUNK_OVERLAP_CHARS === 400);
});

test('IDX-09 chunk boundaries never split a surrogate pair', () => {
  const text = '😀'.repeat(5000);
  for (const c of chunkText('emoji', text)) {
    assert.ok(!/^[\uDC00-\uDFFF]/.test(c.text) && !/[\uD800-\uDBFF]$/.test(c.text));
    assert.equal(text.slice(c.startOffset, c.endOffset), c.text);
  }
});

test('IDX-10 unchanged passages are skipped by hash; only changed ones are embedded', async () => {
  const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'text '.repeat(150)}`).join('\n\n');
  const embedded: number[] = [];
  const deps: PassageIndexDeps = {
    embedBatch: async texts => { embedded.push(texts.length); return texts.map(() => [0]); },
    post: async (_i, actions) => ({ value: actions.map(a => ({ key: String(a['id']), status: true })) }),
  };
  const item = { id: 'p', source: 'note', title: 'T', projectContext: 'x' };
  const first = await indexItemPassages({ ...item, body }, new Map(), deps);
  assert.equal(first.skipped, 0);
  const total = first.embedded;
  assert.ok(total > 4);
  embedded.length = 0;
  const same = await indexItemPassages({ ...item, body }, first.indexed, deps);
  assert.equal(same.embedded, 0);
  assert.equal(same.skipped, total);
  const edited = await indexItemPassages({ ...item, body: `${body}\n\nNew tail fact.` }, first.indexed, deps);
  assert.ok(edited.embedded >= 1 && edited.embedded < total);
  const plan = planChunks(chunkText('p', 'short'), new Map([[0, 'x'], [3, 'y']]));
  assert.deepEqual(plan.staleOrdinals, [3]);
});

test('IDX-11 dry-run estimates the backfill without writing or calling a provider', async () => {
  const db = await phase2Db();
  await db.query(`INSERT INTO content_items (source, source_id, title, body) VALUES ('note','a','A',$1),('note','b','B','')`, ['x'.repeat(7000)]);
  await db.query(`DELETE FROM knowledge_indexing_work`);
  const estimate = await estimateIndexingBackfill(db);
  assert.deepEqual(estimate, { items: 2, estimatedPassages: 4, embeddingInputChars: 7000 });
  assert.equal((await db.query(`SELECT 1 FROM knowledge_indexing_work`)).rows.length, 0);
  const page = await reconcileIndexingBacklog(db, { now: T0 });
  assert.equal(page.enqueued, 2);
  assert.equal(page.nextAfterId, null);
});

test('IDX-12 permanent failures go straight to failed with a safe code', async () => {
  const db = await phase2Db();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  const result = await runIndexingBatch(db, { index: async () => { throw new IndexingFailure('index_item_failed', true); }, remove: noop.remove }, { now: T0 });
  assert.equal(result.failed, 1);
  const work = (await getWork(db, id))!;
  assert.equal(work.status, 'failed');
  assert.equal(work.errorCode, 'index_item_failed');
  const unknown = await insertContent(db, { sourceId: 'm', body: 'y' });
  await runIndexingBatch(db, { index: async () => { throw new Error('secret provider detail'); }, remove: noop.remove }, { now: at(10 * 3_600_000) });
  assert.equal((await getWork(db, unknown))?.errorCode, 'unknown');
});
