/**
 * services/taxonomyBackfillService.ts
 * Iterates all existing content rows and yields BackfillCandidate objects
 * for the backfill CLI to process in batches.
 */
import type { Pool } from 'pg';

const DEFAULT_PAGE_SIZE = 100;
const SUMMARY_MAX_CHARS = 2000;

/** Normalised content item ready for AI tagging. */
export interface BackfillCandidate {
  id: string;
  contentType: 'discover_item' | 'cfp_item' | 'note' | 'document'
             | 'task' | 'commit' | 'pull_request';
  summary: string;
  title: string;
}

/** Estimate of total candidates across all tables. */
export async function countCandidates(db: Pool): Promise<number> {
  const r = await db.query<{ n: string }>(`
    SELECT (
      (SELECT COUNT(*) FROM content_items WHERE source = 'discovered-article') +
      (SELECT COUNT(*) FROM cfp_items) +
      (SELECT COUNT(*) FROM notes) +
      (SELECT COUNT(*) FROM content_items WHERE source = 'document') +
      (SELECT COUNT(*) FROM tasks) +
      (SELECT COUNT(*) FROM content_items WHERE source LIKE 'github-commits%' OR source LIKE 'gitlab-commits%') +
      (SELECT COUNT(*) FROM content_items WHERE source LIKE '%prs%' OR source LIKE '%merge-requests%')
    ) AS n
  `);
  return parseInt(r.rows[0]?.n ?? '0', 10);
}

/**
 * Yield all BackfillCandidates in pages of `pageSize`.
 * Caller iterates the async generator and processes batches.
 */
export async function* iterateCandidates(
  db: Pool,
  pageSize = DEFAULT_PAGE_SIZE,
): AsyncGenerator<BackfillCandidate[]> {
  yield* iterateContentItems(db, 'discovered-article', 'discover_item', pageSize);
  yield* iterateCfpItems(db, pageSize);
  yield* iterateNotes(db, pageSize);
  yield* iterateContentItems(db, 'document', 'document', pageSize);
  yield* iterateTasks(db, pageSize);
  yield* iterateContentItemsBySourcePattern(db, '%commit%', 'commit', pageSize);
  yield* iterateContentItemsBySourcePattern(db, '%prs%', 'pull_request', pageSize);
  yield* iterateContentItemsBySourcePattern(db, '%merge-request%', 'pull_request', pageSize);
}

// ── Private iterators ─────────────────────────────────────────────────────────

async function* iterateContentItems(
  db: Pool,
  source: string,
  contentType: BackfillCandidate['contentType'],
  pageSize: number,
): AsyncGenerator<BackfillCandidate[]> {
  let offset = 0;
  while (true) {
    const rows = await db.query<{ id: string; title: string; summary: string; body: string; source_name: string }>(
      `SELECT id, title, summary, body, source AS source_name
       FROM content_items WHERE source = $1
       ORDER BY published_at DESC LIMIT $2 OFFSET $3`,
      [source, pageSize, offset],
    );
    if (rows.rows.length === 0) break;
    yield rows.rows.map((r) => ({
      id: r.id,
      contentType,
      title: r.title,
      summary: buildDiscoverSummary(r).slice(0, SUMMARY_MAX_CHARS),
    }));
    offset += pageSize;
    if (rows.rows.length < pageSize) break;
  }
}

async function* iterateContentItemsBySourcePattern(
  db: Pool,
  pattern: string,
  contentType: BackfillCandidate['contentType'],
  pageSize: number,
): AsyncGenerator<BackfillCandidate[]> {
  let offset = 0;
  while (true) {
    const rows = await db.query<{ id: string; title: string; summary: string; body: string }>(
      `SELECT id, title, summary, body FROM content_items WHERE source ILIKE $1
       ORDER BY published_at DESC LIMIT $2 OFFSET $3`,
      [pattern, pageSize, offset],
    );
    if (rows.rows.length === 0) break;
    yield rows.rows.map((r) => ({
      id: r.id, contentType, title: r.title,
      summary: `${r.title}\n${r.summary}\n${r.body}`.slice(0, SUMMARY_MAX_CHARS),
    }));
    offset += pageSize;
    if (rows.rows.length < pageSize) break;
  }
}

async function* iterateCfpItems(db: Pool, pageSize: number): AsyncGenerator<BackfillCandidate[]> {
  let offset = 0;
  while (true) {
    const rows = await db.query<{ id: string; conference_name: string; description: string | null; tags: string[] }>(
      `SELECT id, conference_name, description, tags FROM cfp_items
       ORDER BY discovered_at DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );
    if (rows.rows.length === 0) break;
    yield rows.rows.map((r) => ({
      id: r.id, contentType: 'cfp_item' as const, title: r.conference_name,
      summary: `${r.conference_name} — ${r.description ?? ''} (Tags: ${r.tags.join(', ')})`.slice(0, SUMMARY_MAX_CHARS),
    }));
    offset += pageSize;
    if (rows.rows.length < pageSize) break;
  }
}

async function* iterateNotes(db: Pool, pageSize: number): AsyncGenerator<BackfillCandidate[]> {
  let offset = 0;
  while (true) {
    const rows = await db.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM notes ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );
    if (rows.rows.length === 0) break;
    yield rows.rows.map((r) => ({
      id: r.id, contentType: 'note' as const, title: r.title,
      summary: `${r.title}\n${r.body}`.slice(0, SUMMARY_MAX_CHARS),
    }));
    offset += pageSize;
    if (rows.rows.length < pageSize) break;
  }
}

async function* iterateTasks(db: Pool, pageSize: number): AsyncGenerator<BackfillCandidate[]> {
  let offset = 0;
  while (true) {
    const rows = await db.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM tasks ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );
    if (rows.rows.length === 0) break;
    yield rows.rows.map((r) => ({
      id: r.id, contentType: 'task' as const, title: r.title,
      summary: `${r.title}${r.body ? '\n' + r.body : ''}`.slice(0, SUMMARY_MAX_CHARS),
    }));
    offset += pageSize;
    if (rows.rows.length < pageSize) break;
  }
}

function buildDiscoverSummary(r: { title: string; summary: string; body: string; source_name: string }): string {
  return `${r.title} — ${r.summary} (Source: ${r.source_name})`;
}
