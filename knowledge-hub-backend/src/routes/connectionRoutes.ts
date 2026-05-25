/**
 * routes/connectionRoutes.ts
 * Read-only API for the graph connections layer.
 *
 * GET /api/connections?ref_id=&ref_type=
 *   Returns all edges for a given content item, grouped by edge_type.
 *   Each edge includes the connected node's title and ref_type.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

export const connectionRouter = Router();

export interface ConnectionEdge {
  edgeId: string;
  edgeType: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
  connectedNode: {
    id: string;
    refId: string;
    refType: string;
    title: string;
  };
  createdAt: string;
}

export type ConnectionsResponse = Record<string, ConnectionEdge[]>;

// ── GET /api/connections ──────────────────────────────────────────────────────

connectionRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { ref_id, ref_type } = req.query as { ref_id?: string; ref_type?: string };
      if (!ref_id || !ref_type) throw new ValidationError('ref_id and ref_type are required');

      const db = getDb();

      // Resolve the node UUID for this content item
      const nodeRow = await db.query<{ id: string }>(
        `SELECT id FROM nodes WHERE ref_id = $1 AND ref_type = $2`,
        [ref_id, ref_type],
      );
      if (nodeRow.rows.length === 0) {
        const empty: ApiSuccess<ConnectionsResponse> = { success: true, data: {} };
        res.status(HTTP_STATUS.OK).json(empty);
        return;
      }
      const nodeId = nodeRow.rows[0]!.id;

      // Fetch all edges where this node is source or target
      const edges = await db.query<{
        edge_id: string; edge_type: string; confidence: string; metadata: Record<string, unknown> | string | null;
        connected_id: string; connected_ref_id: string; connected_ref_type: string;
        connected_title: string; created_at: string;
      }>(
        `SELECT e.id AS edge_id, e.edge_type, e.confidence, e.metadata, e.created_at,
                n.id AS connected_id, n.ref_id AS connected_ref_id,
                n.ref_type AS connected_ref_type, n.title AS connected_title
         FROM edges e
         JOIN nodes n ON (
           CASE WHEN e.source_node_id = $1 THEN e.target_node_id ELSE e.source_node_id END
         ) = n.id
         WHERE e.source_node_id = $1 OR e.target_node_id = $1
         ORDER BY e.confidence DESC, e.created_at DESC`,
        [nodeId],
      );

      // Group by edge_type
      const grouped: ConnectionsResponse = {};
      for (const row of edges.rows) {
        const group = grouped[row.edge_type] ?? [];
        group.push({
          edgeId: row.edge_id,
          edgeType: row.edge_type,
          confidence: parseFloat(row.confidence),
          metadata: row.metadata ? (typeof row.metadata === 'string' ? (JSON.parse(row.metadata) as Record<string, unknown>) : row.metadata) : null,
          connectedNode: {
            id: row.connected_id,
            refId: row.connected_ref_id,
            refType: row.connected_ref_type,
            title: row.connected_title,
          },
          createdAt: row.created_at,
        });
        grouped[row.edge_type] = group;
      }

      const out: ApiSuccess<ConnectionsResponse> = { success: true, data: grouped };
      res.status(HTTP_STATUS.OK).json(out);
    } catch (err) { next(err); }
  })();
});

// ── GET /api/connections/node-by-ref?ref_id=&ref_type= ───────────────────────
// Resolves a node by its ref_id + ref_type pair. Used by the canvas send-to-canvas handler.

connectionRouter.get('/node-by-ref', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { ref_id, ref_type } = req.query as { ref_id?: string; ref_type?: string };
      if (!ref_id || !ref_type) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: { code: 'INVALID_PARAMS', message: 'ref_id and ref_type required' } });
        return;
      }
      const db = getDb();
      const result = await db.query<{ id: string; ref_id: string; ref_type: string; title: string; tags: string[] }>(
        `SELECT id, ref_id, ref_type, title, tags FROM nodes WHERE ref_id = $1 AND ref_type = $2`,
        [ref_id, ref_type],
      );
      if (result.rows.length === 0) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: { code: 'NOT_FOUND', message: 'Node not found' } });
        return;
      }
      const r = result.rows[0]!;
      const out: ApiSuccess<{ id: string; refId: string; refType: string; title: string; tags: string[] }> = {
        success: true,
        data: { id: r.id, refId: r.ref_id, refType: r.ref_type, title: r.title, tags: r.tags },
      };
      res.status(HTTP_STATUS.OK).json(out);
    } catch (err) { next(err); }
  })();
});

// ── GET /api/connections/node/:id ─────────────────────────────────────────────
// Resolves a single node by its UUID.

connectionRouter.get('/node/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { id } = req.params as { id: string };
      const db = getDb();
      const result = await db.query<{ id: string; ref_id: string; ref_type: string; title: string; tags: string[] }>(
        `SELECT id, ref_id, ref_type, title, tags FROM nodes WHERE id = $1`,
        [id],
      );
      if (result.rows.length === 0) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: { code: 'NOT_FOUND', message: `Node ${id} not found` } });
        return;
      }
      const r = result.rows[0]!;
      const out: ApiSuccess<{ id: string; refId: string; refType: string; title: string; tags: string[] }> = {
        success: true,
        data: { id: r.id, refId: r.ref_id, refType: r.ref_type, title: r.title, tags: r.tags },
      };
      res.status(HTTP_STATUS.OK).json(out);
    } catch (err) { next(err); }
  })();
});
