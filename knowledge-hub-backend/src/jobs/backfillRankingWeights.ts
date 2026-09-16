/**
 * backfillRankingWeights.ts
 *
 * One-off backfill for the multi-criteria Discover ranking redesign:
 *
 * 1. Source authority tier/weight: computed deterministically from the article/source
 *    URL (no LLM call needed) — backfilled for EVERY already-scored discovered-article
 *    row (any workflow_state), and folded back into relevance_score so it affects
 *    ranking immediately without waiting for a future rescore.
 * 2. Article type/weight: requires a lightweight LLM classification since it wasn't
 *    part of the original scoring prompt. Only backfilled for 'to-review' rows (the
 *    active queue) to keep this cheap and bounded — archived/published rows are left
 *    with articleType defaulted to 'News or Roundup' (weight 1.0, neutral) by the
 *    COALESCE fallback already built into the Discover query and enforceScoreCaps.
 *
 * Run with: npx tsx src/jobs/backfillRankingWeights.ts
 */
import 'dotenv/config';
import { getDb } from '../db/db.js';
import { FoundryClient } from '../ai/foundryClient.js';
import {
  classifySourceAuthority,
  calculateWeightedRelevance,
  SOURCE_AUTHORITY_WEIGHTS,
  ARTICLE_TYPE_WEIGHTS,
  type ScoringResult,
  type ArticleType,
} from '../integrations/cms/articleScoringPrompt.js';

interface Row {
  id: string;
  url: string;
  title: string;
  relevance_score: number | null;
  workflow_state: string;
  metadata: Record<string, unknown>;
}

const ARTICLE_TYPE_CLASSIFY_PROMPT = `You classify a tech article into exactly one type based on its title and description.
Respond with ONLY the type string, nothing else — no punctuation, no explanation.

Valid types (choose the single best match):
- Security Disclosure — CVEs, vulnerabilities, patches, incident reports
- Product Announcement — new product/feature/service launches, GA/preview announcements
- Research Report — original data, surveys, benchmark studies, whitepapers
- Opinion or Analysis — analyst commentary, "why this matters" pieces, predictions
- Press Release — corporate/partnership/funding/earnings announcements
- Tutorial or How-To — walkthroughs, guides, "how to" instructional content
- News or Roundup — general news, roundups, event recaps, anything that doesn't fit above`;

async function classifyArticleType(client: FoundryClient, title: string, description: string): Promise<ArticleType> {
  const raw = await client.chat(
    'gpt-4o-mini',
    [
      { role: 'system', content: ARTICLE_TYPE_CLASSIFY_PROMPT },
      { role: 'user', content: `Title: ${title}\nDescription: ${description || '(none)'}` },
    ],
    20,
  );
  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  if (cleaned in ARTICLE_TYPE_WEIGHTS) return cleaned as ArticleType;
  return 'News or Roundup';
}

async function run(): Promise<void> {
  const db = getDb();
  const client = new FoundryClient();

  // ── Step 1: source authority backfill (all scored rows, free) ──────────────
  const scored = await db.query<Row>(
    `SELECT id, url, title, relevance_score, workflow_state, metadata FROM content_items
     WHERE source = 'discovered-article' AND relevance_explanation IS NOT NULL`,
  );
  console.log(`Found ${scored.rows.length} scored discovered-article rows for source-authority backfill.`);

  let authorityUpdated = 0;
  for (const row of scored.rows) {
    const meta = row.metadata || {};
    const sourceUrl = (meta['sourceUrl'] as string) || (meta['sourceTitle'] as string) || '';
    const authorityTier = classifySourceAuthority(row.url, sourceUrl);
    const authorityWeight = SOURCE_AUTHORITY_WEIGHTS[authorityTier];

    const audienceFit = meta['audienceFit'];
    const novelty = meta['novelty'];
    const strategicSignificance = meta['strategicSignificance'];
    const analyticalDepth = meta['analyticalDepth'];
    if (
      typeof audienceFit !== 'number'
      || typeof novelty !== 'number'
      || typeof strategicSignificance !== 'number'
      || typeof analyticalDepth !== 'number'
    ) {
      console.log(`  SKIP ${row.id} (${row.title}) — missing stored dimension scores, cannot recompute relevance_score`);
      continue;
    }

    const reconstructed: ScoringResult = {
      audienceFit,
      novelty,
      strategicSignificance,
      analyticalDepth,
      composite: (meta['compositeScore'] as number) || 0,
      sourceType: (meta['sourceType'] as ScoringResult['sourceType']) || 'Community',
      platform: (meta['platform'] as ScoringResult['platform']) || 'Archive',
      spark: Boolean(meta['spark']),
      sparkReason: (meta['sparkReason'] as string) || '',
      explanation: '',
      articleType: (meta['articleType'] as ArticleType) || 'News or Roundup',
    };

    const relevanceScore = calculateWeightedRelevance(reconstructed, authorityWeight);

    await db.query(
      `UPDATE content_items
       SET relevance_score = $1,
           metadata = metadata || jsonb_build_object(
             'sourceAuthorityTier', $2::text,
             'sourceAuthorityWeight', $3::numeric
           )
       WHERE id = $4`,
      [relevanceScore, authorityTier, authorityWeight, row.id],
    );
    authorityUpdated += 1;
  }
  console.log(`Source authority backfilled for ${authorityUpdated} rows.`);

  // ── Step 2: article type backfill (to-review rows only, LLM classification) ─
  const toReview = await db.query<Row & { body: string }>(
    `SELECT id, url, title, relevance_score, workflow_state, metadata, body FROM content_items
     WHERE source = 'discovered-article' AND relevance_explanation IS NOT NULL
       AND workflow_state = 'to-review'
       AND (metadata->>'articleType') IS NULL`,
  );
  console.log(`Found ${toReview.rows.length} to-review rows missing articleType.`);

  let typeUpdated = 0;
  for (const row of toReview.rows) {
    try {
      const articleType = await classifyArticleType(client, row.title, row.body || '');
      const articleTypeWeight = ARTICLE_TYPE_WEIGHTS[articleType];
      const authorityWeight = (row.metadata['sourceAuthorityWeight'] as number) ?? 1;

      const meta = row.metadata || {};
      const audienceFit = meta['audienceFit'];
      const novelty = meta['novelty'];
      const strategicSignificance = meta['strategicSignificance'];
      const analyticalDepth = meta['analyticalDepth'];
      let relevanceScore = row.relevance_score ?? 0;
      if (
        typeof audienceFit === 'number'
        && typeof novelty === 'number'
        && typeof strategicSignificance === 'number'
        && typeof analyticalDepth === 'number'
      ) {
        const reconstructed: ScoringResult = {
          audienceFit,
          novelty,
          strategicSignificance,
          analyticalDepth,
          composite: (meta['compositeScore'] as number) || 0,
          sourceType: (meta['sourceType'] as ScoringResult['sourceType']) || 'Community',
          platform: (meta['platform'] as ScoringResult['platform']) || 'Archive',
          spark: Boolean(meta['spark']),
          sparkReason: (meta['sparkReason'] as string) || '',
          explanation: '',
          articleType,
        };
        relevanceScore = calculateWeightedRelevance(reconstructed, authorityWeight);
      }

      await db.query(
        `UPDATE content_items
         SET relevance_score = $1,
             metadata = metadata || jsonb_build_object(
               'articleType', $2::text,
               'articleTypeWeight', $3::numeric
             )
         WHERE id = $4`,
        [relevanceScore, articleType, articleTypeWeight, row.id],
      );
      typeUpdated += 1;
      console.log(`  UPDATED ${row.id} (${row.title}) — articleType: ${articleType}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  FAILED ${row.id} (${row.title}): ${message}`);
    }
  }
  console.log(`Article type backfilled for ${typeUpdated} rows.`);

  process.exit(0);
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
