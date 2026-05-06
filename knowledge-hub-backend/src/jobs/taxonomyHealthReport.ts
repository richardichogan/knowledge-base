/**
 * jobs/taxonomyHealthReport.ts
 * Generates a weekly Taxonomy Health Report as a markdown file.
 * Written to taxonomy-reports/YYYY-MM-DD.md
 * Called by the scheduler once per week.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';

const REPORTS_DIR = 'taxonomy-reports';
const UNDERUSED_THRESHOLD = 3;
const OVERUSED_THRESHOLD = 100;
const DATE_LEN = 10; // YYYY-MM-DD
const PCT_FACTOR = 100;
const TOP_N_TAGS = 20;

/** Write the weekly health report to disk. */
export async function runTaxonomyHealthReport(db: Pool): Promise<string> {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().substring(0, DATE_LEN);
  const filePath = join(REPORTS_DIR, `${date}.md`);

  const [usageDist, pendingStats, totalItems, taggedItems] = await Promise.all([
    getTagUsageDistribution(db),
    getPendingSuggestionStats(db),
    getTotalItemCount(db),
    getTaggedItemCount(db),
  ]);

  const underused = usageDist.filter((t) => t.count < UNDERUSED_THRESHOLD);
  const overused  = usageDist.filter((t) => t.count > OVERUSED_THRESHOLD);
  const coverage  = totalItems > 0 ? ((taggedItems / totalItems) * PCT_FACTOR).toFixed(1) : '0.0';
  const coverageByType = await getCoverageByType(db);

  const lines: string[] = [
    `# Taxonomy Health Report — ${date}`,
    '',
    `## Coverage`,
    `- **${coverage}%** of items have at least one concept tag (${taggedItems} / ${totalItems})`,
    '',
    `### Coverage by content type`,
    ...coverageByType.map((r) => `- ${r.type}: ${r.tagged}/${r.total} (${r.pct}%)`),
    '',
    `## Pending Suggestions Queue`,
    `- Pending: ${pendingStats.pending}`,
    `- Accepted: ${pendingStats.accepted}`,
    `- Rejected: ${pendingStats.rejected}`,
    `- Merged: ${pendingStats.merged}`,
    '',
    `## Tag Use Distribution (top 20)`,
    '| Tag | Parent | Uses |',
    '|-----|--------|------|',
    ...usageDist.slice(0, TOP_N_TAGS).map((t) => `| ${t.name} | ${t.parent} | ${t.count} |`),
    '',
    `## Underused Tags (< ${UNDERUSED_THRESHOLD} uses) — candidates for removal or merge`,
    underused.length === 0 ? '_None_' : '',
    ...underused.map((t) => `- **${t.name}** (${t.parent}): ${t.count} uses`),
    '',
    `## Overused Tags (> ${OVERUSED_THRESHOLD} uses) — candidates for splitting`,
    overused.length === 0 ? '_None_' : '',
    ...overused.map((t) => `- **${t.name}** (${t.parent}): ${t.count} uses`),
  ];

  writeFileSync(filePath, lines.join('\n'));
  console.warn(`[TaxonomyHealth] Report written to ${filePath}`);
  return filePath;
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function getTagUsageDistribution(
  db: Pool,
): Promise<Array<{ name: string; parent: string; count: number }>> {
  const r = await db.query<{ name: string; parent: string; count: string }>(
    `SELECT c.name, COALESCE(p.name, 'root') AS parent,
       (SELECT COUNT(*) FROM note_tags nt WHERE nt.tag_id = c.id) +
       (SELECT COUNT(*) FROM discover_item_tags dt WHERE dt.tag_id = c.id) +
       (SELECT COUNT(*) FROM task_tags tt WHERE tt.tag_id = c.id) AS count
     FROM tags c LEFT JOIN tags p ON p.id = c.parent_id
     WHERE c.role = 'concept'
     ORDER BY count DESC`,
  );
  return r.rows.map((row) => ({ name: row.name, parent: row.parent, count: parseInt(row.count, 10) }));
}

async function getPendingSuggestionStats(db: Pool): Promise<Record<string, number>> {
  const r = await db.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM pending_tag_suggestions GROUP BY status`,
  );
  const map: Record<string, number> = { pending: 0, accepted: 0, rejected: 0, merged: 0 };
  for (const row of r.rows) { map[row.status] = parseInt(row.n, 10); }
  return map;
}

async function getTotalItemCount(db: Pool): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT (SELECT COUNT(*) FROM content_items) + (SELECT COUNT(*) FROM notes) + (SELECT COUNT(*) FROM tasks) AS n`,
  );
  return parseInt(r.rows[0]?.n ?? '0', 10);
}

async function getTaggedItemCount(db: Pool): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT (SELECT COUNT(DISTINCT note_id) FROM note_tags) +
            (SELECT COUNT(DISTINCT discover_item_id) FROM discover_item_tags dit
               JOIN tags t ON t.id = dit.tag_id WHERE t.role = 'concept') +
            (SELECT COUNT(DISTINCT task_id) FROM task_tags) AS n`,
  );
  return parseInt(r.rows[0]?.n ?? '0', 10);
}

async function getCoverageByType(
  db: Pool,
): Promise<Array<{ type: string; tagged: number; total: number; pct: string }>> {
  const results = [];

  const noteRow = await db.query<{ total: string; tagged: string }>(
    `SELECT COUNT(*)::text AS total,
            (SELECT COUNT(DISTINCT note_id)::text FROM note_tags) AS tagged
     FROM notes`,
  );
  const nr = noteRow.rows[0]!;
  const noteTotal = parseInt(nr.total, 10);
  const noteTagged = parseInt(nr.tagged, 10);
  results.push({ type: 'notes', tagged: noteTagged, total: noteTotal, pct: pct(noteTagged, noteTotal) });

  const taskRow = await db.query<{ total: string; tagged: string }>(
    `SELECT COUNT(*)::text AS total,
            (SELECT COUNT(DISTINCT task_id)::text FROM task_tags) AS tagged
     FROM tasks`,
  );
  const tr = taskRow.rows[0]!;
  const taskTotal = parseInt(tr.total, 10);
  const taskTagged = parseInt(tr.tagged, 10);
  results.push({ type: 'tasks', tagged: taskTagged, total: taskTotal, pct: pct(taskTagged, taskTotal) });

  return results;
}

function pct(tagged: number, total: number): string {
  return total === 0 ? '0.0' : ((tagged / total) * PCT_FACTOR).toFixed(1);
}
