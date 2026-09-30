/**
 * services/canvasService.ts
 * Canvases (Think → Canvas): a network of cards joined by typed connections.
 *
 * Cards are either content (a Think note, Library document, meeting, post,
 * Discover article or Athena chat — ref_type/ref_id) or your own ideas (text).
 * Each card has an optional annotation (body). Positions (x, y) are saved once
 * a card is placed; unplaced cards are auto-arranged in the app. Connections
 * (canvas_edges) have a type (edge_type: related, supports, contradicts …, or
 * your own) and an optional label. canvas_notes pins a canvas to Think notes.
 *
 * Tables: canvases, canvas_nodes, canvas_edges, canvas_notes
 */
import type { Pool, PoolClient } from 'pg';
import { getDb } from '../db/db.js';
import { upsertNode } from './nodeService.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeType = 'hub_ref' | 'text' | 'ai_output';
export type RefType  = 'discover_item' | 'spark' | 'note' | 'content_item' | 'ai_session';

export interface LinkedNote { id: string; title: string }

export interface CanvasSummary {
  id: string;
  title: string;
  description: string | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  linkedNotes: LinkedNote[];
  nodeCount: number;
}

export interface CanvasNode {
  id: string;
  canvasId: string;
  nodeType: NodeType;
  refType: RefType | null;
  refId: string | null;
  label: string | null;
  /** Your annotation on the card. */
  body: string | null;
  url: string | null;
  tags: string[] | null;
  x: number;
  y: number;
  /** True once the card has a saved position. */
  placed: boolean;
  createdAt: string;
}

export interface CanvasEdge {
  id: string;
  canvasId: string;
  sourceId: string;
  targetId: string;
  /** Connection type, e.g. "supports". */
  type: string;
  label: string | null;
  createdAt: string;
}

export interface CanvasFull extends CanvasSummary {
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** One change to a canvas. Ids are client-generated UUIDs, so changes apply optimistically. */
export type MapOp =
  | { op: 'add'; id: string; label?: string; body?: string; nodeType?: NodeType; refType?: RefType; refId?: string; url?: string;
      /** e.g. ['Meeting'] — the card's kind, shown on the card. */
      tags?: string[];
      x?: number; y?: number; connectTo?: { nodeId: string; edgeId: string; type?: string } }
  | { op: 'update'; id: string; label?: string; body?: string }
  | { op: 'position'; id: string; x: number; y: number }
  | { op: 'delete'; id: string }
  | { op: 'link'; id: string; sourceId: string; targetId: string; type?: string; label?: string }
  | { op: 'update_link'; id: string; type?: string; label?: string }
  | { op: 'unlink'; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX_CHARS = 500;
const TYPE_MAX_CHARS = 40;
const BODY_PREVIEW_CHARS = 200;
const GRAPH_TAG_LABELS = 10;
const MAX_CARD_TAGS = 5;
export const DEFAULT_LINK_TYPE = 'related';
// Heading levels for the summary note: title, then one heading per connection type.
const H1 = 1;
const H2 = 2;
const H3 = 3;

export class MapOpError extends Error {}

// ─── Row mappers ──────────────────────────────────────────────────────────────

// Note titles live inside the notes.content JSON wrapper; pulled out with a
// regex so a malformed row can't break the query.
const NOTE_TITLE_SQL = `COALESCE(NULLIF(substring(n.content from '"title"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'), ''), 'Untitled')`;

function rowToSummary(r: Record<string, unknown>): CanvasSummary {
  return {
    id:          r['id'] as string,
    title:       r['title'] as string,
    description: (r['description'] as string | null) ?? null,
    project:     (r['project'] as string | null) ?? null,
    createdAt:   r['created_at'] as string,
    updatedAt:   r['updated_at'] as string,
    linkedNotes: (r['linked_notes'] as LinkedNote[] | null) ?? [],
    nodeCount:   Number(r['node_count'] ?? 0),
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
    tags,
    x:         Number(r['x'] ?? 0),
    y:         Number(r['y'] ?? 0),
    placed:    r['placed'] === true,
    createdAt: r['created_at'] as string,
  };
}

function rowToEdge(r: Record<string, unknown>): CanvasEdge {
  return {
    id:        r['id'] as string,
    canvasId:  r['canvas_id'] as string,
    sourceId:  r['source_id'] as string,
    targetId:  r['target_id'] as string,
    type:      (r['edge_type'] as string | null) ?? DEFAULT_LINK_TYPE,
    label:     (r['label'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
  };
}

const SUMMARY_SQL = `
  SELECT c.id, c.title, c.description, c.project, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM canvas_nodes x WHERE x.canvas_id = c.id) AS node_count,
         COALESCE((
           SELECT json_agg(json_build_object('id', cn.note_id, 'title', ${NOTE_TITLE_SQL}) ORDER BY cn.created_at)
             FROM canvas_notes cn JOIN notes n ON n.id::text = cn.note_id AND n.status = 'active'
            WHERE cn.canvas_id = c.id
         ), '[]'::json) AS linked_notes
    FROM canvases c`;

async function noteTitle(db: Pool | PoolClient, noteId: string): Promise<{ title: string; projectId: string | null } | null> {
  const r = await db.query<{ content: string; project_id: string | null }>(
    `SELECT content, project_id FROM notes WHERE id::text = $1 AND status = 'active'`, [noteId]);
  const row = r.rows[0];
  if (row === undefined) return null;
  try {
    const wrapper = JSON.parse(row.content) as { title?: string };
    return { title: wrapper.title ?? 'Untitled', projectId: row.project_id };
  } catch {
    return { title: 'Untitled', projectId: row.project_id };
  }
}

// ─── Canvases ─────────────────────────────────────────────────────────────────

export async function listCanvases(noteId?: string): Promise<CanvasSummary[]> {
  const db = getDb();
  const res = noteId === undefined
    ? await db.query<Record<string, unknown>>(`${SUMMARY_SQL} ORDER BY c.updated_at DESC`)
    : await db.query<Record<string, unknown>>(
      `${SUMMARY_SQL} WHERE EXISTS (SELECT 1 FROM canvas_notes l WHERE l.canvas_id = c.id AND l.note_id = $1) ORDER BY c.updated_at DESC`,
      [noteId]);
  return res.rows.map(rowToSummary);
}

export interface CreateMapInput {
  title?: string;
  /** Label of the first card on a blank canvas. */
  rootLabel?: string;
  /** Pin the canvas to this note; the note is its first card. */
  noteId?: string;
  project?: string;
}

export async function createCanvas(input: CreateMapInput = {}): Promise<CanvasFull> {
  const db = getDb();
  const client = await db.connect();
  let canvasId = '';
  try {
    await client.query('BEGIN');
    const note = input.noteId !== undefined ? await noteTitle(client, input.noteId) : null;
    const title = input.title ?? note?.title ?? 'Untitled canvas';
    const res = await client.query<{ id: string }>(
      `INSERT INTO canvases (title, project) VALUES ($1, $2) RETURNING id`,
      [title, input.project ?? note?.projectId ?? null],
    );
    canvasId = res.rows[0]!.id;
    await client.query(
      `INSERT INTO canvas_nodes (canvas_id, node_type, ref_type, ref_id, label, x, y, placed)
       VALUES ($1, $2, $3, $4, $5, 0, 0, TRUE)`,
      note !== null && input.noteId !== undefined
        ? [canvasId, 'hub_ref', 'note', input.noteId, note.title]
        : [canvasId, 'text', null, null, input.rootLabel ?? title],
    );
    if (note !== null && input.noteId !== undefined) {
      await client.query(`INSERT INTO canvas_notes (canvas_id, note_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [canvasId, input.noteId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  scheduleGraphSync(canvasId);
  return (await getCanvas(canvasId))!;
}

export async function getCanvas(id: string): Promise<CanvasFull | null> {
  if (!UUID_RE.test(id)) return null;
  const db = getDb();
  const [canvasRes, nodesRes, edgesRes] = await Promise.all([
    db.query<Record<string, unknown>>(`${SUMMARY_SQL} WHERE c.id = $1`, [id]),
    db.query<Record<string, unknown>>(`SELECT * FROM canvas_nodes WHERE canvas_id = $1 ORDER BY created_at, id`, [id]),
    db.query<Record<string, unknown>>(`SELECT * FROM canvas_edges WHERE canvas_id = $1 ORDER BY created_at, id`, [id]),
  ]);
  const row = canvasRes.rows[0];
  if (row === undefined) return null;
  const vp = await db.query<{ viewport: { x: number; y: number; zoom: number } | null }>(`SELECT viewport FROM canvases WHERE id = $1`, [id]);
  return {
    ...rowToSummary(row),
    viewport: vp.rows[0]?.viewport ?? { x: 0, y: 0, zoom: 1 },
    nodes: nodesRes.rows.map(rowToNode),
    edges: edgesRes.rows.map(rowToEdge),
  };
}

export async function updateCanvas(
  id: string,
  patch: { title?: string; description?: string; project?: string | null; viewport?: object },
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
  const res = await db.query<{ id: string }>(`UPDATE canvases SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, vals);
  if (res.rows[0] === undefined) return null;
  if (patch.title !== undefined) scheduleGraphSync(id);
  const summary = await db.query<Record<string, unknown>>(`${SUMMARY_SQL} WHERE c.id = $1`, [id]);
  return summary.rows[0] ? rowToSummary(summary.rows[0]) : null;
}

export async function deleteCanvas(id: string): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM canvases WHERE id = $1`, [id]);
  await db.query(`DELETE FROM nodes WHERE ref_id = $1 AND ref_type = 'canvas'`, [id]);
}

// ─── Pinned notes ─────────────────────────────────────────────────────────────

export async function linkNote(canvasId: string, noteId: string): Promise<void> {
  const db = getDb();
  await db.query(`INSERT INTO canvas_notes (canvas_id, note_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [canvasId, noteId]);
  await db.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
  scheduleGraphSync(canvasId);
}

export async function unlinkNote(canvasId: string, noteId: string): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM canvas_notes WHERE canvas_id = $1 AND note_id = $2`, [canvasId, noteId]);
  await db.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
  scheduleGraphSync(canvasId);
}

// ─── Changes ──────────────────────────────────────────────────────────────────

function requireId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new MapOpError(`${what}: invalid id`);
  return id;
}

function linkType(type: unknown): string {
  return typeof type === 'string' && type.trim() !== '' ? type.trim().toLowerCase().slice(0, TYPE_MAX_CHARS) : DEFAULT_LINK_TYPE;
}

function finite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

async function cardExists(client: PoolClient, canvasId: string, id: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM canvas_nodes WHERE canvas_id = $1 AND id = $2`, [canvasId, id]);
  return (r.rowCount ?? 0) > 0;
}

async function insertLink(client: PoolClient, canvasId: string, id: string, sourceId: string, targetId: string, type: unknown, label?: string): Promise<void> {
  if (sourceId === targetId) throw new MapOpError('link: a card can’t be connected to itself');
  if (!(await cardExists(client, canvasId, sourceId)) || !(await cardExists(client, canvasId, targetId))) {
    throw new MapOpError('link: card not found');
  }
  const cleanLabel = label !== undefined && label.trim() !== '' ? label.trim() : null;
  await client.query(
    `INSERT INTO canvas_edges (id, canvas_id, source_id, target_id, edge_type, label)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [requireId(id, 'link'), canvasId, sourceId, targetId, linkType(type), cleanLabel],
  );
}

async function applyOne(client: PoolClient, canvasId: string, op: MapOp): Promise<void> {
  switch (op.op) {
    case 'add': {
      const id = requireId(op.id, 'add');
      const x = finite(op.x);
      const y = finite(op.y);
      await client.query(
        `INSERT INTO canvas_nodes (id, canvas_id, node_type, ref_type, ref_id, label, body, url, x, y, placed, meta_tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [id, canvasId, op.nodeType ?? (op.refType !== undefined ? 'hub_ref' : 'text'), op.refType ?? null, op.refId ?? null,
          (op.label ?? '').slice(0, LABEL_MAX_CHARS), op.body ?? null, op.url ?? null, x ?? 0, y ?? 0, x !== null && y !== null,
          Array.isArray(op.tags) ? JSON.stringify(op.tags.filter((t) => typeof t === 'string').slice(0, MAX_CARD_TAGS)) : null],
      );
      if (op.connectTo !== undefined) {
        await insertLink(client, canvasId, op.connectTo.edgeId, requireId(op.connectTo.nodeId, 'add connectTo'), id, op.connectTo.type);
      }
      return;
    }
    case 'update': {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (op.label !== undefined) { vals.push(op.label.slice(0, LABEL_MAX_CHARS)); sets.push(`label = $${vals.length.toString()}`); }
      if (op.body !== undefined) { vals.push(op.body.trim() === '' ? null : op.body); sets.push(`body = $${vals.length.toString()}`); }
      if (sets.length === 0) return;
      vals.push(requireId(op.id, 'update'), canvasId);
      await client.query(`UPDATE canvas_nodes SET ${sets.join(', ')} WHERE id = $${(vals.length - 1).toString()} AND canvas_id = $${vals.length.toString()}`, vals);
      return;
    }
    case 'position': {
      const x = finite(op.x);
      const y = finite(op.y);
      if (x === null || y === null) throw new MapOpError('position: x and y must be numbers');
      await client.query(`UPDATE canvas_nodes SET x = $1, y = $2, placed = TRUE WHERE id = $3 AND canvas_id = $4`,
        [x, y, requireId(op.id, 'position'), canvasId]);
      return;
    }
    case 'delete':
      // Its connections go with it (canvas_edges cascade on the card).
      await client.query(`DELETE FROM canvas_nodes WHERE id = $1 AND canvas_id = $2`, [requireId(op.id, 'delete'), canvasId]);
      return;
    case 'link':
      await insertLink(client, canvasId, op.id, requireId(op.sourceId, 'link from'), requireId(op.targetId, 'link to'), op.type, op.label);
      return;
    case 'update_link': {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (op.type !== undefined) { vals.push(linkType(op.type)); sets.push(`edge_type = $${vals.length.toString()}`); }
      if (op.label !== undefined) { vals.push(op.label.trim() === '' ? null : op.label); sets.push(`label = $${vals.length.toString()}`); }
      if (sets.length === 0) return;
      vals.push(requireId(op.id, 'update_link'), canvasId);
      await client.query(`UPDATE canvas_edges SET ${sets.join(', ')} WHERE id = $${(vals.length - 1).toString()} AND canvas_id = $${vals.length.toString()}`, vals);
      return;
    }
    case 'unlink':
      await client.query(`DELETE FROM canvas_edges WHERE id = $1 AND canvas_id = $2`, [requireId(op.id, 'unlink'), canvasId]);
      return;
    default:
      throw new MapOpError('unknown change');
  }
}

/** Applies changes in order, all-or-nothing. Returns the updated canvas. */
export async function applyOps(canvasId: string, ops: MapOp[]): Promise<CanvasFull> {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM canvases WHERE id = $1 FOR UPDATE`, [canvasId]);
    if (exists.rowCount === 0) throw new MapOpError('Canvas not found');
    for (const op of ops) await applyOne(client, canvasId, op);
    await client.query(`UPDATE canvases SET updated_at = NOW() WHERE id = $1`, [canvasId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (ops.some((o) => o.op === 'add' || o.op === 'delete' || (o.op === 'update' && o.label !== undefined))) scheduleGraphSync(canvasId);
  return (await getCanvas(canvasId))!;
}

// ─── Outline (Athena context, export, summary note) ──────────────────────────

const REF_LABEL: Record<RefType, string> = {
  note: 'Think note', content_item: 'document/meeting/post', spark: 'Spark', discover_item: 'Discover article', ai_session: 'Athena chat',
};

export function cardKind(node: Pick<CanvasNode, 'refType'>): string {
  return node.refType !== null ? REF_LABEL[node.refType] : 'idea';
}

/**
 * The canvas as text: cards with short aliases (c1, c2 … in creation order)
 * that Athena uses to refer to them, then the connections. Returns the
 * alias → id map too.
 */
export function mapOutline(map: CanvasFull, selectedId?: string): { text: string; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const idToAlias = new Map<string, string>();
  map.nodes.forEach((n, i) => {
    const alias = `c${(i + 1).toString()}`;
    aliases.set(alias, n.id);
    idToAlias.set(n.id, alias);
  });
  const pinned = new Set(map.linkedNotes.map((n) => n.id));
  const cards = map.nodes.map((n) => {
    const tags = [cardKind(n), n.refType === 'note' && n.refId !== null && pinned.has(n.refId) ? 'pinned note' : ''].filter(Boolean).join(', ');
    const note = n.body !== null && n.body.trim() !== '' ? ` — note: ${n.body.replace(/\s+/g, ' ').slice(0, BODY_PREVIEW_CHARS)}` : '';
    return `- [${idToAlias.get(n.id) ?? '?'}] ${n.label ?? '(untitled)'} (${tags})${note}${n.id === selectedId ? '  ← SELECTED' : ''}`;
  });
  const links = map.edges.map((e) =>
    `- ${idToAlias.get(e.sourceId) ?? '?'} —${e.type}→ ${idToAlias.get(e.targetId) ?? '?'}${e.label !== null ? ` ("${e.label}")` : ''}`);
  const text = [
    `Canvas "${map.title}"${map.linkedNotes.length > 0 ? ` — pinned to notes: ${map.linkedNotes.map((n) => `"${n.title}"`).join(', ')}` : ''}`,
    'Cards:',
    ...cards,
    ...(links.length > 0 ? ['Connections:', ...links] : ['Connections: none yet']),
  ].join('\n');
  return { text, aliases };
}

type Inline = Array<{ type: 'text'; text: string; styles: Record<string, never> }>;
interface OutBlock { type: string; props?: Record<string, unknown>; content: Inline; children: OutBlock[] }
const inline = (t: string): Inline => [{ type: 'text', text: t, styles: {} }];

function connectionsOf(map: CanvasFull, id: string): Array<{ type: string; label: string | null; other: CanvasNode }> {
  return map.edges.flatMap((e) => {
    const otherId = e.sourceId === id ? e.targetId : e.targetId === id ? e.sourceId : null;
    const other = otherId !== null ? map.nodes.find((n) => n.id === otherId) : undefined;
    return other !== undefined ? [{ type: e.type, label: e.label, other }] : [];
  });
}

/**
 * A card and everything connected to it, as note blocks: the card's
 * annotation, then its connections grouped by type (with each card's kind and
 * annotation). `asSection` adds it to an existing note under a heading.
 */
export function cardSummaryBlocks(map: CanvasFull, nodeId: string, asSection: boolean): { title: string; blocks: OutBlock[] } {
  const node = map.nodes.find((n) => n.id === nodeId);
  if (node === undefined) throw new MapOpError('Card not found');
  const title = node.label ?? 'Untitled';
  const blocks: OutBlock[] = [{ type: 'heading', props: { level: asSection ? H2 : H1 }, content: inline(title), children: [] }];
  if (node.body !== null && node.body.trim() !== '') blocks.push({ type: 'paragraph', content: inline(node.body), children: [] });
  const byType = new Map<string, ReturnType<typeof connectionsOf>>();
  for (const c of connectionsOf(map, node.id)) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  for (const [type, conns] of byType) {
    blocks.push({ type: 'heading', props: { level: asSection ? H3 : H2 }, content: inline(type.charAt(0).toUpperCase() + type.slice(1)), children: [] });
    for (const c of conns) {
      const note = c.other.body !== null && c.other.body.trim() !== '' ? ` — ${c.other.body}` : '';
      blocks.push({
        type: 'bulletListItem',
        content: inline(`${c.other.label ?? 'Untitled'} (${cardKind(c.other)})${c.label !== null ? ` [${c.label}]` : ''}${note}`),
        children: [],
      });
    }
  }
  return { title, blocks };
}

/** The whole canvas as Markdown (export). */
export function mapMarkdown(map: CanvasFull): string {
  const title = new Map(map.nodes.map((n) => [n.id, n.label ?? 'Untitled']));
  return [
    `# ${map.title}`,
    '',
    '## Cards',
    ...map.nodes.map((n) => `- **${n.label ?? 'Untitled'}** (${cardKind(n)})${n.body !== null && n.body.trim() !== '' ? ` — ${n.body}` : ''}`),
    '',
    '## Connections',
    ...(map.edges.length === 0 ? ['- none'] : map.edges.map((e) =>
      `- ${title.get(e.sourceId) ?? '?'} → *${e.type}* → ${title.get(e.targetId) ?? '?'}${e.label !== null ? ` (${e.label})` : ''}`)),
  ].join('\n');
}

// ─── Knowledge graph ──────────────────────────────────────────────────────────

const GRAPH_SYNC_DELAY_MS = 5_000;
const pendingGraphSync = new Map<string, ReturnType<typeof setTimeout>>();
const GRAPH_REF: Partial<Record<RefType, string>> = { note: 'note', content_item: 'document', spark: 'spark', discover_item: 'discover_item' };

/**
 * Mirrors a canvas into the knowledge graph: a 'canvas' node with 'on_map'
 * edges to its pinned notes and to every item placed on it. Debounced.
 */
function scheduleGraphSync(canvasId: string): void {
  const existing = pendingGraphSync.get(canvasId);
  if (existing !== undefined) clearTimeout(existing);
  pendingGraphSync.set(canvasId, setTimeout(() => {
    pendingGraphSync.delete(canvasId);
    void syncMapToGraph(canvasId).catch((err: unknown) => {
      console.error('[canvas] graph sync failed:', err instanceof Error ? err.message : String(err));
    });
  }, GRAPH_SYNC_DELAY_MS));
}

async function syncMapToGraph(canvasId: string): Promise<void> {
  const db = getDb();
  const map = await getCanvas(canvasId);
  if (map === null) return;
  const labels = map.nodes.map((n) => n.label ?? '').filter((l) => l !== '');
  const graphId = await upsertNode(db, canvasId, 'canvas', map.title, labels.slice(0, GRAPH_TAG_LABELS));
  const refs = new Set<string>(); // `${graphRefType}:${refId}`
  for (const n of map.linkedNotes) refs.add(`note:${n.id}`);
  for (const n of map.nodes) {
    const g = n.refType !== null ? GRAPH_REF[n.refType] : undefined;
    if (g !== undefined && n.refId !== null) refs.add(`${g}:${n.refId}`);
  }
  await db.query(`DELETE FROM edges WHERE source_node_id = $1 AND edge_type = 'on_map'`, [graphId]);
  for (const key of refs) {
    const [refType, ...rest] = key.split(':');
    const target = await db.query<{ id: string }>(`SELECT id FROM nodes WHERE ref_id = $1 AND ref_type = $2`, [rest.join(':'), refType]);
    const targetId = target.rows[0]?.id;
    if (targetId === undefined) continue;
    await db.query(
      `INSERT INTO edges (source_node_id, target_node_id, edge_type, confidence, metadata)
       VALUES ($1, $2, 'on_map', 1, $3) ON CONFLICT DO NOTHING`,
      [graphId, targetId, JSON.stringify({ mapTitle: map.title })],
    );
  }
}
