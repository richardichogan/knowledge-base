#!/usr/bin/env tsx
/**
 * One-time script to re-tag all discovered articles that lost their taxonomy tags.
 * Run: npm run retag-discover-items
 */

import { Pool } from 'pg';
import { env } from '../src/config/env.js';
import { tagContent } from '../src/services/taxonomyService.js';

const TAG_SUMMARY_CHARS = 1500;

async function main() {
  const db = new Pool({ connectionString: env.DATABASE_URL });
  
  try {
    console.log('[Retag] Finding untagged discovered articles...');
    
    // Find all discovered articles that have no tags
    const result = await db.query<{
      id: string;
      source_id: string;
      title: string;
      summary: string;
      body: string;
    }>(
      `SELECT ci.id, ci.source_id, ci.source, ci.title, ci.summary, ci.body
       FROM content_items ci
       WHERE ci.source = 'discovered-article'
         AND NOT EXISTS (
           SELECT 1 FROM discover_item_tags dit WHERE dit.discover_item_id = ci.id
         )
       ORDER BY ci.published_at DESC`
    );

    const untagged = result.rows;
    console.log(`[Retag] Found ${untagged.length} untagged items`);

    if (untagged.length === 0) {
      console.log('[Retag] Nothing to do!');
      await db.end();
      return;
    }

    let tagged = 0;
    let errors = 0;

    for (const item of untagged) {
      try {
        const summary = `${item.title}\n\n${(item.summary ?? item.body ?? '')}`.slice(0, TAG_SUMMARY_CHARS);
        await tagContent(db, summary, item.id, 'discovered-article', item.title);
        tagged++;
        console.log(`[Retag] ${tagged}/${untagged.length} - Tagged: ${item.title.slice(0, 60)}`);
      } catch (err) {
        errors++;
        console.error(`[Retag] Failed to tag ${item.source_id}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`\n[Retag] Complete! Tagged: ${tagged}, Errors: ${errors}`);
  } catch (err) {
    console.error('[Retag] Fatal error:', err);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main();
