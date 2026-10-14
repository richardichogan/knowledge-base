/**
 * jobs/clusteringJob.ts
 * Grows and creates spark themes (spark_clusters).
 *
 * Step 1 — grow: unclustered recent sparks are offered to the existing active /
 *          developed themes (GPT-4o-mini, with sample sparks and source titles).
 *          A theme that gains sparks is re-surfaced.
 * Step 2 — tag-based: remaining sparks sharing a concept tag form new themes.
 * Step 3 — AI thematic: remaining recent sparks are grouped into new themes.
 * Counts are recomputed from the sparks table, so they never drift.
 * `surfaced` means "seen by the user": new and newly grown themes start unseen
 * (Think nav dot) and the Sparks page marks them seen.
 *
 * Runs are serialised in-process: a request during a run schedules one re-run.
 */
import type { Pool } from 'pg';
import { FoundryClient } from '../ai/foundryClient.js';
import { MS_PER_DAY } from '../config/constants.js';

/** A theme forms and surfaces at this many sparks. */
export const MIN_THEME_SIZE = 3;
const RECENT_DAYS = 30;
const RECENT_CUTOFF_MS = RECENT_DAYS * MS_PER_DAY;
const AI_MAX_TOKENS = 800;
const MAX_SPARKS_PER_PASS = 40;
const MAX_THEMES_OFFERED = 25;
const SAMPLE_SPARKS_PER_THEME = 3;
const SNIPPET_LENGTH = 220;

interface CandidateSpark {
  id: string;
  body: string;
  tags: string[];
  source_title: string | null;
}

interface ThemeRow {
  id: string;
  theme: string;
  samples: string[];
}

interface AiClusterResponse {
  clusters: Array<{ theme: string; spark_indices: number[] }>;
}

interface AiAssignResponse {
  assignments: Array<{ spark: number; theme: number }>;
}

let running = false;
let rerun = false;

/**
 * Runs the full pipeline. Safe to call fire-and-forget — errors are logged, never thrown.
 */
export async function runClusteringJob(db: Pool): Promise<void> {
  if (running) { rerun = true; return; }
  running = true;
  try {
    do {
      rerun = false;
      await runPass('grow', () => growExistingThemes(db));
      await runPass('tag', () => runTagBasedClustering(db));
      await runPass('ai', () => runAiClustering(db));
    } while (rerun);
  } catch (err) {
    console.error('[ClusteringJob] Error:', err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
  }
}

async function runPass(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) {
    console.error(`[ClusteringJob] ${name} pass failed:`, err instanceof Error ? err.message : String(err));
  }
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET_LENGTH ? `${t.slice(0, SNIPPET_LENGTH - 1)}…` : t;
}

function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(cleaned) as T;
}

/** Unclustered sparks from the last 30 days, newest first, with their source title. */
async function recentUnclustered(db: Pool): Promise<CandidateSpark[]> {
  const cutoff = new Date(Date.now() - RECENT_CUTOFF_MS).toISOString();
  const { rows } = await db.query<CandidateSpark>(
    `SELECT s.id, s.body, s.tags, n.title AS source_title
     FROM sparks s
     LEFT JOIN nodes n ON n.ref_id = s.source_id AND n.ref_type = s.source_type
     WHERE s.cluster_id IS NULL AND s.created_at >= $1
     ORDER BY s.created_at DESC
     LIMIT $2`,
    [cutoff, MAX_SPARKS_PER_PASS],
  );
  return rows;
}

function describeSpark(s: CandidateSpark): string {
  return s.source_title !== null ? `${snippet(s.body)} (from: ${s.source_title})` : snippet(s.body);
}

/** Recomputes spark_count for the given themes from the sparks table. */
export async function recountThemes(db: Pool, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE spark_clusters c
     SET spark_count = (SELECT COUNT(*) FROM sparks s WHERE s.cluster_id = c.id), updated_at = now()
     WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
}

/** Step 1 — offer unclustered sparks to existing themes. */
async function growExistingThemes(db: Pool): Promise<void> {
  const sparks = await recentUnclustered(db);
  if (sparks.length === 0) return;

  const { rows: themes } = await db.query<ThemeRow>(
    `SELECT c.id, c.theme,
            ARRAY(SELECT s.body FROM sparks s WHERE s.cluster_id = c.id ORDER BY s.created_at DESC LIMIT $1) AS samples
     FROM spark_clusters c
     WHERE c.status IN ('active', 'developed')
     ORDER BY COALESCE(c.last_grown_at, c.updated_at) DESC
     LIMIT $2`,
    [SAMPLE_SPARKS_PER_THEME, MAX_THEMES_OFFERED],
  );
  if (themes.length === 0) return;

  const client = new FoundryClient('clustering');
  const raw = await client.chat('light', [
    {
      role: 'system',
      content:
        'You assign newly captured thoughts ("sparks") to existing themes. A spark belongs to a theme only if it ' +
        'clearly develops the same intellectual thread — not merely a shared keyword. Leave a spark out when unsure.\n\n' +
        'Return ONLY valid JSON, no markdown fences:\n{"assignments":[{"spark":0,"theme":2}]}\n' +
        'Indices refer to the arrays given. Each spark appears at most once.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        themes: themes.map((t) => ({ name: t.theme, examples: t.samples.map(snippet) })),
        sparks: sparks.map(describeSpark),
      }),
    },
  ], AI_MAX_TOKENS);

  const parsed = parseJson<AiAssignResponse>(raw);
  const byTheme = new Map<string, string[]>();
  const seen = new Set<number>();
  for (const a of parsed.assignments ?? []) {
    if (!Number.isInteger(a.spark) || !Number.isInteger(a.theme) || seen.has(a.spark)) continue;
    const spark = sparks[a.spark];
    const theme = themes[a.theme];
    if (spark === undefined || theme === undefined) continue;
    seen.add(a.spark);
    byTheme.set(theme.id, [...(byTheme.get(theme.id) ?? []), spark.id]);
  }
  if (byTheme.size === 0) return;

  for (const [themeId, sparkIds] of byTheme) {
    const moved = await db.query(
      `UPDATE sparks SET cluster_id = $1 WHERE id = ANY($2::uuid[]) AND cluster_id IS NULL`,
      [themeId, sparkIds],
    );
    if ((moved.rowCount ?? 0) > 0) {
      // Growth re-surfaces the theme so the Think dot tells the user it moved on.
      await db.query(
        `UPDATE spark_clusters SET last_grown_at = now(), surfaced = false, updated_at = now() WHERE id = $1`,
        [themeId],
      );
    }
  }
  await recountThemes(db, [...byTheme.keys()]);
}

/** Step 2 — new themes from shared concept tags (filing tags excluded). */
async function runTagBasedClustering(db: Pool): Promise<void> {
  const tagRows = await db.query<{ spark_id: string; tag_name: string }>(
    `SELECT s.id AS spark_id, t.name AS tag_name
     FROM sparks s
     JOIN tags t ON t.name = ANY(s.tags) AND t.role = 'concept'
     WHERE s.cluster_id IS NULL`,
  );
  if (tagRows.rows.length === 0) return;

  const tagMap = new Map<string, string[]>();
  for (const { spark_id, tag_name } of tagRows.rows) {
    tagMap.set(tag_name, [...(tagMap.get(tag_name) ?? []), spark_id]);
  }

  for (const [tag, sparkIds] of tagMap.entries()) {
    if (sparkIds.length < MIN_THEME_SIZE) continue;
    const unassigned = await db.query<{ id: string }>(
      `SELECT id FROM sparks WHERE id = ANY($1::uuid[]) AND cluster_id IS NULL`,
      [sparkIds],
    );
    if (unassigned.rows.length < MIN_THEME_SIZE) continue;
    await createThemeForSparks(db, tag, unassigned.rows.map((r) => r.id));
  }
}

/** Step 3 — AI thematic grouping of the remaining recent sparks into new themes. */
async function runAiClustering(db: Pool): Promise<void> {
  const sparks = await recentUnclustered(db);
  if (sparks.length < MIN_THEME_SIZE) return;

  const client = new FoundryClient('clustering');
  const raw = await client.chat('light', [
    {
      role: 'system',
      content:
        'You are a thematic clustering assistant. You will receive brief thoughts ("sparks") captured by a technology ' +
        'professional, each optionally followed by the article or note it came from. Identify groups of three or more ' +
        'sparks that share a meaningful intellectual connection — not just surface keyword similarity.\n\n' +
        'Return ONLY valid JSON, no markdown fences:\n{"clusters":[{"theme":"Short theme label, 3-6 words, title case","spark_indices":[0,2,5]}]}\n\n' +
        'Omit sparks that do not belong to a meaningful group. A spark can appear in only one cluster.',
    },
    { role: 'user', content: JSON.stringify(sparks.map(describeSpark)) },
  ], AI_MAX_TOKENS);

  const parsed = parseJson<AiClusterResponse>(raw);
  const assigned = new Set<number>();
  for (const cluster of parsed.clusters ?? []) {
    const indices = cluster.spark_indices.filter((i) => Number.isInteger(i) && i >= 0 && i < sparks.length && !assigned.has(i));
    if (indices.length < MIN_THEME_SIZE || typeof cluster.theme !== 'string' || cluster.theme.trim() === '') continue;
    const ids = indices.map((i) => sparks[i]!.id);
    const stillFree = await db.query<{ id: string }>(
      `SELECT id FROM sparks WHERE id = ANY($1::uuid[]) AND cluster_id IS NULL`,
      [ids],
    );
    if (stillFree.rows.length < MIN_THEME_SIZE) continue;
    await createThemeForSparks(db, cluster.theme.trim(), stillFree.rows.map((r) => r.id));
    indices.forEach((i) => assigned.add(i));
  }
}

/** Inserts a theme and assigns the given sparks to it. Returns the new theme id. */
export async function createThemeForSparks(db: Pool, theme: string, sparkIds: string[]): Promise<string> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ id: string }>(
      `INSERT INTO spark_clusters (theme, spark_count, last_grown_at) VALUES ($1, $2, now()) RETURNING id`,
      [theme, sparkIds.length],
    );
    const id = row.rows[0]!.id;
    await client.query(`UPDATE sparks SET cluster_id = $1 WHERE id = ANY($2::uuid[])`, [id, sparkIds]);
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
