/**
 * jobs/foundryIqBackfillJob.ts
 *
 * Daily job — pushes any content_items rows that are new or have changed
 * since they were last indexed into the Foundry IQ (Azure AI Search) index.
 *
 * Documents (routes/documents.ts) and notes (routes/notes.ts) are indexed
 * live on write, so they're searchable immediately. Every other source that
 * lands in content_items — commits, PRs, issues, releases, emails, calendar
 * events, GitLab items, discovered articles, CFP items, etc. — is written by
 * the various integrations/*Sync.ts jobs, none of which call the Foundry IQ
 * indexer. Without this job those rows would only ever be found by Postgres
 * full-text search (literal keyword match), not the semantic/paraphrase
 * search Foundry IQ provides — i.e. most of the platform's content would be
 * excluded from "everything should be queryable" semantic search.
 *
 * Processes oldest-pending-first (foundry_indexed_at IS NULL/oldest) so a
 * large historical backlog eventually gets fully covered across multiple
 * runs, rather than always reprocessing only the newest rows. Bounded to
 * BATCH_LIMIT per run to keep embedding-call cost/time predictable.
 */
import type { Pool } from 'pg';
import { getContentItemsPendingFoundryIndex, markContentItemFoundryIndexed } from '../db/queries.js';
import { canIndexToFoundryIq, indexContentItem } from '../ai/foundryIqIndexer.js';

const BATCH_LIMIT = 300;

/** Runs the Foundry IQ backfill job. All errors are logged, never thrown. */
export async function runFoundryIqBackfillJob(db: Pool): Promise<void> {
  if (!canIndexToFoundryIq()) {
    console.warn('[FoundryIqBackfill] Foundry IQ not configured — skipping.');
    return;
  }

  try {
    const items = await getContentItemsPendingFoundryIndex(db, BATCH_LIMIT);
    if (items.length === 0) {
      console.warn('[FoundryIqBackfill] Nothing pending — all content_items up to date.');
      return;
    }

    let indexed = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await indexContentItem(item);
        await markContentItemFoundryIndexed(db, item.id);
        indexed++;
      } catch (err) {
        failed++;
        console.error(
          `[FoundryIqBackfill] Failed to index ${item.source}:${item.sourceId}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    console.warn(`[FoundryIqBackfill] Indexed ${indexed}/${items.length} pending items (${failed} failed).`);
  } catch (err) {
    console.error('[FoundryIqBackfill] Job failed:', err instanceof Error ? err.message : String(err));
  }
}
