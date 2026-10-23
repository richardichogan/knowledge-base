/**
 * jobs/taggingSweepJob.ts
 * Tags content items that were never attempted and retries failed attempts.
 *
 * Tagging on insert is fire-and-forget, so a model error or rate limit used to leave an item
 * untagged for good. Each run takes a bounded batch, oldest-due first, one model call at a time
 * (tagContent also caps concurrency). Items where nothing fitted ('no_fit') are not retried.
 *
 * Exported:
 *   selectTaggingCandidates() — content items due for tagging (shared with POST /api/taxonomy/retag)
 *   tagCandidate()            — tags one candidate from its best available text
 *   runTaggingSweepJob()      — one bounded sweep
 */
import type { Pool } from 'pg';
import { TAGGABLE_SOURCES, tagContent, taggingText, TAG_TEXT_CHARS } from '../services/taxonomyService.js';

const SWEEP_BATCH = 300;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MINUTES = 60;

export interface TaggingCandidate {
  id: string; source: string; title: string; summary: string | null; body: string | null;
  url: string | null; project_context: string | null;
}

/** Items in a taggable source, never attempted or failed (fewer than MAX_ATTEMPTS, not just now). */
export async function selectTaggingCandidates(db: Pool, limit: number | null): Promise<TaggingCandidate[]> {
  const rows = await db.query<TaggingCandidate>(
    `SELECT id, source, title, summary, body, url, project_context
       FROM content_items
      WHERE source = ANY($1::text[])
        AND (tagging_status IS NULL
             OR (tagging_status = 'failed' AND tagging_attempts < $2
                 AND tagging_attempted_at < now() - make_interval(mins => $3)))
      ORDER BY indexed_at DESC
      ${limit === null ? '' : 'LIMIT $4'}`,
    limit === null ? [TAGGABLE_SOURCES, MAX_ATTEMPTS, RETRY_AFTER_MINUTES] : [TAGGABLE_SOURCES, MAX_ATTEMPTS, RETRY_AFTER_MINUTES, limit],
  );
  return rows.rows;
}

export async function tagCandidate(db: Pool, item: TaggingCandidate): Promise<void> {
  await tagContent(db, taggingText(item), item.id, item.source, item.title, {
    projectContext: item.project_context, url: item.url, maxChars: TAG_TEXT_CHARS,
  });
}

export async function runTaggingSweepJob(db: Pool): Promise<{ processed: number }> {
  const candidates = await selectTaggingCandidates(db, SWEEP_BATCH);
  for (const item of candidates) await tagCandidate(db, item);
  if (candidates.length > 0) console.warn(`[TaggingSweep] processed ${candidates.length.toString()} items`);
  return { processed: candidates.length };
}
