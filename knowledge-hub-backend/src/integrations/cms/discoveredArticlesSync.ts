/**
 * discoveredArticlesSync.ts
 *
 * Fetches newly discovered articles from The Microsoft Cloud Blog's
 * internal admin API and indexes them as source='discovered-article'.
 *
 * These are articles found by the blog's RSS-monitoring cron job that
 * Richard may decide to write about. They update several times a day.
 *
 * API: GET https://www.themicrosoftcloudblog.com/api/admin/discovered-articles
 * Auth: x-admin-auth header (ADMIN_PASSWORD env var)
 */

import type { Pool } from 'pg';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { FoundryClient } from '../../ai/foundryClient.js';
import type { ContentItem } from '../../types/contentItem.js';
import {
  RELEVANCE_SYSTEM_PROMPT,
  type ScoringResult,
  RELEVANCE_MAX_TOKENS,
  SCORE_BATCH_SIZE,
  enforceScoreCaps,
  classifySourceByUrl,
  calculateWeightedRelevance,
  PERCENTAGE_MULTIPLIER,
} from './articleScoringPrompt.js';

const API_BASE = 'https://themicrosoftcloudblog.com';
const SYNC_STATE_KEY = 'discovered-articles';
const FETCH_LIMIT = 100;

interface DiscoveredArticle {
  id: string;
  title: string;
  url: string;
  description: string | null;
  publishedAt: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceId: string;
  discoveredAt: string;
  status: 'new' | 'reviewed' | 'dismissed' | 'published';
  newsWorthiness: number | null;
  // Scoring fields from blog API
  platform?: string;
  audienceFit?: number;
  novelty?: number;
  strategicSignificance?: number;
  analyticalDepth?: number;
  compositeScore?: number;
  sourceType?: string;
  spark?: boolean;
  sparkReason?: string;
}

export async function syncDiscoveredArticles(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    console.warn('[DiscoveredArticles] ADMIN_PASSWORD not set — skipping sync');
    return { indexed: 0, errors: 0 };
  }

  let indexed = 0;
  let errors = 0;

  try {
    // Fetch all statuses so we get the full picture (new + reviewed etc.)
    // Filter by date client-side to avoid missing anything that was recently reviewed
    const url = `${API_BASE}/api/admin/discovered-articles/?limit=${FETCH_LIMIT}`;
    const response = await fetch(url, {
      headers: { 'x-admin-auth': password },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from discovered-articles API`);
    }

    const articles = (await response.json()) as DiscoveredArticle[];

    for (const article of articles) {
      // Don't index dismissed articles
      if (article.status === 'dismissed') continue;

      try {
        await upsertContentItem(db, articleToContentItem(article));
        indexed++;
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[DiscoveredArticles] Upsert failed for ${article.id}: ${message}`);
      }
    }

    // Score any items that don't yet have a relevance explanation — production only
    if (!env.isDevelopment) {
      await scoreUnscored(db);
    }

    await upsertSyncState(db, SYNC_STATE_KEY, {
      lastSyncAt: new Date(),
      itemCount: indexed,
      lastError: errors > 0 ? `${errors} upsert errors` : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DiscoveredArticles] Sync failed: ${message}`);
    errors++;
    await upsertSyncState(db, SYNC_STATE_KEY, {
      lastSyncAt: new Date(),
      itemCount: 0,
      lastError: message,
    });
  }

  return { indexed, errors };
}

function articleToContentItem(
  article: DiscoveredArticle,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const DATE_PREFIX_LEN = 10;
  return {
    source: 'discovered-article',
    sourceId: article.id,
    title: article.title,
    summary: `via ${article.sourceTitle} · discovered ${article.discoveredAt.slice(0, DATE_PREFIX_LEN)}`,
    body: article.description ?? '',
    publishedAt: article.publishedAt,  // use original article publish time
    url: article.url,
    projectContext: 'msft-blog',
    metadata: {
      originalPublishedAt: article.publishedAt,
      discoveredAt: article.discoveredAt,
      sourceTitle: article.sourceTitle,
      sourceUrl: article.sourceUrl,
      sourceId: article.sourceId,
      status: article.status,
      newsWorthiness: article.newsWorthiness,
      // Scoring fields from blog API
      platform: article.platform,
      audienceFit: article.audienceFit,
      novelty: article.novelty,
      strategicSignificance: article.strategicSignificance,
      analyticalDepth: article.analyticalDepth,
      compositeScore: article.compositeScore,
      sourceType: article.sourceType,
      spark: article.spark,
      sparkReason: article.sparkReason,
    },
    tags: [article.sourceTitle],  // source name only — status is noise
  };
}

// ── Comprehensive article scoring ─────────────────────────────────────────────

export async function scoreUnscored(db: Pool): Promise<void> {
  const unscored = await db.query<{ id: string; title: string; body: string; url: string; metadata: Record<string, unknown> }>(
    `SELECT id, title, body, url, metadata FROM content_items
     WHERE source = 'discovered-article' AND relevance_explanation IS NULL
     LIMIT $1`,
    [SCORE_BATCH_SIZE],
  );

  if (unscored.rows.length === 0) return;

  const client = new FoundryClient();

  for (const row of unscored.rows) {
    try {
      const sourceTitle = (row.metadata['sourceTitle'] as string) || '';
      const sourceUrl = row.url || '';
      const prompt = `Title: ${row.title}\nSource: ${sourceTitle}\nURL: ${sourceUrl}\nDescription: ${row.body || '(none)'}`;

      const raw = await client.chat(
        'gpt-4o-mini',
        [
          { role: 'system', content: RELEVANCE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        RELEVANCE_MAX_TOKENS,
      );

      // Strip markdown fences if model wrapped JSON
      const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(cleaned) as ScoringResult;
      
      // Enforce scoring caps based on source URL and title (catches advertorial)
      const detectedSourceType = classifySourceByUrl(sourceUrl, `${sourceTitle} ${row.title}`);
      const capped = enforceScoreCaps(parsed, detectedSourceType);

      // Calculate sophisticated weighted relevance score (0-1)
      // This uses dimension weights, platform multipliers, source type adjustments, and spark bonus
      const relevanceScore = calculateWeightedRelevance(capped);

      await db.query(
        `UPDATE content_items
         SET relevance_score = $1, relevance_explanation = $2,
             metadata = metadata || jsonb_build_object(
               'platform', $3::text,
               'sourceType', $4::text,
               'audienceFit', $5::int,
               'novelty', $6::int,
               'strategicSignificance', $7::int,
               'analyticalDepth', $8::int,
               'compositeScore', $9::int,
               'spark', $10::boolean,
               'sparkReason', $11::text
             )
         WHERE id = $12`,
        [
          relevanceScore,
          capped.explanation,
          capped.platform,
          capped.sourceType,
          capped.audienceFit,
          capped.novelty,
          capped.strategicSignificance,
          capped.analyticalDepth,
          capped.composite,
          capped.spark,
          capped.sparkReason,
          row.id,
        ],
      );
      const percentScore = (relevanceScore * PERCENTAGE_MULTIPLIER).toFixed(0);
      console.warn(`[DiscoveredArticles] Scored ${row.id}: composite=${capped.composite}/10, weighted=${percentScore}%, platform=${capped.platform}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[DiscoveredArticles] Scoring failed for ${row.id}: ${message}`);
    }
  }
}