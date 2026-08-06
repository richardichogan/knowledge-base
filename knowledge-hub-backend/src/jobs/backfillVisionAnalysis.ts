/**
 * One-off backfill: run GPT-4V vision analysis for every kb_images row that
 * doesn't have one yet (covers images uploaded while the max_tokens/
 * max_completion_tokens bug was silently failing every request).
 */
import 'dotenv/config';
import { getDb } from '../db/db.js';
import { analyzeImageWithVision } from '../services/visionAnalyzer.js';

const db = getDb();
const { rows } = await db.query<{ id: string; blob_url: string }>(
  `SELECT id, blob_url FROM kb_images WHERE vision_analysis = '' ORDER BY created_at ASC`,
);

console.log(`Backfilling vision analysis for ${rows.length.toString()} image(s)...`);

let done = 0;
let failed = 0;
for (const row of rows) {
  try {
    const resp = await fetch(row.blob_url);
    if (!resp.ok) {
      console.warn(`  [${row.id}] blob fetch failed: ${resp.status.toString()}`);
      failed++;
      continue;
    }
    const contentType = resp.headers.get('content-type') ?? 'image/png';
    const buf = Buffer.from(await resp.arrayBuffer());
    const analysis = await analyzeImageWithVision(buf, contentType);
    if (analysis === '') {
      console.warn(`  [${row.id}] vision analysis returned empty`);
      failed++;
      continue;
    }
    await db.query(`UPDATE kb_images SET vision_analysis = $1 WHERE id = $2`, [analysis, row.id]);
    done++;
    console.log(`  [${row.id}] OK (${analysis.length.toString()} chars)`);
  } catch (err) {
    console.error(`  [${row.id}] error:`, err);
    failed++;
  }
}

console.log(`Backfill complete: ${done.toString()} succeeded, ${failed.toString()} failed.`);
process.exit(0);
