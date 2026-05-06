/**
 * jobs/clusteringJob.ts
 * Groups unclustered sparks into clusters.
 *
 * Step 1 (synchronous) — tag-based: groups by shared concept tags, no AI needed.
 * Step 2 (async, non-blocking) — AI thematic: GPT-4o-mini clusters untagged sparks.
 * After both steps, marks clusters with >= 4 sparks as ready to surface.
 */
import type { Pool } from 'pg';
import { FoundryClient } from '../ai/foundryClient.js';
import { MS_PER_DAY } from '../config/constants.js';

const MIN_CLUSTER_SIZE = 3;
const SURFACE_THRESHOLD = 4;
const RECENT_DAYS = 30;
const RECENT_CUTOFF_MS = RECENT_DAYS * MS_PER_DAY;
const AI_MAX_TOKENS = 600;

interface UncluseredSpark {
  id: string;
  body: string;
  tags: string[];
}

interface AiClusterResponse {
  clusters: Array<{ theme: string; spark_indices: number[] }>;
}

/**
 * Runs the full clustering pipeline (tag-based + AI) for unclustered sparks.
 * Safe to call fire-and-forget — all errors are logged, never thrown.
 */
export async function runClusteringJob(db: Pool): Promise<void> {
  try {
    await runTagBasedClustering(db);
    void runAiClustering(db); // async, does not block
    await markSurfaceReady(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ClusteringJob] Error in tag-based phase:', msg);
  }
}

/** Step 1 — Group unclustered sparks that share concept tags. */
async function runTagBasedClustering(db: Pool): Promise<void> {
  // Fetch all unclustered sparks that have at least one tag
  const rows = await db.query<UncluseredSpark>(
    `SELECT id, body, tags FROM sparks WHERE cluster_id IS NULL AND array_length(tags, 1) > 0`,
  );
  if (rows.rows.length < MIN_CLUSTER_SIZE) return;

  // Build inverted index: tag → spark ids
  const tagMap = new Map<string, string[]>();
  for (const spark of rows.rows) {
    for (const tag of spark.tags) {
      const existing = tagMap.get(tag) ?? [];
      existing.push(spark.id);
      tagMap.set(tag, existing);
    }
  }

  // For each tag with >= MIN_CLUSTER_SIZE sparks, create a cluster
  for (const [tag, sparkIds] of tagMap.entries()) {
    if (sparkIds.length < MIN_CLUSTER_SIZE) continue;

    // Check these sparks don't already belong to a cluster
    const unassigned = await db.query<{ id: string }>(
      `SELECT id FROM sparks WHERE id = ANY($1) AND cluster_id IS NULL`,
      [sparkIds],
    );
    if (unassigned.rows.length < MIN_CLUSTER_SIZE) continue;

    const ids = unassigned.rows.map((r) => r.id);
    await createClusterForSparks(db, tag, ids);
  }
}

/** Step 2 — AI thematic grouping for unclustered sparks from the past 30 days. */
async function runAiClustering(db: Pool): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RECENT_CUTOFF_MS).toISOString();
    const rows = await db.query<UncluseredSpark>(
      `SELECT id, body, tags FROM sparks
       WHERE cluster_id IS NULL AND created_at >= $1
       ORDER BY created_at DESC`,
      [cutoff],
    );
    if (rows.rows.length < MIN_CLUSTER_SIZE) return;

    const sparks = rows.rows;
    const bodies = sparks.map((s) => s.body);

    const client = new FoundryClient();
    const raw = await client.chat('gpt-4o-mini', [
      {
        role: 'system',
        content: `You are a thematic clustering assistant. You will receive a list of brief thoughts captured by a technology professional while reading articles. Your job is to identify thematic groups of three or more sparks that share a meaningful intellectual connection — not just surface keyword similarity.\n\nReturn ONLY valid JSON. No preamble, no explanation, no markdown fences.\n\nFormat:\n{\n  "clusters": [\n    {\n      "theme": "Short theme label, 3-6 words, title case",\n      "spark_indices": [0, 2, 5]\n    }\n  ]\n}\n\nSparks that do not belong to any meaningful cluster should be omitted. A spark can only appear in one cluster.`,
      },
      { role: 'user', content: JSON.stringify(bodies) },
    ], AI_MAX_TOKENS);

    const parsed = JSON.parse(raw) as AiClusterResponse;
    const assignedIndices = new Set<number>();

    for (const cluster of parsed.clusters) {
      const indices = cluster.spark_indices.filter(
        (i) => i >= 0 && i < sparks.length && !assignedIndices.has(i),
      );
      if (indices.length < MIN_CLUSTER_SIZE) continue;

      const ids = indices.map((i) => sparks[i]!.id);

      // Double-check none were assigned by tag-clustering in the meantime
      const stillFree = await db.query<{ id: string }>(
        `SELECT id FROM sparks WHERE id = ANY($1) AND cluster_id IS NULL`,
        [ids],
      );
      if (stillFree.rows.length < MIN_CLUSTER_SIZE) continue;

      const freeIds = stillFree.rows.map((r) => r.id);
      await createClusterForSparks(db, cluster.theme, freeIds);
      indices.forEach((i) => assignedIndices.add(i));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ClusteringJob] AI clustering error:', msg);
  }
}

/** Inserts a cluster row and assigns the given spark IDs to it. */
async function createClusterForSparks(db: Pool, theme: string, sparkIds: string[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const clusterRow = await client.query<{ id: string }>(
      `INSERT INTO spark_clusters (theme, spark_count) VALUES ($1, $2) RETURNING id`,
      [theme, sparkIds.length],
    );
    const clusterId = clusterRow.rows[0]!.id;
    await client.query(
      `UPDATE sparks SET cluster_id = $1 WHERE id = ANY($2)`,
      [clusterId, sparkIds],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Marks clusters with >= SURFACE_THRESHOLD sparks as surfaced. */
async function markSurfaceReady(db: Pool): Promise<void> {
  await db.query(
    `UPDATE spark_clusters
     SET surfaced = true, surfaced_at = now(), updated_at = now()
     WHERE surfaced = false AND dismissed = false AND spark_count >= $1`,
    [SURFACE_THRESHOLD],
  );
}
