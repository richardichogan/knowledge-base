/* eslint-disable */
/**
 * rescore-discovered-articles.ts
 *
 * Rescores ALL discovered articles using the new weighted relevance algorithm.
 * This will:
 * 1. Clear existing relevance_explanation to force re-scoring
 * 2. Run the scoreUnscored function to re-evaluate all articles
 * 3. Apply the new weighted scoring with platform multipliers, source type adjustments, and spark bonuses
 */

import { Pool } from 'pg';
import { env } from '../src/config/env.js';
import { scoreUnscored } from '../src/integrations/cms/discoveredArticlesSync.js';

const db = new Pool({ connectionString: env.DATABASE_URL });

async function main() {
  try {
    console.log('Starting rescore of all discovered articles...\n');

    // Get count before
    const beforeResult = await db.query<{ total: string; scored: string }>(
      `SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE relevance_explanation IS NOT NULL) as scored
       FROM content_items 
       WHERE source = 'discovered-article'`
    );
    const before = beforeResult.rows[0];
    console.log(`Before: ${before?.scored ?? '0'}/${before?.total ?? '0'} articles scored\n`);

    // Clear all existing scores to force re-scoring
    console.log('Clearing existing scores...');
    const clearResult = await db.query(
      `UPDATE content_items
       SET relevance_score = NULL, 
           relevance_explanation = NULL,
           metadata = metadata - 'platform' - 'sourceType' - 'audienceFit' - 'novelty' 
                      - 'strategicSignificance' - 'analyticalDepth' - 'compositeScore'
                      - 'spark' - 'sparkReason'
       WHERE source = 'discovered-article' AND relevance_explanation IS NOT NULL
       RETURNING id`
    );
    console.log(`Cleared ${clearResult.rowCount ?? 0} previously scored articles\n`);

    // Run scoring in batches
    console.log('Re-scoring articles with new weighted algorithm...');
    let totalScored = 0;
    let batchCount = 0;
    
    while (true) {
      batchCount++;
      console.log(`\nProcessing batch ${batchCount}...`);
      
      const unscoredBefore = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM content_items 
         WHERE source = 'discovered-article' AND relevance_explanation IS NULL`
      );
      const remaining = parseInt(unscoredBefore.rows[0]?.count ?? '0', 10);
      
      if (remaining === 0) {
        console.log('All articles scored!');
        break;
      }
      
      console.log(`${remaining} articles remaining to score`);
      await scoreUnscored(db);
      
      const unscoredAfter = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM content_items 
         WHERE source = 'discovered-article' AND relevance_explanation IS NULL`
      );
      const remainingAfter = parseInt(unscoredAfter.rows[0]?.count ?? '0', 10);
      const scored = remaining - remainingAfter;
      totalScored += scored;
      
      console.log(`Batch ${batchCount} completed: ${scored} articles scored`);
      
      // Safety check - if nothing was scored, break to avoid infinite loop
      if (scored === 0) {
        console.warn('No articles scored in this batch - stopping to avoid infinite loop');
        break;
      }
    }

    // Get final stats
    const afterResult = await db.query<{
      total: string;
      scored: string;
      avg_score: string;
      platform_breakdown: string;
    }>(
      `SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE relevance_explanation IS NOT NULL) as scored,
        ROUND(AVG(relevance_score)::numeric, 3) as avg_score,
        json_object_agg(
          COALESCE(metadata->>'platform', 'No Platform'),
          cnt
        ) as platform_breakdown
       FROM (
         SELECT 
           relevance_score,
           relevance_explanation,
           metadata->>'platform' as platform,
           COUNT(*) as cnt
         FROM content_items 
         WHERE source = 'discovered-article'
         GROUP BY relevance_score, relevance_explanation, metadata->>'platform'
       ) sub`
    );
    
    const after = afterResult.rows[0];
    console.log(`\n✅ Rescore complete!`);
    console.log(`Total articles: ${after?.total ?? '0'}`);
    console.log(`Scored: ${after?.scored ?? '0'}`);
    console.log(`Average weighted relevance score: ${after?.avg_score ?? '0'}\n`);

    // Platform breakdown
    console.log('Platform distribution:');
    const platforms = await db.query<{ platform: string; count: string; avg_score: string }>(
      `SELECT 
        COALESCE(metadata->>'platform', 'No Platform') as platform,
        COUNT(*) as count,
        ROUND(AVG(relevance_score)::numeric, 3) as avg_score
       FROM content_items 
       WHERE source = 'discovered-article'
       GROUP BY metadata->>'platform'
       ORDER BY count DESC`
    );
    
    platforms.rows.forEach(row => {
      console.log(`  ${row.platform}: ${row.count} articles (avg score: ${row.avg_score ?? '0'})`);
    });

  } catch (error) {
    console.error('Error rescoring articles:', error);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main();
