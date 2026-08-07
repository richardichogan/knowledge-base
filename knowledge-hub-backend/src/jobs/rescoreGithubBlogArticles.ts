/**
 * rescoreGithubBlogArticles.ts
 *
 * One-off backfill: github.blog was previously misclassified as "Community"
 * (capping novelty/composite and blocking Full Blog Post routing). Now that
 * it's classified as "Formal", re-run enforceScoreCaps against the ALREADY
 * STORED dimension scores (audienceFit, novelty, strategicSignificance,
 * analyticalDepth, spark) — no need to re-call the LLM since the raw
 * per-dimension judgements didn't change, only the source-type caps applied
 * on top of them.
 *
 * Run with: npx tsx src/jobs/rescoreGithubBlogArticles.ts
 */
import 'dotenv/config';
import { getDb } from '../db/db.js';
import {
  classifySourceByUrl,
  enforceScoreCaps,
  calculateWeightedRelevance,
  type ScoringResult,
} from '../integrations/cms/articleScoringPrompt.js';

interface Row {
  id: string;
  title: string;
  url: string;
  metadata: Record<string, unknown>;
}

async function run(): Promise<void> {
  const db = getDb();

  const result = await db.query<Row>(
    `SELECT id, title, url, metadata FROM content_items
     WHERE source = 'discovered-article'
       AND relevance_explanation IS NOT NULL
       AND url ILIKE '%github.blog%'`,
  );

  console.log(`Found ${result.rows.length} github.blog articles to re-score.`);

  let updated = 0;
  let skipped = 0;

  for (const row of result.rows) {
    const meta = row.metadata || {};
    const sourceType = meta['sourceType'];
    const audienceFit = meta['audienceFit'];
    const novelty = meta['novelty'];
    const strategicSignificance = meta['strategicSignificance'];
    const analyticalDepth = meta['analyticalDepth'];
    const spark = meta['spark'];
    const sparkReason = meta['sparkReason'];
    const explanation = meta['explanation'];
    const platform = meta['platform'];

    if (
      typeof audienceFit !== 'number'
      || typeof novelty !== 'number'
      || typeof strategicSignificance !== 'number'
      || typeof analyticalDepth !== 'number'
    ) {
      console.log(`  SKIP ${row.id} (${row.title}) — missing stored dimension scores`);
      skipped += 1;
      continue;
    }

    const detectedSourceType = classifySourceByUrl(row.url, row.title);

    const reconstructed: ScoringResult = {
      audienceFit,
      novelty,
      strategicSignificance,
      analyticalDepth,
      composite: 0,
      sourceType: (sourceType as ScoringResult['sourceType']) || 'Community',
      platform: (platform as ScoringResult['platform']) || 'Archive',
      spark: Boolean(spark),
      sparkReason: (sparkReason as string) || '',
      explanation: (explanation as string) || '',
    };

    const capped = enforceScoreCaps(reconstructed, detectedSourceType);
    const relevanceScore = calculateWeightedRelevance(capped);

    await db.query(
      `UPDATE content_items
       SET relevance_score = $1,
           metadata = metadata || jsonb_build_object(
             'platform', $2::text,
             'sourceType', $3::text,
             'compositeScore', $4::int
           )
       WHERE id = $5`,
      [relevanceScore, capped.platform, capped.sourceType, capped.composite, row.id],
    );

    console.log(
      `  UPDATED ${row.id} (${row.title}) — sourceType: ${meta['sourceType']} -> ${capped.sourceType}, `
      + `composite: ${meta['compositeScore']} -> ${capped.composite}, platform: ${meta['platform']} -> ${capped.platform}, `
      + `relevance: ${relevanceScore.toFixed(3)}`,
    );
    updated += 1;
  }

  console.log(`\nDone. Updated ${updated}, skipped ${skipped}.`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Rescore failed:', err);
  process.exit(1);
});
