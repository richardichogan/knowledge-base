/**
 * integrations/discovery/feedSync.ts — article discovery. Reads every active
 * source in `discovery_sources`, files new articles (last 14 days only) into
 * the Discover list as source='discovered-article', scores them, rates them
 * against his focus projects, and archives unactioned articles after 14 days
 * (7 for low-value ones), preserving saved, parked and publishing content.
 *
 * This replaced reading discovered articles from the blog site's API.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { readFeed, fetchPageDescription } from './feedReader.js';
import { scoreUnscored } from '../cms/discoveredArticlesSync.js';
import { runProjectFitPass, PROJECT_PROTECT_BOOST } from './projectFit.js';
import { youtubeVideoId } from './youtube.js';
import { enrichPendingYouTubeVideos } from './youtubeEvidence.js';
import { refreshPublishingDrafts } from '../../publishing/refresh.js';

const SYNC_STATE_KEY = 'discovered-articles';
/** Only articles published this recently are filed — also bounds a brand-new source's first fetch. */
const RECENT_WINDOW_DAYS = 14;
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 86_400_000;
const MAX_PER_SOURCE_PER_RUN = 60;
const MAX_PAGE_DESCRIPTIONS = 25;
/** Scoring batches per sync run (50 articles each); a large backlog drains over several runs. */
const SCORING_BATCHES_PER_RUN = 6;
export const STRONG_SCORE = 0.8;

/** Project-fit passes per sync run (60 articles each). */
const PROJECT_FIT_PASSES_PER_RUN = 4;

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
    .map((a) => ({ ...a, publicationDateKnown: a.publishedAt !== null, publishedAt: a.publishedAt ?? new Date() }))
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
    const videoId = youtubeVideoId(a.url);
    await upsertContentItem(db, {
      source: 'discovered-article',
      sourceId: `feed-${createHash('sha1').update(a.url).digest('hex').slice(0, 24)}`,
      title: a.title,
      summary: `via ${source.title} · discovered ${discoveredAt.slice(0, 10)}`,
      body: videoId ? `YouTube video - description only; no transcript retrieved.\n\n${a.summary || 'No description provided.'}` : a.summary,
      publishedAt: a.publishedAt.toISOString(),
      url: a.url,
      projectContext: 'msft-blog',
      metadata: {
        originalPublishedAt: a.publishedAt.toISOString(),
        publicationDateKnown: a.publicationDateKnown,
        discoveredAt,
        sourceTitle: source.title,
        sourceUrl: source.feed_url,
        sourceId: source.id,
        sourceGroup: source.group_name,
        status: 'new',
        ...(videoId ? { contentKind: 'youtube-video', videoId, contentBasis: 'description-only', transcriptStatus: 'not-retrieved' } : {}),
      },
      tags: [source.title],
    });
  }
  return fresh.length;
}

/**
 * Shelves explicitly low-value recommendations, never articles merely because of age.
 * Import time is not evidence that the user has seen or declined an article.
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
        AND COALESCE(NULLIF(metadata->>'restoredAt', ''), '') = ''
        AND COALESCE((metadata->>'projectBoost')::numeric, 0) < $1::numeric`,
    [PROJECT_PROTECT_BOOST],
  );
  return low.rowCount ?? 0;
}

const LOW_VALUE_ARCHIVE_DAYS = 7;
const ARCHIVE_DAYS = 14;

/**
 * Archives unactioned articles by publication age: low-value ones after a week, everything else after two.
 * Saved, parked, blog and published articles are never touched, nor are sources of live publishing topics.
 * Marked autoArchived so interest learning does not read age as "not interested".
 */
export async function archiveAgedArticles(db: Pool): Promise<{ low: number; aged: number }> {
  const result = await db.query<{ reason: string }>(
    `WITH candidates AS (
       SELECT ci.id,
              (ci.metadata->>'platform' = 'Archive' AND COALESCE((ci.metadata->>'scoringVersion')::int, 1) >= 2
                AND COALESCE(NULLIF(ci.metadata->>'restoredAt', ''), '') = ''
                AND COALESCE((ci.metadata->>'projectBoost')::numeric, 0) < $1::numeric) AS low,
              ci.published_at AS dated
         FROM content_items ci
        WHERE ci.source = 'discovered-article' AND ci.workflow_state IN ('to-review', 'shelved')
          AND NOT EXISTS (SELECT 1 FROM discover_parking p WHERE p.article_id = ci.id)
          AND NOT EXISTS (SELECT 1 FROM publishing_sources s JOIN publishing_topics t ON t.id = s.topic_id
                           WHERE s.item_id = ci.id AND t.state IN ('pending', 'assessing', 'ready', 'held'))
     )
     UPDATE content_items ci
        SET workflow_state = 'archived',
            metadata = ci.metadata || jsonb_build_object('archivedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'autoArchived', true, 'archivedReason', CASE WHEN c.low THEN 'low-value-7-days' ELSE 'age-14-days' END)
       FROM candidates c
      WHERE ci.id = c.id
        AND c.dated < NOW() - make_interval(days => CASE WHEN c.low THEN $2::int ELSE $3::int END)
      RETURNING CASE WHEN c.low THEN 'low' ELSE 'aged' END AS reason`,
    [PROJECT_PROTECT_BOOST, LOW_VALUE_ARCHIVE_DAYS, ARCHIVE_DAYS],
  );
  return { low: result.rows.filter(r => r.reason === 'low').length, aged: result.rows.filter(r => r.reason === 'aged').length };
}

let backgroundWork: Promise<void> | null = null;

/** Scores new articles (a few batches) then assesses strong ones, without blocking the caller. */
function startBackgroundWork(db: Pool): void {
  if (backgroundWork !== null) return;
  backgroundWork = (async () => {
    await enrichPendingYouTubeVideos(db).catch((err: unknown) => { console.warn('[Discovery] YouTube enrichment failed:', err); });
    for (let i = 0; i < SCORING_BATCHES_PER_RUN; i++) {
      const scored = await scoreUnscored(db).catch((err: unknown) => { console.warn('[Discovery] scoring failed:', err); return 0; });
      if (scored === 0) break;
    }
    // Then how much each article matters to his live projects (lifts IMAGINE-relevant reading in Discover).
    for (let i = 0; i < PROJECT_FIT_PASSES_PER_RUN; i++) {
      const assessed = await runProjectFitPass(db).catch((err: unknown) => { console.warn('[Discovery] project fit failed:', err); return 0; });
      if (assessed === 0) break;
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
  if (shelved > 0) console.warn(`[Discovery] Shelved ${shelved.toString()} low-value article(s)`);
  const archived = await archiveAgedArticles(db).catch((err: unknown) => { console.warn('[Discovery] archiving failed:', err); return null; });
  if (archived && archived.low + archived.aged > 0) {
    console.warn(`[Discovery] Archived ${archived.low.toString()} low-value article(s) over ${LOW_VALUE_ARCHIVE_DAYS.toString()} days and ${archived.aged.toString()} over ${ARCHIVE_DAYS.toString()} days`);
  }

  try { await refreshPublishingDrafts(db); }
  catch (error) {
    errors++;
    console.error('[Discovery] Publishing draft refresh failed:', error);
  }
  await upsertSyncState(db, SYNC_STATE_KEY, {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors.toString()} discovery or draft-refresh error(s); see logs and Publishing Audit` : null,
  });
  return { indexed, errors };
}
