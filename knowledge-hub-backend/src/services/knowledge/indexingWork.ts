/* eslint-disable @typescript-eslint/no-magic-numbers -- time, size and ranking constants */
/**
 * Durable indexing work (spec 6.2/6.3): one row per canonical ref, coalesced
 * to the newest revision, with deletion precedence and tombstones, leases,
 * bounded retries and keyset batches. The service never calls a semantic
 * provider itself; callers supply handlers, so a provider outage can only
 * delay indexing, never lose an edit.
 */
import { randomUUID } from 'node:crypto';
import { admitQueries, type Admission, type AdmittedQuery, type QueryRows, processAdmission } from './admission.js';

export const INDEXING_MAX_ATTEMPTS = 5;
export const INDEXING_BATCH_SIZE = 100;
export const INDEXING_CONCURRENCY = 2;
export const INDEXING_LEASE_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;

/** SQL expression for the revision of a content item; also used by the DB trigger. */
export function contentRevisionSql(alias = 'content_items'): string {
  return `md5(concat_ws(chr(31), ${alias}.title, ${alias}.summary, ${alias}.body, ${alias}.project_context, array_to_string(${alias}.tags, ',')))`;
}

export type IndexingOperation = 'index' | 'delete';
export type IndexingStatus = 'pending' | 'leased' | 'done' | 'failed';
export type IndexingErrorCode =
  | 'semantic_unavailable' | 'index_item_failed' | 'timeout' | 'permanent'
  | 'attempts_exhausted' | 'lease_expired' | 'unknown';

export interface IndexingWork {
  id: number;
  refKind: string;
  refId: string;
  operation: IndexingOperation;
  revision: string;
  status: IndexingStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  errorCode: IndexingErrorCode | null;
}

interface WorkRow {
  id: string; ref_kind: string; ref_id: string; operation: IndexingOperation; revision: string; status: IndexingStatus;
  attempts: number; next_attempt_at: Date | string; lease_token: string | null; lease_expires_at: Date | string | null; error_code: IndexingErrorCode | null;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
const toWork = (r: WorkRow): IndexingWork => ({
  id: Number(r.id), refKind: r.ref_kind, refId: r.ref_id, operation: r.operation, revision: r.revision, status: r.status,
  attempts: r.attempts, nextAttemptAt: iso(r.next_attempt_at)!, leaseToken: r.lease_token, leaseExpiresAt: iso(r.lease_expires_at), errorCode: r.error_code,
});

export interface WorkQueryable {
  query<R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryRows<R>>;
}

/** A failure with a safe code; permanent failures stop automatic retries at once. */
export class IndexingFailure extends Error {
  constructor(readonly code: IndexingErrorCode, readonly permanent = false) {
    super(`Indexing failed: ${code}`);
    this.name = 'IndexingFailure';
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

const CONTENT_KIND = 'content_item';

/** Enqueues the current revision of a content item; false when coalesced/unchanged/tombstoned. */
export async function enqueueContentItemIndex(q: WorkQueryable, contentItemId: string, now = new Date()): Promise<boolean> {
  const result = await q.query(
    `INSERT INTO knowledge_indexing_work (ref_kind, ref_id, operation, revision, status, next_attempt_at, updated_at)
     SELECT '${CONTENT_KIND}', ci.id::text, 'index', ${contentRevisionSql('ci')}, 'pending', $2, $2
       FROM content_items ci WHERE ci.id::text = $1
     ON CONFLICT (ref_kind, ref_id) DO UPDATE SET
       revision = EXCLUDED.revision, status = 'pending', attempts = 0, error_code = NULL, lease_token = NULL,
       lease_expires_at = NULL, next_attempt_at = EXCLUDED.next_attempt_at, updated_at = EXCLUDED.updated_at, completed_at = NULL
     WHERE knowledge_indexing_work.operation = 'index' AND knowledge_indexing_work.revision <> EXCLUDED.revision
     RETURNING id`,
    [contentItemId, now],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Records a deletion; it always wins over any pending or leased index work. */
export async function enqueueContentItemDelete(q: WorkQueryable, contentItemId: string, now = new Date()): Promise<boolean> {
  const result = await q.query(
    `INSERT INTO knowledge_indexing_work (ref_kind, ref_id, operation, revision, status, next_attempt_at, updated_at)
     VALUES ('${CONTENT_KIND}', $1, 'delete', 'deleted', 'pending', $2, $2)
     ON CONFLICT (ref_kind, ref_id) DO UPDATE SET
       operation = 'delete', revision = 'deleted', status = 'pending', attempts = 0, error_code = NULL, lease_token = NULL,
       lease_expires_at = NULL, next_attempt_at = EXCLUDED.next_attempt_at, updated_at = EXCLUDED.updated_at, completed_at = NULL
     WHERE NOT (knowledge_indexing_work.operation = 'delete')
     RETURNING id`,
    [contentItemId, now],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function isTombstoned(q: WorkQueryable, contentItemId: string): Promise<boolean> {
  const { rows } = await q.query<{ operation: string }>(
    `SELECT operation FROM knowledge_indexing_work WHERE ref_kind = '${CONTENT_KIND}' AND ref_id = $1`, [contentItemId]);
  return rows[0]?.operation === 'delete';
}

export async function getWork(q: WorkQueryable, contentItemId: string): Promise<IndexingWork | null> {
  const { rows } = await q.query<WorkRow>(
    `SELECT * FROM knowledge_indexing_work WHERE ref_kind = '${CONTENT_KIND}' AND ref_id = $1`, [contentItemId]);
  return rows[0] === undefined ? null : toWork(rows[0]);
}

export interface ClaimOptions { now?: Date; limit?: number; afterId?: number; leaseMs?: number; token?: string }

/** Claims due work (pending, or leased with an expired lease) in keyset order. */
export async function claimIndexingWork(q: WorkQueryable, options: ClaimOptions = {}): Promise<{ token: string; items: IndexingWork[] }> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(1, options.limit ?? INDEXING_BATCH_SIZE), INDEXING_BATCH_SIZE);
  const token = options.token ?? randomUUID();
  // A lease that expired for the last allowed attempt is a permanent failure.
  await q.query(
    `UPDATE knowledge_indexing_work SET status = 'failed', error_code = 'lease_expired', attempts = attempts + 1, lease_token = NULL, updated_at = $1
      WHERE status = 'leased' AND lease_expires_at <= $1 AND attempts + 1 >= $2`,
    [now, INDEXING_MAX_ATTEMPTS],
  );
  const { rows } = await q.query<WorkRow>(
    `WITH due AS (
       SELECT id FROM knowledge_indexing_work
        WHERE id > $1 AND ((status = 'pending' AND next_attempt_at <= $2) OR (status = 'leased' AND lease_expires_at <= $2))
        ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED)
     UPDATE knowledge_indexing_work w SET
       attempts = w.attempts + CASE WHEN w.status = 'leased' THEN 1 ELSE 0 END,
       status = 'leased', lease_token = $4, lease_expires_at = $5, updated_at = $2
       FROM due WHERE w.id = due.id RETURNING w.*`,
    [options.afterId ?? 0, now, limit, token, new Date(now.getTime() + (options.leaseMs ?? INDEXING_LEASE_MS))],
  );
  return { token, items: rows.map(toWork).sort((a, b) => a.id - b.id) };
}

export type CompletionOutcome = 'done' | 'superseded';

/** Marks work done only if this lease still owns the same revision. */
export async function completeIndexingWork(q: WorkQueryable, work: IndexingWork, token: string, now = new Date()): Promise<CompletionOutcome> {
  const result = await q.query(
    `UPDATE knowledge_indexing_work SET status = 'done', lease_token = NULL, lease_expires_at = NULL, error_code = NULL, completed_at = $4, updated_at = $4
      WHERE id = $1 AND lease_token = $2 AND revision = $3 RETURNING id`,
    [work.id, token, work.revision, now],
  );
  return (result.rowCount ?? result.rows.length) > 0 ? 'done' : 'superseded';
}

export type FailureOutcome = 'retry' | 'failed' | 'superseded';

export async function failIndexingWork(
  q: WorkQueryable, work: IndexingWork, token: string, failure: IndexingFailure, now = new Date(),
): Promise<FailureOutcome> {
  const attempts = work.attempts + 1;
  const exhausted = failure.permanent || attempts >= INDEXING_MAX_ATTEMPTS;
  const code: IndexingErrorCode = failure.permanent ? failure.code : exhausted ? 'attempts_exhausted' : failure.code;
  const result = await q.query(
    `UPDATE knowledge_indexing_work SET attempts = $4, status = $5, error_code = $6, lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = $7, updated_at = $8
      WHERE id = $1 AND lease_token = $2 AND revision = $3 RETURNING id`,
    [work.id, token, work.revision, attempts, exhausted ? 'failed' : 'pending', code,
      new Date(now.getTime() + (exhausted ? 0 : backoffMs(attempts))), now],
  );
  if ((result.rowCount ?? result.rows.length) === 0) return 'superseded';
  return exhausted ? 'failed' : 'retry';
}

/** Explicit repair: failed work for the same revision becomes eligible again. */
export async function retryFailedWork(q: WorkQueryable, contentItemId: string, now = new Date()): Promise<boolean> {
  const result = await q.query(
    `UPDATE knowledge_indexing_work SET status = 'pending', attempts = 0, error_code = NULL, next_attempt_at = $2, updated_at = $2
      WHERE ref_kind = '${CONTENT_KIND}' AND ref_id = $1 AND status = 'failed' RETURNING id`,
    [contentItemId, now],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export interface IndexingHandlers {
  index(refId: string, revision: string): Promise<void>;
  remove(refId: string): Promise<void>;
}

export interface BatchResult { claimed: number; done: number; retried: number; failed: number; superseded: number; lastId: number }

/**
 * Runs one keyset batch. Work-table queries go through the single index-worker
 * admission slot; handler calls run with at most `concurrency` in flight.
 */
export async function runIndexingBatch(
  db: WorkQueryable,
  handlers: IndexingHandlers,
  options: ClaimOptions & { concurrency?: number; admission?: Admission } = {},
): Promise<BatchResult> {
  const q: AdmittedQuery = admitQueries(db as never, { kind: 'index' }, { admission: options.admission ?? processAdmission });
  const clock = (): Date => options.now ?? new Date();
  const { token, items } = await claimIndexingWork(q, options);
  const result: BatchResult = { claimed: items.length, done: 0, retried: 0, failed: 0, superseded: 0, lastId: options.afterId ?? 0 };
  const concurrency = Math.min(Math.max(1, options.concurrency ?? INDEXING_CONCURRENCY), INDEXING_CONCURRENCY);
  let next = 0;

  const processOne = async (work: IndexingWork): Promise<void> => {
    result.lastId = Math.max(result.lastId, work.id);
    try {
      if (work.operation === 'delete') await handlers.remove(work.refId);
      else await handlers.index(work.refId, work.revision);
    } catch (err) {
      const failure = err instanceof IndexingFailure ? err : new IndexingFailure('unknown');
      const outcome = await failIndexingWork(q, work, token, failure, clock());
      if (outcome === 'retry') result.retried += 1;
      else if (outcome === 'failed') result.failed += 1;
      else result.superseded += 1;
      return;
    }
    if (await completeIndexingWork(q, work, token, clock()) === 'done') { result.done += 1; return; }
    result.superseded += 1;
    // A late index write may have landed after a delete: compensate once.
    if (work.operation === 'index' && await isTombstoned(q, work.refId)) {
      await handlers.remove(work.refId).catch(() => undefined);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) await processOne(items[i]!);
  }));
  return result;
}

export interface WorkSummary { pending: number; leased: number; done: number; failed: number; failedCodes: Record<string, number> }

export async function summariseIndexingWork(q: WorkQueryable): Promise<WorkSummary> {
  const { rows } = await q.query<{ status: IndexingStatus; error_code: string | null; n: string }>(
    `SELECT status, error_code, count(*)::text AS n FROM knowledge_indexing_work
      WHERE operation = 'index' OR status <> 'done' GROUP BY status, error_code`);
  const summary: WorkSummary = { pending: 0, leased: 0, done: 0, failed: 0, failedCodes: {} };
  for (const row of rows) {
    summary[row.status] += Number(row.n);
    if (row.status === 'failed') summary.failedCodes[row.error_code ?? 'unknown'] = Number(row.n);
  }
  return summary;
}

export interface BackfillEstimate { items: number; estimatedPassages: number; embeddingInputChars: number }

/** Dry-run: how much a backfill would embed. No writes and no provider calls. */
export async function estimateIndexingBackfill(q: WorkQueryable, targetChunkChars = 3000): Promise<BackfillEstimate> {
  const { rows } = await q.query<{ items: string; passages: string | null; chars: string | null }>(
    `SELECT count(*)::text AS items,
            sum(greatest(1, ceil(length(body)::numeric / $1)))::text AS passages,
            sum(length(body))::text AS chars
       FROM content_items ci
      WHERE (foundry_indexed_at IS NULL OR foundry_indexed_at < updated_at)
        AND NOT EXISTS (SELECT 1 FROM note_github_publications p WHERE ci.source IN ('github-doc', 'github-content-store')
          AND lower(p.repo) = lower(ci.metadata->>'repo') AND p.path = ci.metadata->>'path')`,
    [targetChunkChars],
  );
  const row = rows[0];
  return { items: Number(row?.items ?? 0), estimatedPassages: Number(row?.passages ?? 0), embeddingInputChars: Number(row?.chars ?? 0) };
}

/** Enqueues one keyset page (at most 100) of unindexed items; resume with the returned cursor. */
export async function reconcileIndexingBacklog(
  q: WorkQueryable, options: { afterId?: string; limit?: number; now?: Date } = {},
): Promise<{ enqueued: number; scanned: number; nextAfterId: string | null }> {
  const limit = Math.min(Math.max(1, options.limit ?? INDEXING_BATCH_SIZE), INDEXING_BATCH_SIZE);
  const { rows } = await q.query<{ id: string }>(
    `SELECT ci.id::text AS id FROM content_items ci
      WHERE (ci.foundry_indexed_at IS NULL OR ci.foundry_indexed_at < ci.updated_at) AND ($1::text IS NULL OR ci.id::text > $1)
        AND NOT EXISTS (SELECT 1 FROM note_github_publications p WHERE ci.source IN ('github-doc', 'github-content-store')
          AND lower(p.repo) = lower(ci.metadata->>'repo') AND p.path = ci.metadata->>'path')
      ORDER BY ci.id::text LIMIT $2`,
    [options.afterId ?? null, limit],
  );
  let enqueued = 0;
  for (const row of rows) if (await enqueueContentItemIndex(q, row.id, options.now)) enqueued += 1;
  return { enqueued, scanned: rows.length, nextAfterId: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

export async function loadPassageHashes(q: WorkQueryable, parentId: string): Promise<Map<number, string>> {
  const { rows } = await q.query<{ ordinal: number; chunk_hash: string }>(
    `SELECT ordinal, chunk_hash FROM knowledge_indexed_passages WHERE parent_id = $1`, [parentId]);
  return new Map(rows.map((r) => [r.ordinal, r.chunk_hash]));
}

export async function recordPassages(
  q: WorkQueryable, parentId: string, indexed: ReadonlyMap<number, string>, staleOrdinals: number[],
): Promise<void> {
  for (const [ordinal, hash] of indexed) {
    await q.query(
      `INSERT INTO knowledge_indexed_passages (parent_id, ordinal, chunk_hash) VALUES ($1, $2, $3)
       ON CONFLICT (parent_id, ordinal) DO UPDATE SET chunk_hash = EXCLUDED.chunk_hash, indexed_at = NOW()`,
      [parentId, ordinal, hash],
    );
  }
  if (staleOrdinals.length > 0) {
    await q.query(`DELETE FROM knowledge_indexed_passages WHERE parent_id = $1 AND ordinal = ANY($2::int[])`, [parentId, staleOrdinals]);
  }
}

export async function clearPassages(q: WorkQueryable, parentId: string): Promise<void> {
  await q.query(`DELETE FROM knowledge_indexed_passages WHERE parent_id = $1`, [parentId]);
}
