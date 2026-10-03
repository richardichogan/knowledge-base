/**
 * integrations/discovery/feedSync.ts — article discovery. Reads every active
 * source in `discovery_sources`, files new articles (last 14 days only) into
 * the Discover list as source='discovered-article', scores them, and shelves
 * articles that have sat unactioned (7 days; 14 for strong ones).
 *
 * This replaced reading discovered articles from the blog site's API.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { readFeed, fetchPageDescription } from './feedReader.js';
import { scoreUnscored } from '../cms/discoveredArticlesSync.js';

const SYNC_STATE_KEY = 'discovered-articles';
/** Only articles published this recently are filed — also bounds a brand-new source's first fetch. */
const RECENT_WINDOW_DAYS = 14;
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 86_400_000;
const MAX_PER_SOURCE_PER_RUN = 60;
const MAX_PAGE_DESCRIPTIONS = 25;
/** Scoring batches per sync run (50 articles each); a large backlog drains over several runs. */
const SCORING_BATCHES_PER_RUN = 6;

/** Days an article waits in To Review before it is shelved. Strong ones (>= STRONG_SCORE) get longer. */
export const SHELVE_AFTER_DAYS = 7;
export const SHELVE_AFTER_DAYS_STRONG = 14;
export const STRONG_SCORE = 0.8;

export interface DiscoverySource {
  id: string;
  title: string;
  feedUrl: string;
  groupName: string;
  isActive: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastNewCount: number;
  articlesFound: number;
}

interface SourceRow {
  id: string;
  title: string;
  feed_url: string;
  group_name: string;
  is_active: boolean;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  last_new_count: number;
  articles_found: number;
}

export function toSource(r: SourceRow): DiscoverySource {
  return {
    id: r.id, title: r.title, feedUrl: r.feed_url, groupName: r.group_name, isActive: r.is_active,
    lastCheckedAt: r.last_checked_at?.toISOString() ?? null, lastSuccessAt: r.last_success_at?.toISOString() ?? null,
    lastError: r.last_error, lastNewCount: r.last_new_count, articlesFound: r.articles_found,
  };
}

/** Checks one source and files its new articles. Returns how many were new. */
async function checkSource(db: Pool, source: SourceRow): Promise<number> {
  const articles = await readFeed(source.feed_url);
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = articles
    .map((a) => ({ ...a, publishedAt: a.publishedAt ?? new Date() }))
    .filter((a) => a.publishedAt.getTime() >= cutoff && a.publishedAt.getTime() <= Date.now() + 86_400_000)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, MAX_PER_SOURCE_PER_RUN);
  if (recent.length === 0) return 0;

  const known = await db.query<{ url: string }>(
    `SELECT url FROM content_items WHERE source = 'discovered-article' AND url = ANY($1)`,
    [recent.map((a) => a.url)],
  );
  const knownUrls = new Set(known.rows.map((r) => r.url));
  const fresh = recent.filter((a) => !knownUrls.has(a.url));

  // Feeds that publish titles only (IBM, DeepMind): borrow the page's own summary line.
  for (const a of fresh.slice(0, MAX_PAGE_DESCRIPTIONS)) {
    if (a.summary.length < 40) a.summary = (await fetchPageDescription(a.url)) || a.summary;
  }

  const discoveredAt = new Date().toISOString();
  for (const a of fresh) {
    await upsertContentItem(db, {
      source: 'discovered-article',
      sourceId: `feed-${createHash('sha1').update(a.url).digest('hex').slice(0, 24)}`,
      title: a.title,
      summary: `via ${source.title} · discovered ${discoveredAt.slice(0, 10)}`,
      body: a.summary,
      publishedAt: a.publishedAt.toISOString(),
      url: a.url,
      projectContext: 'msft-blog',
      metadata: {
        originalPublishedAt: a.publishedAt.toISOString(),
        discoveredAt,
        sourceTitle: source.title,
        sourceUrl: source.feed_url,
        sourceId: source.id,
        sourceGroup: source.group_name,
        status: 'new',
      },
      tags: [source.title],
    });
  }
  return fresh.length;
}

/**
 * Moves articles that have sat in To Review too long to Shelved. Nothing is deleted:
 * shelved articles stay searchable by Athena and can be restored from the Shelved tab.
 * The clock starts when Athena first saw the article, or when it was last restored.
 */
export async function shelveStaleArticles(db: Pool): Promise<number> {
  // Articles the scorer rates as not worth content (routed to Archive) go straight to Shelved: the new
  // feeds are high-volume and mostly routine, and these only add clutter. Still searchable by Athena.
  const low = await db.query(
    `UPDATE content_items
        SET workflow_state = 'shelved',
            metadata = metadata || jsonb_build_object('shelvedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'shelvedReason', 'low')
      WHERE source = 'discovered-article' AND workflow_state = 'to-review'
        AND metadata->>'platform' = 'Archive' AND COALESCE((metadata->>'scoringVersion')::int, 1) >= 2
        AND COALESCE(NULLIF(metadata->>'restoredAt', ''), '') = ''`,
  );
  const result = await db.query(
    `UPDATE content_items
        SET workflow_state = 'shelved',
            metadata = metadata || jsonb_build_object('shelvedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'shelvedReason', 'stale')
      WHERE source = 'discovered-article'
        AND workflow_state = 'to-review'
        AND GREATEST(indexed_at, COALESCE(NULLIF(metadata->>'restoredAt', '')::timestamptz, 'epoch'::timestamptz))
            < now() - (CASE WHEN COALESCE(relevance_score, 0) >= $1 THEN $2 ELSE $3 END) * interval '1 day'`,
    [STRONG_SCORE, SHELVE_AFTER_DAYS_STRONG, SHELVE_AFTER_DAYS],
  );
  return (low.rowCount ?? 0) + (result.rowCount ?? 0);
}

let backgroundWork: Promise<void> | null = null;

/** Scores new articles (a few batches) then assesses strong ones, without blocking the caller. */
function startBackgroundWork(db: Pool): void {
  if (backgroundWork !== null) return;
  backgroundWork = (async () => {
    for (let i = 0; i < SCORING_BATCHES_PER_RUN; i++) {
      const scored = await scoreUnscored(db).catch((err: unknown) => { console.warn('[Discovery] scoring failed:', err); return 0; });
      if (scored === 0) break;
    }
    // Strong articles get a deeper assessment (read in full, checked against his own work) for the daily content pick.
    const { runPendingDeepDives } = await import('../../ai/contentPick.js');
    await runPendingDeepDives(db, 3).catch((err: unknown) => { console.warn('[Discovery] deep dives failed:', err); });
  })().finally(() => { backgroundWork = null; });
}

export async function syncDiscoveryFeeds(db: Pool): Promise<{ indexed: number; errors: number }> {
  let indexed = 0;
  let errors = 0;

  const { rows: sources } = await db.query<SourceRow>(`SELECT * FROM discovery_sources WHERE is_active = true ORDER BY created_at`);
  for (const source of sources) {
    try {
      const added = await checkSource(db, source);
      indexed += added;
      await db.query(
        `UPDATE discovery_sources
            SET last_checked_at = NOW(), last_success_at = NOW(), last_error = NULL, last_new_count = $2, articles_found = articles_found + $2
          WHERE id = $1`,
        [source.id, added],
      );
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Discovery] ${source.title}: ${message}`);
      await db.query(`UPDATE discovery_sources SET last_checked_at = NOW(), last_error = $2, last_new_count = 0 WHERE id = $1`, [source.id, message.slice(0, 300)]);
    }
  }

  // Scoring and deep dives cost model calls and take minutes, so they run in the background (production
  // only — a local dev server shares this database) and never hold up the rest of the sync.
  if (!env.isDevelopment) startBackgroundWork(db);

  const shelved = await shelveStaleArticles(db).catch((err: unknown) => { console.warn('[Discovery] shelving failed:', err); return 0; });
  if (shelved > 0) console.warn(`[Discovery] Shelved ${shelved.toString()} article(s) unactioned for over a week`);

  await upsertSyncState(db, SYNC_STATE_KEY, {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors.toString()} source(s) failed` : null,
  });
  return { indexed, errors };
}
