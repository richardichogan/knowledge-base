/**
 * services/canvasService.ts
 * Business logic for Canvas v2.
 *
 * Canvases are stored in:
 *   canvases          — main row with tldraw_snapshot JSONB
 *   canvas_edges      — labelled connections between hub nodes
 *   content_tags      — taxonomy tags (content_type = 'canvas')
 *   nodes             — ref_type = 'canvas' entry for graph layer
 *   edges             — edge_type = 'canvas_connection' for each canvas_edge
 */
import type { Pool } from 'pg';
import { upsertNode, deleteNode } from './nodeService.js';
import { getDb } from '../db/db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CanvasSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdgeRow {
  id: string;
  canvasId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  tldrawShapeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasFull extends CanvasSummary {
  tldrawSnapshot: Record<string, unknown>;
  edges: CanvasEdgeRow[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToSummary(r: Record<string, unknown>): CanvasSummary {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  };
}

function rowToEdge(r: Record<string, unknown>): CanvasEdgeRow {
  return {
    id: r['id'] as string,
    canvasId: r['canvas_id'] as string,
    sourceNodeId: r['source_node_id'] as string,
    targetNodeId: r['target_node_id'] as string,
    label: r['label'] as string,
    tldrawShapeId: r['tldraw_shape_id'] as string,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  };
}

async function syncCanvasNode(db: Pool, canvas: CanvasSummary): Promise<void> {
  await upsertNode(db, canvas.id, 'canvas', canvas.name, []);
}

async function syncCanvasConnectionEdges(db: Pool, canvasId: string): Promise<void> {
  // Fetch all canvas_edges for this canvas, then upsert into hub edges table
  const res = await db.query<Record<string, unknown>>(
    `SELECT * FROM canvas_edges WHERE canvas_id = $1`,
    [canvasId],
  );
  for (const row of res.rows) {
    await db.query(
      `INSERT INTO edges (source_node_id, target_node_id, edge_type, confidence, metadata)
       VALUES ($1, $2, 'canvas_connection', 1.0, $3)
       ON CONFLICT (source_node_id, target_node_id, edge_type) DO UPDATE
         SET metadata = EXCLUDED.metadata, confidence = 1.0`,
      [row['source_node_id'], row['target_node_id'], JSON.stringify({ label: row['label'], canvasId })],
    );
  }
}

// ─── Canvas CRUD ──────────────────────────────────────────────────────────────

export async function createCanvas(
  name = 'Untitled Canvas',
): Promise<CanvasFull> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `INSERT INTO canvases (name) VALUES ($1) RETURNING *`,
    [name],
  );
  const summary = rowToSummary(res.rows[0]!);
  await syncCanvasNode(db, summary);
  return { ...summary, tldrawSnapshot: {}, edges: [] };
}

export async function listCanvases(): Promise<CanvasSummary[]> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `SELECT id, name, created_at, updated_at FROM canvases ORDER BY updated_at DESC`,
  );
  return res.rows.map(rowToSummary);
}

export async function getCanvas(id: string): Promise<CanvasFull | null> {
  const db = getDb();
  const [canvasRes, edgesRes] = await Promise.all([
    db.query<Record<string, unknown>>(`SELECT * FROM canvases WHERE id = $1`, [id]),
    db.query<Record<string, unknown>>(`SELECT * FROM canvas_edges WHERE canvas_id = $1 ORDER BY created_at`, [id]),
  ]);
  if (!canvasRes.rows[0]) return null;
  const row = canvasRes.rows[0];
  return {
    ...rowToSummary(row),
    tldrawSnapshot: (row['tldraw_snapshot'] as Record<string, unknown>) ?? {},
    edges: edgesRes.rows.map(rowToEdge),
  };
}

export async function updateCanvas(
  id: string,
  payload: { name?: string; tldrawSnapshot?: Record<string, unknown> },
): Promise<CanvasSummary | null> {
  const db = getDb();
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  let idx = 1;
  if (payload.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(payload.name); }
  if (payload.tldrawSnapshot !== undefined) { sets.push(`tldraw_snapshot = $${idx++}`); vals.push(JSON.stringify(payload.tldrawSnapshot)); }
  vals.push(id);
  const res = await db.query<Record<string, unknown>>(
    `UPDATE canvases SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, created_at, updated_at`,
    vals,
  );
  if (!res.rows[0]) return null;
  const summary = rowToSummary(res.rows[0]);
  await syncCanvasNode(db, summary);
  return summary;
}

export async function deleteCanvas(id: string): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM canvases WHERE id = $1`, [id]);
  await deleteNode(db, id, 'canvas');
}

// ─── Canvas edge CRUD ─────────────────────────────────────────────────────────

export async function createCanvasEdge(
  canvasId: string,
  sourceNodeId: string,
  targetNodeId: string,
  label: string,
  tldrawShapeId: string,
): Promise<CanvasEdgeRow> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `INSERT INTO canvas_edges (canvas_id, source_node_id, target_node_id, label, tldraw_shape_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [canvasId, sourceNodeId, targetNodeId, label, tldrawShapeId],
  );
  await db.query(`UPDATE canvases SET updated_at = now() WHERE id = $1`, [canvasId]);
  await syncCanvasConnectionEdges(db, canvasId);
  return rowToEdge(res.rows[0]!);
}

export async function updateCanvasEdge(
  canvasId: string,
  edgeId: string,
  label: string,
): Promise<CanvasEdgeRow | null> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `UPDATE canvas_edges SET label = $1, updated_at = now()
     WHERE id = $2 AND canvas_id = $3 RETURNING *`,
    [label, edgeId, canvasId],
  );
  if (!res.rows[0]) return null;
  await db.query(`UPDATE canvases SET updated_at = now() WHERE id = $1`, [canvasId]);
  await syncCanvasConnectionEdges(db, canvasId);
  return rowToEdge(res.rows[0]);
}

export async function deleteCanvasEdge(canvasId: string, edgeId: string): Promise<void> {
  const db = getDb();
  // Get source/target before deleting so we can clean hub edges
  const res = await db.query<Record<string, unknown>>(
    `DELETE FROM canvas_edges WHERE id = $1 AND canvas_id = $2 RETURNING *`,
    [edgeId, canvasId],
  );
  if (res.rows[0]) {
    const row = res.rows[0];
    await db.query(
      `DELETE FROM edges
       WHERE source_node_id = $1 AND target_node_id = $2 AND edge_type = 'canvas_connection'`,
      [row['source_node_id'], row['target_node_id']],
    );
    await db.query(`UPDATE canvases SET updated_at = now() WHERE id = $1`, [canvasId]);
  }
}
