/**
 * discoveredArticlesSync.ts — scoring of discovered articles.
 *
 * Discovery itself (reading the feeds) lives in integrations/discovery/feedSync.ts;
 * this file scores what it finds: each article gets a 0-100 triage score against
 * Richard's themes, a suggested format, and a check against his own recent
 * published pieces (so ground he has covered scores lower).
 */
import type { Pool } from 'pg';
import { FoundryClient } from '../../ai/foundryClient.js';
import {
  buildRelevanceSystemPrompt,
  type ScoringResult,
  RELEVANCE_MAX_TOKENS,
  SCORE_BATCH_SIZE,
  enforceScoreCaps,
  classifySourceByUrl,
  classifySourceAuthority,
  calculateWeightedRelevance,
  SOURCE_AUTHORITY_WEIGHTS,
  ARTICLE_TYPE_WEIGHTS,
  PERCENTAGE_MULTIPLIER,
} from './articleScoringPrompt.js';

/** How far back his own published pieces are compared against. */
const COVERED_LOOKBACK_DAYS = 120;
const COVERED_MAX_TITLES = 45;
const SCORE_RETRY_DELAYS_MS = [4_000, 12_000, 30_000];
/** Articles scored at once. The bulk model's quota is large, but keep the load polite. */
export const SCORE_CONCURRENCY = 4;

/** Titles of Richard's own recent published pieces (blog, newsletter, podcast), for the "already covered" check. */
export async function loadCoveredTitles(db: Pool): Promise<string[]> {
  const { rows } = await db.query<{ source: string; title: string }>(
    `SELECT source, title FROM content_items
      WHERE source IN ('cms-blog', 'cms-newsletter', 'cms-podcast-show-notes')
        AND published_at > now() - $1 * interval '1 day'
      ORDER BY published_at DESC LIMIT $2`,
    [COVERED_LOOKBACK_DAYS, COVERED_MAX_TITLES],
  );
  const label: Record<string, string> = { 'cms-blog': 'blog', 'cms-newsletter': 'newsletter', 'cms-podcast-show-notes': 'podcast' };
  return rows.map((r) => `[${label[r.source] ?? r.source}] ${r.title}`);
}

export interface ScorableArticle {
  id: string;
  title: string;
  body: string | null;
  url: string | null;
  metadata: Record<string, unknown>;
}

async function chatWithRetry(client: FoundryClient, system: string, prompt: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chatBulk([{ role: 'system', content: system }, { role: 'user', content: prompt }], RELEVANCE_MAX_TOKENS);
    } catch (err) {
      const delay = SCORE_RETRY_DELAYS_MS[attempt];
      const busy = err instanceof Error && /429|rate|timed out|timeout/i.test(err.message);
      if (delay === undefined || !busy) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Scores one article and stores the result. Throws if the model's answer can't be used. */
export async function scoreArticleRow(db: Pool, client: FoundryClient, row: ScorableArticle, system: string): Promise<{ score: number; platform: string; composite: number }> {
  const sourceTitle = (row.metadata['sourceTitle'] as string | undefined) ?? '';
  const sourceUrl = row.url ?? '';
  const prompt = `Title: ${row.title}\nSource: ${sourceTitle}\nURL: ${sourceUrl}\nDescription: ${row.body && row.body !== '' ? row.body : '(none)'}`;

  const raw = await chatWithRetry(client, system, prompt);
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const parsed = JSON.parse(cleaned) as ScoringResult;

  // Server-side caps from the URL and title (advertorial, community), then the score itself.
  const detectedSourceType = classifySourceByUrl(sourceUrl, `${sourceTitle} ${row.title}`);
  const capped = enforceScoreCaps(parsed, detectedSourceType);
  capped.alreadyCovered = Math.max(0, Math.min(2, Math.round(Number(capped.alreadyCovered ?? 0)) || 0));
  const relevanceScore = calculateWeightedRelevance(capped);

  // Source authority tier (ranking only, applied live in the Discover query — not folded into the score).
  const authorityTier = classifySourceAuthority(sourceUrl, (row.metadata['sourceUrl'] as string | undefined) ?? sourceTitle);

  // Keep the previous score the first time an article is re-scored, so the change is visible.
  const hadOldScore = row.metadata['compositeScore'] !== undefined;

  await db.query(
    `UPDATE content_items
        SET relevance_score = $1, relevance_explanation = $2,
            metadata = metadata
              || (CASE WHEN $17::boolean AND NOT (metadata ? 'legacyScore')
                       THEN jsonb_build_object('legacyScore', COALESCE(relevance_score, 0), 'legacyComposite', COALESCE((metadata->>'compositeScore')::int, 0))
                       ELSE '{}'::jsonb END)
              || jsonb_build_object(
                   'platform', $3::text, 'sourceType', $4::text,
                   'audienceFit', $5::int, 'novelty', $6::int, 'strategicSignificance', $7::int, 'analyticalDepth', $8::int,
                   'compositeScore', $9::int, 'spark', $10::boolean, 'sparkReason', $11::text,
                   'articleType', $12::text, 'articleTypeWeight', $13::numeric,
                   'sourceAuthorityTier', $14::text, 'sourceAuthorityWeight', $15::numeric,
                   'alreadyCovered', $18::int, 'coveredBy', $19::text, 'scoringVersion', 2
                 )
      WHERE id = $16`,
    [
      relevanceScore, capped.explanation, capped.platform, capped.sourceType,
      capped.audienceFit, capped.novelty, capped.strategicSignificance, capped.analyticalDepth,
      capped.composite, capped.spark, capped.sparkReason, capped.articleType, ARTICLE_TYPE_WEIGHTS[capped.articleType],
      authorityTier, SOURCE_AUTHORITY_WEIGHTS[authorityTier], row.id,
      hadOldScore, capped.alreadyCovered, capped.coveredBy ?? '',
    ],
  );
  return { score: Math.round(relevanceScore * PERCENTAGE_MULTIPLIER), platform: capped.platform, composite: capped.composite };
}

/** Scores the next batch of unscored articles. Returns how many were scored. */
export async function scoreUnscored(db: Pool): Promise<number> {
  const unscored = await db.query<ScorableArticle>(
    `SELECT id, title, body, url, metadata FROM content_items
      WHERE source = 'discovered-article' AND relevance_explanation IS NULL
        AND COALESCE((metadata->>'scoreAttempts')::int, 0) < 3
      ORDER BY published_at DESC
      LIMIT $1`,
    [SCORE_BATCH_SIZE],
  );
  if (unscored.rows.length === 0) return 0;

  const client = new FoundryClient();
  const system = buildRelevanceSystemPrompt(await loadCoveredTitles(db));
  let scored = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unscored.rows.length) {
      const row = unscored.rows[next++]!;
      try {
        const r = await scoreArticleRow(db, client, row, system);
        scored++;
        console.warn(`[DiscoveredArticles] Scored ${row.id}: ${r.score.toString()}% (composite ${r.composite.toString()}/10, ${r.platform})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[DiscoveredArticles] Scoring failed for ${row.id}: ${message}`);
        // After three failed attempts an article is left alone, so one bad answer can't block the batch.
        await db.query(
          `UPDATE content_items SET metadata = metadata || jsonb_build_object('scoreAttempts', COALESCE((metadata->>'scoreAttempts')::int, 0) + 1) WHERE id = $1`,
          [row.id],
        ).catch(() => undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: SCORE_CONCURRENCY }, worker));
  return scored;
}
