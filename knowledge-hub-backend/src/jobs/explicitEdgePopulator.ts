/**
 * jobs/explicitEdgePopulator.ts
 * Populates explicit graph edges after node sync.
 *
 * Edge types populated here:
 *   has_spark          — spark → its attached source item
 *   tag_overlap        — nodes sharing concept tags (threshold-guarded)
 *   produced_in_window — commits/PRs co-created with notes/blog posts within 24 h
 *
 * References edges are omitted in this iteration (frontmatter parsing deferred).
 * Run after syncAllNodes() on every sync cycle.
 */
import type { Pool } from 'pg';
import { upsertEdge } from '../services/edgeService.js';
import { MS_PER_DAY } from '../config/constants.js';

/** Concept tags with more uses than this are excluded from tag_overlap edges. */
const TAG_OVERLAP_MAX_USES = 50;
const WINDOW_MS = MS_PER_DAY;
const MIN_PAIR_COUNT = 2;

/**
 * Runs all explicit edge populators in sequence.
 * All errors are caught and logged — never thrown.
 */
export async function populateExplicitEdges(db: Pool): Promise<void> {
  await Promise.all([
    populateHasSparkEdges(db).catch(logError('has_spark')),
    populateTagOverlapEdges(db).catch(logError('tag_overlap')),
    populateProducedInWindowEdges(db).catch(logError('produced_in_window')),
  ]);
}

/** has_spark: spark node → source node for every attached spark. */
async function populateHasSparkEdges(db: Pool): Promise<void> {
  const rows = await db.query<{
    spark_node_id: string; source_node_id: string;
  }>(
    `SELECT ns.id AS spark_node_id, nt.id AS source_node_id
     FROM sparks s
     JOIN nodes ns ON ns.ref_id = s.id::text AND ns.ref_type = 'spark'
     JOIN nodes nt ON nt.ref_id = s.source_id AND nt.ref_type = s.source_type
     WHERE s.source_id IS NOT NULL`,
  );
  for (const r of rows.rows) {
    const [src, tgt] = [r.spark_node_id, r.source_node_id] as [string, string];
    await upsertEdge(db, src, tgt, 'has_spark');
  }
}

/**
 * tag_overlap: pairs of nodes sharing >= 1 concept tag with <= TAG_OVERLAP_MAX_USES total.
 * Uses the junction tables to resolve concept tag membership.
 */
async function populateTagOverlapEdges(db: Pool): Promise<void> {
  // Build a map of concept tag id → node ids (via each content type's junction table)
  // We query note_tags, discover_item_tags, task_tags, document_tags
  const junctionQueries = [
    `SELECT t.id AS tag_id, n.id AS node_id
     FROM note_tags nt
     JOIN tags t ON t.id = nt.tag_id AND t.role = 'concept'
     JOIN nodes n ON n.ref_id = nt.note_id::text AND n.ref_type = 'note'`,
    `SELECT t.id AS tag_id, n.id AS node_id
     FROM discover_item_tags dt
     JOIN tags t ON t.id = dt.tag_id AND t.role = 'concept'
     JOIN nodes n ON n.ref_id = dt.discover_item_id::text AND n.ref_type = 'discover_item'`,
    `SELECT t.id AS tag_id, n.id AS node_id
     FROM task_tags tt
     JOIN tags t ON t.id = tt.tag_id AND t.role = 'concept'
     JOIN nodes n ON n.ref_id = tt.task_id::text AND n.ref_type = 'task'`,
  ];

  // Gather tag use counts to enforce the threshold
  const usageCounts = await db.query<{ tag_id: string; use_count: string }>(
    `SELECT tag_id, COUNT(*) AS use_count FROM (
       SELECT tag_id FROM note_tags
       UNION ALL SELECT tag_id FROM discover_item_tags
       UNION ALL SELECT tag_id FROM task_tags
     ) AS all_uses GROUP BY tag_id`,
  );
  const usageMap = new Map(usageCounts.rows.map((r) => [r.tag_id, parseInt(r.use_count, 10)]));

  // Collect (tagId → nodeIds[]) map
  const tagNodeMap = new Map<string, string[]>();
  for (const sql of junctionQueries) {
    const rows = await db.query<{ tag_id: string; node_id: string }>(sql);
    for (const r of rows.rows) {
      if ((usageMap.get(r.tag_id) ?? 0) > TAG_OVERLAP_MAX_USES) continue;
      const list = tagNodeMap.get(r.tag_id) ?? [];
      list.push(r.node_id);
      tagNodeMap.set(r.tag_id, list);
    }
  }

  // For each tag, create edges between all pairs of nodes that share it
  for (const [tagId, nodeIds] of tagNodeMap.entries()) {
    if (nodeIds.length < MIN_PAIR_COUNT) continue;
    // Look up tag name for metadata
    const tagRow = await db.query<{ name: string }>(`SELECT name FROM tags WHERE id = $1`, [tagId]);
    const tagName = tagRow.rows[0]?.name ?? tagId;

    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const src = nodeIds[i] as string;
        const tgt = nodeIds[j] as string;
        const [stableSrc, stableTgt] = [src, tgt].sort() as [string, string];
        await upsertEdge(db, stableSrc, stableTgt, 'tag_overlap', 1.0, { shared_tags: [tagName] });
      }
    }
  }
}

/** produced_in_window: commit/PR ↔ note/blog_post nodes created within 24 h. */
async function populateProducedInWindowEdges(db: Pool): Promise<void> {
  const rows = await db.query<{
    commit_node_id: string; note_node_id: string;
  }>(
    `SELECT nc.id AS commit_node_id, nn.id AS note_node_id
     FROM nodes nc
     JOIN nodes nn ON nn.ref_type IN ('note', 'blog_post')
     WHERE nc.ref_type IN ('commit', 'pull_request')
       AND ABS(EXTRACT(EPOCH FROM (nc.created_at - nn.created_at)) * 1000) <= $1`,
    [WINDOW_MS],
  );
  for (const r of rows.rows) {
    const [src, tgt] = [r.commit_node_id, r.note_node_id].sort() as [string, string];
    await upsertEdge(db, src, tgt, 'produced_in_window');
  }
}

function logError(phase: string) {
  return (err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ExplicitEdgePopulator] ${phase} error:`, msg);
  };
}
