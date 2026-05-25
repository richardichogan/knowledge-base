/**
 * routes/graphRoutes.ts
 * Read-only endpoint for the knowledge graph visualisation.
 *
 * GET /api/graph
 *   Returns nodes and edges filtered by days, node_types, edge_types.
 *   Optionally centres on a seed node to the given depth.
 *   Hard cap: 500 nodes maximum per response.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';
import { getDb } from '../db/db.js';
import { HTTP_STATUS, MS_PER_DAY } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
export const graphRouter = Router();

const NODE_CAP = 500;
const DEFAULT_DAYS = 30;
const DEFAULT_DEPTH = 2;
const TITLE_MAX = 60;

/** A graph node for the visualisation. */
export interface GraphNode {
  id: string;
  refId: string;
  refType: string;
  title: string;
  tags: string[];
  createdAt: string;
}

/** A graph edge for the visualisation. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
}

/** Top-level response shape. */
export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    filteredNodes: number;
    filteredEdges: number;
    truncated: boolean;
  };
}

// ── GET /api/graph ────────────────────────────────────────────────────────────

graphRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const days       = Math.max(1, parseInt(q['days']  ?? String(DEFAULT_DAYS), 10) || DEFAULT_DAYS);
      const depth      = Math.max(1, parseInt(q['depth'] ?? String(DEFAULT_DEPTH), 10) || DEFAULT_DEPTH);
      const seed       = q['seed'] ?? null;
      const edgeTypes  = q['edge_types'] ? q['edge_types'].split(',').map((s) => s.trim()) : null;
      const nodeTypes  = q['node_types'] ? q['node_types'].split(',').map((s) => s.trim()) : null;

      const db = getDb();

      // ── Count totals before filtering ─────────────────────────────────────
      const [totalNodeRow, totalEdgeRow] = await Promise.all([
        db.query<{ count: string }>('SELECT COUNT(*) AS count FROM nodes'),
        db.query<{ count: string }>('SELECT COUNT(*) AS count FROM edges'),
      ]);
      const totalNodes = parseInt(totalNodeRow.rows[0]?.count ?? '0', 10);
      const totalEdges = parseInt(totalEdgeRow.rows[0]?.count ?? '0', 10);

      // ── Fetch candidate nodes ─────────────────────────────────────────────
      const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();

      let nodeRows: Array<{ id: string; ref_id: string; ref_type: string; title: string; tags: string[]; created_at: string }>;

      if (seed !== null) {
        // Seed-based BFS up to `depth` degrees
        nodeRows = await fetchSeedSubgraph(db, seed, depth, cutoff);
      } else {
        const typeFilter = nodeTypes !== null && nodeTypes.length > 0
          ? `AND ref_type = ANY($2::text[])`
          : '';
        const params: unknown[] = [cutoff];
        if (nodeTypes !== null && nodeTypes.length > 0) params.push(nodeTypes);

        const raw = await db.query<{ id: string; ref_id: string; ref_type: string; title: string; tags: string[]; created_at: string }>(
          `SELECT id, ref_id, ref_type, LEFT(title, ${TITLE_MAX}) AS title, tags, created_at
           FROM nodes
           WHERE updated_at >= $1 ${typeFilter}
           ORDER BY updated_at DESC
           LIMIT ${NODE_CAP + 1}`,
          params,
        );
        nodeRows = raw.rows;
      }

      const truncated = nodeRows.length > NODE_CAP;
      if (truncated) nodeRows = nodeRows.slice(0, NODE_CAP);

      const nodeIds = nodeRows.map((n) => n.id);
      if (nodeIds.length === 0) {
        const out: ApiSuccess<GraphResponse> = {
          success: true,
          data: { nodes: [], edges: [], stats: { totalNodes, totalEdges, filteredNodes: 0, filteredEdges: 0, truncated: false } },
        };
        res.status(HTTP_STATUS.OK).json(out);
        return;
      }

      // ── Fetch edges between the candidate nodes ───────────────────────────
      const edgeTypeFilter = edgeTypes !== null && edgeTypes.length > 0
        ? 'AND e.edge_type = ANY($2::text[])'
        : '';
      const edgeParams: unknown[] = [nodeIds];
      if (edgeTypes !== null && edgeTypes.length > 0) edgeParams.push(edgeTypes);

      const edgeRaw = await db.query<{
        id: string; source_node_id: string; target_node_id: string;
        edge_type: string; confidence: string; metadata: Record<string, unknown> | string | null;
      }>(
        `SELECT e.id, e.source_node_id, e.target_node_id, e.edge_type, e.confidence, e.metadata
         FROM edges e
         WHERE e.source_node_id = ANY($1) AND e.target_node_id = ANY($1)
         ${edgeTypeFilter}`,
        edgeParams,
      );

      // ── Shape response ────────────────────────────────────────────────────
      const nodes: GraphNode[] = nodeRows.map((n) => ({
        id: n.id,
        refId: n.ref_id,
        refType: n.ref_type,
        title: n.title,
        tags: n.tags,
        createdAt: n.created_at,
      }));

      const edges: GraphEdge[] = edgeRaw.rows.map((e) => ({
        id: e.id,
        source: e.source_node_id,
        target: e.target_node_id,
        edgeType: e.edge_type,
        confidence: parseFloat(e.confidence),
        metadata: e.metadata ? (typeof e.metadata === 'string' ? (JSON.parse(e.metadata) as Record<string, unknown>) : e.metadata) : null,
      }));

      const out: ApiSuccess<GraphResponse> = {
        success: true,
        data: {
          nodes,
          edges,
          stats: { totalNodes, totalEdges, filteredNodes: nodes.length, filteredEdges: edges.length, truncated },
        },
      };
      res.status(HTTP_STATUS.OK).json(out);
    } catch (err) { next(err); }
  })();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type NodeRow = { id: string; ref_id: string; ref_type: string; title: string; tags: string[]; created_at: string };

/**
 * BFS from seed node up to `depth` degrees of separation.
 * Returns nodes updated after `cutoff`.
 */
async function fetchSeedSubgraph(
  db: Pool,
  seedId: string,
  depth: number,
  cutoff: string,
): Promise<NodeRow[]> {
  const visited = new Set<string>([seedId]);
  const frontier = new Set<string>([seedId]);

  for (let d = 0; d < depth; d++) {
    if (frontier.size === 0) break;
    const edgeRows = await db.query<{ source_node_id: string; target_node_id: string }>(
      `SELECT source_node_id, target_node_id FROM edges
       WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)`,
      [Array.from(frontier)],
    );
    frontier.clear();
    for (const { source_node_id, target_node_id } of edgeRows.rows) {
      for (const nid of [source_node_id, target_node_id]) {
        if (!visited.has(nid)) { visited.add(nid); frontier.add(nid); }
      }
    }
  }

  const raw = await db.query<NodeRow>(
    `SELECT id, ref_id, ref_type, LEFT(title, ${TITLE_MAX}) AS title, tags, created_at
     FROM nodes
     WHERE id = ANY($1) AND updated_at >= $2
     ORDER BY updated_at DESC
     LIMIT ${NODE_CAP + 1}`,
    [Array.from(visited), cutoff],
  );
  return raw.rows;
}
