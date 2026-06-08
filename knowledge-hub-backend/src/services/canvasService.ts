/**
 * services/canvasService.ts
 * Business logic for the custom canvas (no tldraw).
 *
 * Tables: canvases, canvas_nodes, canvas_edges
 */
import { getDb } from '../db/db.js';
import { CANVAS_NODE_DEFAULT_WIDTH, CANVAS_NODE_DEFAULT_HEIGHT } from '../config/constants.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeType = 'hub_ref' | 'text' | 'ai_output';
export type RefType  = 'discover_item' | 'spark' | 'note' | 'content_item' | 'ai_session';
export type EdgeType = 'relates-to' | 'supports' | 'contradicts' | 'leads-to' | 'part-of';

export interface CanvasSummary {
  id: string;
  title: string;
  description: string | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasNode {
  id: string;
  canvasId: string;
  nodeType: NodeType;
  refType: RefType | null;
  refId: string | null;
  label: string | null;
  body: string | null;
  url: string | null;
  tags: string[] | null;
  x: number;
  y: number;
  width: number;
  height: number;
  colour: string | null;
  createdAt: string;
}

export interface CanvasEdge {
  id: string;
  canvasId: string;
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  label: string | null;
  createdAt: string;
}

export interface CanvasFull extends CanvasSummary {
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function rowToSummary(r: Record<string, unknown>): CanvasSummary {
  return {
    id:          r['id'] as string,
    title:       r['title'] as string,
    description: (r['description'] as string | null) ?? null,
    project:     (r['project'] as string | null) ?? null,
    createdAt:   r['created_at'] as string,
    updatedAt:   r['updated_at'] as string,
  };
}

function rowToNode(r: Record<string, unknown>): CanvasNode {
  let tags: string[] | null = null;
  const rawTags = r['meta_tags'];
  if (typeof rawTags === 'string') {
    try { tags = JSON.parse(rawTags) as string[]; } catch { /* ignore */ }
  }
  return {
    id:        r['id'] as string,
    canvasId:  r['canvas_id'] as string,
    nodeType:  r['node_type'] as NodeType,
    refType:   (r['ref_type'] as RefType | null) ?? null,
    refId:     (r['ref_id'] as string | null) ?? null,
    label:     (r['label'] as string | null) ?? null,
    body:      (r['body'] as string | null) ?? null,
    url:       (r['url'] as string | null) ?? null,
    tags:      tags,
    x:         Number(r['x']),
    y:         Number(r['y']),
    width:     Number(r['width']),
    height:    Number(r['height']),
    colour:    (r['colour'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
  };
}

function rowToEdge(r: Record<string, unknown>): CanvasEdge {
  return {
    id:        r['id'] as string,
    canvasId:  r['canvas_id'] as string,
    sourceId:  r['source_id'] as string,
    targetId:  r['target_id'] as string,
    edgeType:  r['edge_type'] as EdgeType,
    label:     (r['label'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
  };
}

// ─── Canvas CRUD ──────────────────────────────────────────────────────────────

export async function createCanvas(
  title = 'Untitled Canvas',
  description?: string,
  project?: string,
): Promise<CanvasFull> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `INSERT INTO canvases (title, description, project)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [title, description ?? null, project ?? null],
  );
  return { ...rowToSummary(res.rows[0]!), viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
}

export async function listCanvases(): Promise<CanvasSummary[]> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `SELECT id, title, description, project, created_at, updated_at
     FROM canvases ORDER BY updated_at DESC`,
  );
  return res.rows.map(rowToSummary);
}

export async function getCanvas(id: string): Promise<CanvasFull | null> {
  const db = getDb();
  const [canvasRes, nodesRes, edgesRes] = await Promise.all([
    db.query<Record<string, unknown>>(`SELECT * FROM canvases WHERE id = $1`, [id]),
    db.query<Record<string, unknown>>(
      `SELECT * FROM canvas_nodes WHERE canvas_id = $1 ORDER BY created_at`, [id]),
    db.query<Record<string, unknown>>(
      `SELECT * FROM canvas_edges WHERE canvas_id = $1 ORDER BY created_at`, [id]),
  ]);
  if (!canvasRes.rows[0]) return null;
  const row = canvasRes.rows[0];
  const vp = (row['viewport'] as { x: number; y: number; zoom: number }) ?? { x: 0, y: 0, zoom: 1 };
  return {
    ...rowToSummary(row),
    viewport: vp,
    nodes: nodesRes.rows.map(rowToNode),
    edges: edgesRes.rows.map(rowToEdge),
  };
}

export async function updateCanvas(
  id: string,
  patch: { title?: string; description?: string; project?: string; viewport?: object },
): Promise<CanvasSummary | null> {
  const db = getDb();
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.title       !== undefined) { sets.push(`title = $${i++}`);       vals.push(patch.title); }
  if (patch.description !== undefined) { sets.push(`description = $${i++}`); vals.push(patch.description); }
  if (patch.project     !== undefined) { sets.push(`project = $${i++}`);     vals.push(patch.project); }
  if (patch.viewport    !== undefined) { sets.push(`viewport = $${i++}`);    vals.push(JSON.stringify(patch.viewport)); }
  vals.push(id);
  const res = await db.query<Record<string, unknown>>(
    `UPDATE canvases SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals,
  );
  return res.rows[0] ? rowToSummary(res.rows[0]) : null;
}

export async function deleteCanvas(id: string): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM canvases WHERE id = $1`, [id]);
}

// ─── Node CRUD ────────────────────────────────────────────────────────────────

export interface CreateNodeInput {
  nodeType: NodeType;
  refType?: RefType;
  refId?: string;
  label?: string;
  body?: string;
  url?: string;
  tags?: string[];
  x: number;
  y: number;
  width?: number;
  height?: number;
  colour?: string;
}

export async function createNode(canvasId: string, input: CreateNodeInput): Promise<CanvasNode> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `INSERT INTO canvas_nodes
       (canvas_id, node_type, ref_type, ref_id, label, body, url, meta_tags, x, y, width, height, colour)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      canvasId,
      input.nodeType,
      input.refType ?? null,
      input.refId ?? null,
      input.label ?? null,
      input.body ?? null,
      input.url ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.x,
      input.y,
      input.width ?? CANVAS_NODE_DEFAULT_WIDTH,
      input.height ?? CANVAS_NODE_DEFAULT_HEIGHT,
      input.colour ?? null,
    ],
  );
  await db.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
  return rowToNode(res.rows[0]!);
}

export interface UpdateNodeInput {
  label?: string;
  body?: string;
  url?: string;
  tags?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  colour?: string;
}

export async function updateNode(
  canvasId: string,
  nodeId: string,
  patch: UpdateNodeInput,
): Promise<CanvasNode | null> {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.label  !== undefined) { sets.push(`label = $${i++}`);     vals.push(patch.label); }
  if (patch.body   !== undefined) { sets.push(`body = $${i++}`);      vals.push(patch.body); }
  if (patch.url    !== undefined) { sets.push(`url = $${i++}`);       vals.push(patch.url); }
  if (patch.tags   !== undefined) { sets.push(`meta_tags = $${i++}`); vals.push(JSON.stringify(patch.tags)); }
  if (patch.x      !== undefined) { sets.push(`x = $${i++}`);        vals.push(patch.x); }
  if (patch.y      !== undefined) { sets.push(`y = $${i++}`);        vals.push(patch.y); }
  if (patch.width  !== undefined) { sets.push(`width = $${i++}`);    vals.push(patch.width); }
  if (patch.height !== undefined) { sets.push(`height = $${i++}`);   vals.push(patch.height); }
  if (patch.colour !== undefined) { sets.push(`colour = $${i++}`);   vals.push(patch.colour); }
  if (sets.length === 0) return null;
  vals.push(nodeId, canvasId);
  const res = await db.query<Record<string, unknown>>(
    `UPDATE canvas_nodes SET ${sets.join(', ')} WHERE id = $${i} AND canvas_id = $${i + 1} RETURNING *`,
    vals,
  );
  if (res.rows[0]) await db.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
  return res.rows[0] ? rowToNode(res.rows[0]) : null;
}

export async function deleteNodeById(canvasId: string, nodeId: string): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM canvas_nodes WHERE id = $1 AND canvas_id = $2`, [nodeId, canvasId]);
  await db.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
}

// ─── Edge CRUD ────────────────────────────────────────────────────────────────

export async function createEdge(
  canvasId: string,
  sourceId: string,
  targetId: string,
  edgeType: EdgeType = 'relates-to',
  label?: string,
): Promise<CanvasEdge> {
  const db = getDb();
  const res = await db.query<Record<string, unknown>>(
    `INSERT INTO canvas_edges (canvas_id, source_id, target_id, edge_type, label)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [canvasId, sourceId, targetId, edgeType, label ?? null],
  );
  await db.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
  return rowToEdge(res.rows[0]!);
}

export async function deleteEdge(canvasId: string, edgeId: string): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM canvas_edges WHERE id = $1 AND canvas_id = $2`, [edgeId, canvasId]);
  await db.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
}


