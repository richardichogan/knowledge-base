/* eslint-disable @typescript-eslint/no-magic-numbers -- time, size and ranking constants */
/**
 * Structured list/count (spec 5.5): authoritative task and change queries that
 * never go through ranked search. Pagination is keyset-based with an opaque
 * cursor bound to the filter; the total comes from the same SQL statement as
 * the page, so count and items describe one snapshot. A failed query throws —
 * it is never reported as a count of zero.
 */
import { createHash } from 'node:crypto';
import type { AdmittedQuery } from './admission.js';
import { resolveRelativeInterval, type KnowledgeInterval } from './intervalResolver.js';

export const STRUCTURED_DEFAULT_PAGE = 50;
export const STRUCTURED_MAX_PAGE = 100;

export class StructuredQueryError extends Error {
  constructor(readonly code: 'invalid_cursor' | 'invalid_filter', message: string) {
    super(message);
    this.name = 'StructuredQueryError';
  }
}

export interface TaskFilter {
  projectIds?: string[];
  statuses?: string[];
  includeArchived?: boolean;
  includeCompleted?: boolean;
  dueWithin?: KnowledgeInterval;
  updatedWithin?: KnowledgeInterval;
  /** Not completed and due before local today at `overdueAsOf`. */
  overdueAsOf?: Date;
}

export interface TaskPageRequest { filter: TaskFilter; limit?: number; cursor?: string }

export interface TaskRecord {
  id: string; title: string; status: string; projectId: string | null; priority: string | null;
  dueDate: string | null; updatedAt: string; archived: boolean;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Exact number of rows matching the filter in the same snapshot as the page. */
  total: number;
  totalExact: true;
}

const clampLimit = (limit: number | undefined): number => Math.min(Math.max(1, Math.trunc(limit ?? STRUCTURED_DEFAULT_PAGE)), STRUCTURED_MAX_PAGE);

const filterHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const encodeCursor = (payload: Record<string, unknown>): string => Buffer.from(JSON.stringify(payload)).toString('base64url');

function decodeCursor<T extends { h: string }>(cursor: string, hash: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new StructuredQueryError('invalid_cursor', 'Cursor is not valid.'); }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { h?: unknown }).h !== hash) {
    throw new StructuredQueryError('invalid_cursor', 'Cursor does not belong to this query.');
  }
  return parsed as T;
}

interface TaskRow {
  id: string; title: string; status: string; project_id: string | null; priority: string | null;
  due_text: string | null; updated_text: string; archived: boolean; total: string;
}

function taskWhere(filter: TaskFilter, values: unknown[]): string {
  const where: string[] = [];
  const bind = (v: unknown): string => { values.push(v); return `$${values.length}`; };
  if (filter.includeArchived !== true) where.push('t.archived = false');
  if (filter.projectIds !== undefined) where.push(`t.project_id = ANY(${bind(filter.projectIds)}::text[])`);
  if (filter.statuses !== undefined) where.push(`t.status = ANY(${bind(filter.statuses)}::text[])`);
  if (filter.includeCompleted === false) where.push(`t.status <> 'completed'`);
  if (filter.dueWithin !== undefined) {
    where.push(`t.due_date >= ${bind(filter.dueWithin.startLocalDate)}::date AND t.due_date < ${bind(filter.dueWithin.endLocalDate)}::date`);
  }
  if (filter.updatedWithin !== undefined) {
    where.push(`t.updated_at >= ${bind(filter.updatedWithin.startUtc)}::timestamptz AND t.updated_at < ${bind(filter.updatedWithin.endUtc)}::timestamptz`);
  }
  if (filter.overdueAsOf !== undefined) {
    const today = resolveRelativeInterval('today', filter.overdueAsOf).startLocalDate;
    where.push(`t.due_date < ${bind(today)}::date AND t.status <> 'completed'`);
  }
  return where.length === 0 ? 'TRUE' : where.join(' AND ');
}

function taskFilterIdentity(filter: TaskFilter): unknown {
  return { ...filter, overdueAsOf: filter.overdueAsOf === undefined ? null : filter.overdueAsOf.toISOString().slice(0, 13) };
}

export async function listTasks(q: AdmittedQuery, request: TaskPageRequest): Promise<Page<TaskRecord>> {
  const limit = clampLimit(request.limit);
  const hash = filterHash(taskFilterIdentity(request.filter));
  const values: unknown[] = [];
  const where = taskWhere(request.filter, values);
  let after = 'TRUE';
  if (request.cursor !== undefined) {
    const c = decodeCursor<{ h: string; d: string | null; id: string }>(request.cursor, hash);
    values.push(c.id);
    const idParam = `$${values.length}`;
    if (c.d === null) after = `(f.due_text IS NULL AND f.id > ${idParam})`;
    else {
      values.push(c.d);
      after = `(f.due_text IS NULL OR f.due_text > $${values.length} OR (f.due_text = $${values.length} AND f.id > ${idParam}))`;
    }
  }
  values.push(limit + 1);
  const { rows } = await q.query<TaskRow>(
    `WITH f AS (
       SELECT t.id, t.title, t.status, t.project_id, t.priority, to_char(t.due_date, 'YYYY-MM-DD') AS due_text,
              to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_text, t.archived
         FROM tasks t WHERE ${where}),
     total AS (SELECT count(*) AS n FROM f)
     SELECT f.*, total.n::text AS total FROM total
       LEFT JOIN LATERAL (SELECT * FROM f WHERE ${after} ORDER BY due_text ASC NULLS LAST, id ASC LIMIT $${values.length}) f ON TRUE`,
    values,
  );
  const total = Number(rows[0]?.total ?? 0);
  const real = rows.filter(r => r.id !== null);
  const pageRows = real.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const hasMore = real.length > limit;
  return {
    items: pageRows.map(r => ({
      id: r.id, title: r.title, status: r.status, projectId: r.project_id, priority: r.priority,
      dueDate: r.due_text, updatedAt: r.updated_text, archived: r.archived,
    })),
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor({ h: hash, d: last.due_text, id: last.id }) : null,
    total,
    totalExact: true,
  };
}

export async function countTasks(q: AdmittedQuery, filter: TaskFilter): Promise<{ total: number; totalExact: true }> {
  const values: unknown[] = [];
  const { rows } = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM tasks t WHERE ${taskWhere(filter, values)}`, values);
  return { total: Number(rows[0]?.n ?? 0), totalExact: true };
}

// ── content changes ─────────────────────────────────────────────────────────

/** Source-system last-touched time (not our indexing/import time). */
export const ACTIVITY_AT_SQL = `COALESCE(
  CASE WHEN ci.metadata->>'updatedAt' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (ci.metadata->>'updatedAt')::timestamptz END, ci.published_at)`;

export interface ChangeFilter { within: KnowledgeInterval; projectIds?: string[]; sources?: string[] }
export interface ChangeRecord { id: string; source: string; title: string; projectId: string; activityAt: string }

interface ChangeRow { id: string; source: string; title: string; project_context: string; activity_text: string; total: string }

export async function listContentChanges(
  q: AdmittedQuery, request: { filter: ChangeFilter; limit?: number; cursor?: string },
): Promise<Page<ChangeRecord>> {
  const limit = clampLimit(request.limit);
  const { filter } = request;
  const hash = filterHash(filter);
  const values: unknown[] = [filter.within.startUtc, filter.within.endUtc];
  const where = [`a.activity_at >= $1::timestamptz AND a.activity_at < $2::timestamptz`];
  if (filter.projectIds !== undefined) { values.push(filter.projectIds); where.push(`a.project_context = ANY($${values.length}::text[])`); }
  if (filter.sources !== undefined) { values.push(filter.sources); where.push(`a.source = ANY($${values.length}::text[])`); }
  let after = 'TRUE';
  if (request.cursor !== undefined) {
    const c = decodeCursor<{ h: string; at: string; id: string }>(request.cursor, hash);
    values.push(c.at, c.id);
    after = `(a.activity_at < $${values.length - 1}::timestamptz OR (a.activity_at = $${values.length - 1}::timestamptz AND a.id::text > $${values.length}))`;
  }
  values.push(limit + 1);
  const { rows } = await q.query<ChangeRow>(
    `WITH a AS (SELECT ci.id, ci.source, ci.title, ci.project_context, ${ACTIVITY_AT_SQL} AS activity_at FROM content_items ci),
     f AS (SELECT * FROM a WHERE ${where.join(' AND ')}),
     total AS (SELECT count(*) AS n FROM f)
     SELECT p.id::text AS id, p.source, p.title, p.project_context,
            to_char(p.activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activity_text, total.n::text AS total
       FROM total LEFT JOIN LATERAL (SELECT * FROM f a WHERE ${after} ORDER BY a.activity_at DESC, a.id::text ASC LIMIT $${values.length}) p ON TRUE`,
    values,
  );
  const total = Number(rows[0]?.total ?? 0);
  const real = rows.filter(r => r.id !== null);
  const pageRows = real.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const hasMore = real.length > limit;
  return {
    items: pageRows.map(r => ({ id: r.id, source: r.source, title: r.title, projectId: r.project_context, activityAt: r.activity_text })),
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor({ h: hash, at: last.activity_text, id: last.id }) : null,
    total,
    totalExact: true,
  };
}
