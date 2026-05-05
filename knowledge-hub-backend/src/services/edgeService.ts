/**
 * services/edgeService.ts
 * Low-level helpers for inserting and removing graph edges.
 *
 * Exported functions:
 *   upsertEdge()         — insert an edge, do nothing on duplicate
 *   deleteEdgesForNode() — remove all edges connected to a node UUID
 */
import type { Pool } from 'pg';

export type EdgeType =
  | 'has_spark'
  | 'tag_overlap'
  | 'references'
  | 'produced_in_window'
  | 'thematically_related';

/** Metadata shape for tag_overlap edges. */
export interface TagOverlapMeta { shared_tags: string[] }
/** Metadata shape for thematically_related edges. */
export interface ThematicMeta   { reason: string }

/**
 * Upserts an edge between two node UUIDs.
 * Uses ON CONFLICT DO NOTHING — safe to call repeatedly.
 * @returns true if a new edge was created, false if it already existed.
 */
export async function upsertEdge(
  db: Pool,
  sourceNodeId: string,
  targetNodeId: string,
  edgeType: EdgeType,
  confidence = 1.0,
  metadata: Record<string, unknown> | null = null,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type, confidence, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_node_id, target_node_id, edge_type) DO NOTHING`,
    [sourceNodeId, targetNodeId, edgeType, confidence, metadata ? JSON.stringify(metadata) : null],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Removes all edges where the given node UUID appears as source or target.
 * Called when a content item is deleted from its source table.
 */
export async function deleteEdgesForNode(db: Pool, nodeId: string): Promise<void> {
  await db.query(
    `DELETE FROM edges WHERE source_node_id = $1 OR target_node_id = $1`,
    [nodeId],
  );
}
