/**
 * backfillRankingWeights.ts
 *
 * One-off backfill for the multi-criteria Discover ranking redesign, AND a corrective
 * pass fixing a bug from the first version of this script: it multiplied
 * sourceAuthorityWeight/articleTypeWeight directly into the stored relevance_score,
 * which is shown to editors as an absolute quality percentage and clamped to 0.95 —
 * many already-strong articles got pushed over the clamp and became indistinguishable
 * at 95%, masking the ranking signal instead of improving it.
 *
 * This version:
 * 1. Computes source authority tier/weight deterministically from the article/source
 *    URL (no LLM call) and article type via a lightweight gpt-4o-mini classification
 *    (only for rows missing it) — stored in metadata ONLY.
 * 2. Recomputes relevance_score using the PURE calculateWeightedRelevance(reconstructed)
 *    (no weight args) from the stored per-dimension scores, restoring it to a pure
 *    editorial-quality signal for every already-scored row — correcting any prior
 *    poisoning from the first run of this script.
 * 3. Leaves the actual ranking weighting to the Discover SQL query's live ORDER BY,
 *    which multiplies relevance_score * recency decay * sourceAuthorityWeight *
 *    articleTypeWeight at read time (see routes/discover.ts).
 *
 * Safe to re-run — fully idempotent.
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
  body: string;
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

function reconstructScoringResult(meta: Record<string, unknown>, articleType: ArticleType): ScoringResult | null {
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
    return null;
  }
  return {
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
}

async function run(): Promise<void> {
  const db = getDb();
  const client = new FoundryClient();

  const scored = await db.query<Row>(
    `SELECT id, url, title, body, relevance_score, workflow_state, metadata FROM content_items
     WHERE source = 'discovered-article' AND relevance_explanation IS NOT NULL`,
  );
  console.log(`Found ${scored.rows.length} scored discovered-article rows.`);

  let metadataUpdated = 0;
  let typeClassified = 0;
  let relevanceFixed = 0;
  let skipped = 0;

  for (const row of scored.rows) {
    const meta = row.metadata || {};

    // Source authority tier/weight — deterministic, always recomputed (idempotent, free).
    const sourceUrl = (meta['sourceUrl'] as string) || (meta['sourceTitle'] as string) || '';
    const authorityTier = classifySourceAuthority(row.url, sourceUrl);
    const authorityWeight = SOURCE_AUTHORITY_WEIGHTS[authorityTier];

    // Article type — only classify via LLM if not already present.
    let articleType = meta['articleType'] as ArticleType | undefined;
    if (!articleType || !(articleType in ARTICLE_TYPE_WEIGHTS)) {
      try {
        articleType = await classifyArticleType(client, row.title, row.body || '');
        typeClassified += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  Article type classification failed for ${row.id} (${row.title}): ${message}`);
        articleType = 'News or Roundup';
      }
    }
    const articleTypeWeight = ARTICLE_TYPE_WEIGHTS[articleType];

    // Recompute relevance_score as a PURE editorial-quality signal (no weight multipliers) —
    // corrects any poisoning from a prior buggy run of this script.
    const reconstructed = reconstructScoringResult(meta, articleType);
    if (!reconstructed) {
      console.log(`  SKIP relevance_score fix for ${row.id} (${row.title}) — missing stored dimension scores`);
      skipped += 1;
      await db.query(
        `UPDATE content_items
         SET metadata = metadata || jsonb_build_object(
               'sourceAuthorityTier', $1::text,
               'sourceAuthorityWeight', $2::numeric,
               'articleType', $3::text,
               'articleTypeWeight', $4::numeric
             )
         WHERE id = $5`,
        [authorityTier, authorityWeight, articleType, articleTypeWeight, row.id],
      );
      metadataUpdated += 1;
      continue;
    }

    const relevanceScore = calculateWeightedRelevance(reconstructed);
    if (row.relevance_score !== null && Math.abs(relevanceScore - row.relevance_score) > 0.0001) {
      relevanceFixed += 1;
    }

    await db.query(
      `UPDATE content_items
       SET relevance_score = $1,
           metadata = metadata || jsonb_build_object(
             'sourceAuthorityTier', $2::text,
             'sourceAuthorityWeight', $3::numeric,
             'articleType', $4::text,
             'articleTypeWeight', $5::numeric
           )
       WHERE id = $6`,
      [relevanceScore, authorityTier, authorityWeight, articleType, articleTypeWeight, row.id],
    );
    metadataUpdated += 1;
  }

  console.log(`Metadata backfilled for ${metadataUpdated} rows (skipped ${skipped} with missing dimension data).`);
  console.log(`Article type newly classified via LLM for ${typeClassified} rows.`);
  console.log(`relevance_score corrected (was poisoned by weight multiplication) for ${relevanceFixed} rows.`);

  process.exit(0);
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
