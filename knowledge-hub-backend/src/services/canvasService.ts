/**
 * services/canvasService.ts
 * Mind maps (the Think "Canvas" view).
 *
 * A map is a tree of ideas: one central idea (parent_id NULL) with branches
 * ordered by sort_order; the central idea's children sit on a side (left /
 * right). Layout is computed in the app, so x/y are unused. canvas_edges are
 * cross-links between any two ideas. canvas_notes links a map to Think notes.
 *
 * Tables: canvases, canvas_nodes, canvas_edges, canvas_notes
 */
import type { Pool, PoolClient } from 'pg';
import { getDb } from '../db/db.js';
import { upsertNode } from './nodeService.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeType = 'hub_ref' | 'text' | 'ai_output';
export type RefType  = 'discover_item' | 'spark' | 'note' | 'content_item' | 'ai_session';
export type Side = 'left' | 'right';

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
  body: string | null;
  url: string | null;
  tags: string[] | null;
  parentId: string | null;
  sortOrder: number;
  side: Side | null;
  collapsed: boolean;
  createdAt: string;
}

export interface CanvasEdge {
  id: string;
  canvasId: string;
  sourceId: string;
  targetId: string;
  label: string | null;
  createdAt: string;
}

export interface CanvasFull extends CanvasSummary {
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** One change to a map. Ids are client-generated UUIDs, so changes apply optimistically. */
export type MapOp =
  | { op: 'add'; id: string; parentId: string; index?: number; side?: Side; label?: string; body?: string;
      nodeType?: NodeType; refType?: RefType; refId?: string; url?: string }
  | { op: 'update'; id: string; label?: string; body?: string; collapsed?: boolean }
  | { op: 'move'; id: string; parentId: string; index?: number; side?: Side }
  | { op: 'delete'; id: string }
  | { op: 'link'; id: string; sourceId: string; targetId: string; label?: string }
  | { op: 'relabel_link'; id: string; label: string }
  | { op: 'unlink'; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEED_HEADINGS = 30;
/** Headings at or above this level become the central idea's branches. */
const TOP_HEADING_LEVEL = 2;
const LABEL_MAX_CHARS = 500;
const BODY_PREVIEW_CHARS = 200;
const GRAPH_TAG_LABELS = 10;
const HALVES = 2;
const isEven = (n: number): boolean => n % HALVES === 0;

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
    parentId:  (r['parent_id'] as string | null) ?? null,
    sortOrder: Number(r['sort_order'] ?? 0),
    side:      (r['side'] as Side | null) ?? null,
    collapsed: r['collapsed'] === true,
    createdAt: r['created_at'] as string,
  };
}

function rowToEdge(r: Record<string, unknown>): CanvasEdge {
  return {
    id:        r['id'] as string,
    canvasId:  r['canvas_id'] as string,
    sourceId:  r['source_id'] as string,
    targetId:  r['target_id'] as string,
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

// ─── Notes helpers ────────────────────────────────────────────────────────────

interface NoteBlock { type?: string; props?: { level?: number }; content?: unknown; children?: NoteBlock[] }

function blockText(block: NoteBlock): string {
  const content = block.content;
  if (!Array.isArray(content)) return '';
  return content.map((c: { text?: string }) => c.text ?? '').join('').trim();
}

async function loadNote(db: Pool | PoolClient, noteId: string): Promise<{ title: string; blocks: NoteBlock[]; projectId: string | null } | null> {
  const r = await db.query<{ content: string; project_id: string | null }>(
    `SELECT content, project_id FROM notes WHERE id::text = $1 AND status = 'active'`, [noteId]);
  const row = r.rows[0];
  if (row === undefined) return null;
  try {
    const wrapper = JSON.parse(row.content) as { title?: string; contentJson?: string };
    const blocks: unknown = JSON.parse(wrapper.contentJson ?? '[]');
    return { title: wrapper.title ?? 'Untitled', blocks: Array.isArray(blocks) ? blocks as NoteBlock[] : [], projectId: row.project_id };
  } catch {
    return { title: 'Untitled', blocks: [], projectId: row.project_id };
  }
}

// ─── Maps ─────────────────────────────────────────────────────────────────────

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
  rootLabel?: string;
  /** Link the map to this note; the note becomes the central idea. */
  noteId?: string;
  /** With noteId: the note's headings become the first branches. */
  seedFromHeadings?: boolean;
  project?: string;
}

export async function createCanvas(input: CreateMapInput = {}): Promise<CanvasFull> {
  const db = getDb();
  const client = await db.connect();
  let canvasId = '';
  try {
    await client.query('BEGIN');
    const note = input.noteId !== undefined ? await loadNote(client, input.noteId) : null;
    const title = input.title ?? note?.title ?? 'Untitled canvas';
    const res = await client.query<{ id: string }>(
      `INSERT INTO canvases (title, project) VALUES ($1, $2) RETURNING id`,
      [title, input.project ?? note?.projectId ?? null],
    );
    canvasId = res.rows[0]!.id;
    const root = await client.query<{ id: string }>(
      `INSERT INTO canvas_nodes (canvas_id, node_type, ref_type, ref_id, label)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      note !== null && input.noteId !== undefined
        ? [canvasId, 'hub_ref', 'note', input.noteId, note.title]
        : [canvasId, 'text', null, null, input.rootLabel ?? title],
    );
    const rootId = root.rows[0]!.id;

    if (note !== null && input.noteId !== undefined) {
      await client.query(`INSERT INTO canvas_notes (canvas_id, note_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [canvasId, input.noteId]);
      if (input.seedFromHeadings === true) {
        // Headings become branches: level 1–2 under the central idea, level 3 under the last of those.
        const headings = note.blocks
          .filter((b) => b.type === 'heading' && blockText(b) !== '')
          .map((b) => ({ level: Number(b.props?.level ?? 1), text: blockText(b) }))
          .filter((h, i) => !(i === 0 && h.text.toLowerCase() === note.title.toLowerCase()))
          .slice(0, MAX_SEED_HEADINGS);
        let lastTop: string | null = null;
        let topCount = 0;
        const childCount = new Map<string, number>();
        for (const h of headings) {
          if (h.level <= TOP_HEADING_LEVEL || lastTop === null) {
            const r = await client.query<{ id: string }>(
              `INSERT INTO canvas_nodes (canvas_id, node_type, label, parent_id, sort_order, side)
               VALUES ($1, 'text', $2, $3, $4, $5) RETURNING id`,
              [canvasId, h.text.slice(0, LABEL_MAX_CHARS), rootId, topCount, isEven(topCount) ? 'right' : 'left'],
            );
            lastTop = r.rows[0]!.id;
            topCount++;
          } else {
            const n = childCount.get(lastTop) ?? 0;
            await client.query(
              `INSERT INTO canvas_nodes (canvas_id, node_type, label, parent_id, sort_order) VALUES ($1, 'text', $2, $3, $4)`,
              [canvasId, h.text.slice(0, LABEL_MAX_CHARS), lastTop, n],
            );
            childCount.set(lastTop, n + 1);
          }
        }
      }
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
    db.query<Record<string, unknown>>(`SELECT * FROM canvas_nodes WHERE canvas_id = $1 ORDER BY sort_order, created_at`, [id]),
    db.query<Record<string, unknown>>(`SELECT * FROM canvas_edges WHERE canvas_id = $1 ORDER BY created_at`, [id]),
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

// ─── Note links ───────────────────────────────────────────────────────────────

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

// ─── Changes (tree edits, cross-links) ────────────────────────────────────────

/** Re-numbers a parent's children 0..n, placing `movingId` at `index` (end if undefined). */
async function renumber(client: PoolClient, canvasId: string, parentId: string, movingId?: string, index?: number): Promise<void> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM canvas_nodes WHERE canvas_id = $1 AND parent_id = $2 ORDER BY sort_order, created_at`,
    [canvasId, parentId],
  );
  const ids = r.rows.map((x) => x.id).filter((x) => x !== movingId);
  if (movingId !== undefined) {
    const at = index === undefined ? ids.length : Math.max(0, Math.min(index, ids.length));
    ids.splice(at, 0, movingId);
  }
  for (let i = 0; i < ids.length; i++) {
    await client.query(`UPDATE canvas_nodes SET sort_order = $1 WHERE id = $2`, [i, ids[i]]);
  }
}

async function nodeRow(client: PoolClient, canvasId: string, id: string): Promise<{ id: string; parent_id: string | null } | undefined> {
  const r = await client.query<{ id: string; parent_id: string | null }>(
    `SELECT id, parent_id FROM canvas_nodes WHERE canvas_id = $1 AND id = $2`, [canvasId, id]);
  return r.rows[0];
}

async function isDescendant(client: PoolClient, ancestorId: string, nodeId: string): Promise<boolean> {
  const r = await client.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM canvas_nodes WHERE id = $1
       UNION ALL SELECT c.id FROM canvas_nodes c JOIN sub ON c.parent_id = sub.id)
     SELECT 1 FROM sub WHERE id = $2`, [ancestorId, nodeId]);
  return (r.rowCount ?? 0) > 0;
}

function requireId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new MapOpError(`${what}: invalid id`);
  return id;
}

async function applyOne(client: PoolClient, canvasId: string, op: MapOp): Promise<void> {
  switch (op.op) {
    case 'add': {
      const id = requireId(op.id, 'add');
      const parent = await nodeRow(client, canvasId, requireId(op.parentId, 'add parent'));
      if (parent === undefined) throw new MapOpError('add: parent idea not found');
      await client.query(
        `INSERT INTO canvas_nodes (id, canvas_id, node_type, ref_type, ref_id, label, body, url, parent_id, side, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 999999)
         ON CONFLICT (id) DO NOTHING`,
        [id, canvasId, op.nodeType ?? (op.refType !== undefined ? 'hub_ref' : 'text'), op.refType ?? null, op.refId ?? null,
          (op.label ?? '').slice(0, LABEL_MAX_CHARS), op.body ?? null, op.url ?? null, parent.id,
          parent.parent_id === null ? (op.side ?? 'right') : null],
      );
      await renumber(client, canvasId, parent.id, id, op.index);
      return;
    }
    case 'update': {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (op.label !== undefined) { vals.push(op.label.slice(0, LABEL_MAX_CHARS)); sets.push(`label = $${vals.length.toString()}`); }
      if (op.body !== undefined) { vals.push(op.body); sets.push(`body = $${vals.length.toString()}`); }
      if (op.collapsed !== undefined) { vals.push(op.collapsed); sets.push(`collapsed = $${vals.length.toString()}`); }
      if (sets.length === 0) return;
      vals.push(requireId(op.id, 'update'), canvasId);
      await client.query(`UPDATE canvas_nodes SET ${sets.join(', ')} WHERE id = $${(vals.length - 1).toString()} AND canvas_id = $${vals.length.toString()}`, vals);
      return;
    }
    case 'move': {
      const node = await nodeRow(client, canvasId, requireId(op.id, 'move'));
      const parent = await nodeRow(client, canvasId, requireId(op.parentId, 'move parent'));
      if (node === undefined || parent === undefined) throw new MapOpError('move: idea not found');
      if (node.parent_id === null) throw new MapOpError('move: the central idea cannot be moved');
      if (await isDescendant(client, node.id, parent.id)) throw new MapOpError('move: cannot move an idea into its own branch');
      const oldParent = node.parent_id;
      await client.query(`UPDATE canvas_nodes SET parent_id = $1, side = $2 WHERE id = $3`,
        [parent.id, parent.parent_id === null ? (op.side ?? 'right') : null, node.id]);
      await renumber(client, canvasId, parent.id, node.id, op.index);
      if (oldParent !== parent.id) await renumber(client, canvasId, oldParent);
      return;
    }
    case 'delete': {
      const node = await nodeRow(client, canvasId, requireId(op.id, 'delete'));
      if (node === undefined) return;
      if (node.parent_id === null) throw new MapOpError('delete: the central idea cannot be deleted');
      await client.query(`DELETE FROM canvas_nodes WHERE id = $1`, [node.id]); // branch cascades
      await renumber(client, canvasId, node.parent_id);
      return;
    }
    case 'link': {
      const source = await nodeRow(client, canvasId, requireId(op.sourceId, 'link from'));
      const target = await nodeRow(client, canvasId, requireId(op.targetId, 'link to'));
      if (source === undefined || target === undefined) throw new MapOpError('link: idea not found');
      if (source.id === target.id) throw new MapOpError('link: cannot link an idea to itself');
      await client.query(
        `INSERT INTO canvas_edges (id, canvas_id, source_id, target_id, edge_type, label)
         VALUES ($1, $2, $3, $4, 'relates-to', $5) ON CONFLICT (id) DO NOTHING`,
        [requireId(op.id, 'link'), canvasId, source.id, target.id, op.label ?? null]);
      return;
    }
    case 'relabel_link':
      await client.query(`UPDATE canvas_edges SET label = $1 WHERE id = $2 AND canvas_id = $3`,
        [op.label.trim() === '' ? null : op.label, requireId(op.id, 'relabel_link'), canvasId]);
      return;
    case 'unlink':
      await client.query(`DELETE FROM canvas_edges WHERE id = $1 AND canvas_id = $2`, [requireId(op.id, 'unlink'), canvasId]);
      return;
    default:
      throw new MapOpError('unknown change');
  }
}

/** Applies changes in order, all-or-nothing. Returns the updated map. */
export async function applyOps(canvasId: string, ops: MapOp[]): Promise<CanvasFull> {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM canvases WHERE id = $1 FOR UPDATE`, [canvasId]);
    if (exists.rowCount === 0) throw new MapOpError('Map not found');
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

// ─── Outline (Athena context, export, branch → note) ─────────────────────────

function childrenOf(nodes: CanvasNode[], parentId: string): CanvasNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
}

const REF_LABEL: Record<RefType, string> = {
  note: 'Think note', content_item: 'linked item', spark: 'Spark', discover_item: 'Discover article', ai_session: 'Athena chat',
};

/**
 * The map as an indented outline with short aliases (n1, n2 … in reading
 * order) that Athena uses to refer to ideas. Returns the alias → id map too.
 */
export function mapOutline(map: CanvasFull, selectedId?: string): { text: string; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const lines: string[] = [];
  const root = map.nodes.find((n) => n.parentId === null);
  const walk = (node: CanvasNode, depth: number): void => {
    const alias = `n${(aliases.size + 1).toString()}`;
    aliases.set(alias, node.id);
    const ref = node.refType !== null ? ` (${REF_LABEL[node.refType]})` : '';
    const side = node.side !== null ? ` [${node.side}]` : '';
    const selected = node.id === selectedId ? '  ← SELECTED' : '';
    const body = node.body !== null && node.body.trim() !== '' ? ` — ${node.body.replace(/\s+/g, ' ').slice(0, BODY_PREVIEW_CHARS)}` : '';
    lines.push(`${'  '.repeat(depth)}- [${alias}] ${node.label ?? '(untitled)'}${ref}${side}${body}${selected}`);
    for (const c of childrenOf(map.nodes, node.id)) walk(c, depth + 1);
  };
  if (root !== undefined) walk(root, 0);
  const idToAlias = new Map([...aliases].map(([a, id]) => [id, a]));
  const links = map.edges.map((e) => `- ${idToAlias.get(e.sourceId) ?? '?'} ↔ ${idToAlias.get(e.targetId) ?? '?'}${e.label !== null ? ` ("${e.label}")` : ''}`);
  const text = [
    `Canvas "${map.title}"${map.linkedNotes.length > 0 ? ` — linked to notes: ${map.linkedNotes.map((n) => `"${n.title}"`).join(', ')}` : ''}`,
    ...lines,
    ...(links.length > 0 ? ['Cross-links:', ...links] : []),
  ].join('\n');
  return { text, aliases };
}

type Inline = Array<{ type: 'text'; text: string; styles: Record<string, never> }>;
interface OutBlock { type: string; props?: Record<string, unknown>; content: Inline; children: OutBlock[] }

const text = (t: string): Inline => [{ type: 'text', text: t, styles: {} }];

function bulletTree(nodes: CanvasNode[], parentId: string): OutBlock[] {
  return childrenOf(nodes, parentId).map((c) => ({
    type: 'bulletListItem',
    content: text(c.body !== null && c.body.trim() !== '' ? `${c.label ?? ''} — ${c.body}` : c.label ?? ''),
    children: bulletTree(nodes, c.id),
  }));
}

/** A branch as note blocks: its sub-ideas as sections, deeper ideas as nested bullets. */
export function branchBlocks(map: CanvasFull, nodeId: string, asSection: boolean): { title: string; blocks: OutBlock[] } {
  const node = map.nodes.find((n) => n.id === nodeId);
  if (node === undefined) throw new MapOpError('Idea not found');
  const title = node.label ?? 'Untitled';
  // A new note opens with its title as a level-1 heading (Think takes the title from it).
  const blocks: OutBlock[] = [{ type: 'heading', props: { level: asSection ? 2 : 1 }, content: text(title), children: [] }];
  if (node.body !== null && node.body.trim() !== '') blocks.push({ type: 'paragraph', content: text(node.body), children: [] });
  for (const c of childrenOf(map.nodes, node.id)) {
    if (asSection) {
      blocks.push({ type: 'bulletListItem', content: text(c.label ?? ''), children: bulletTree(map.nodes, c.id) });
    } else {
      blocks.push({ type: 'heading', props: { level: 2 }, content: text(c.label ?? ''), children: [] });
      if (c.body !== null && c.body.trim() !== '') blocks.push({ type: 'paragraph', content: text(c.body), children: [] });
      blocks.push(...bulletTree(map.nodes, c.id));
    }
  }
  return { title, blocks };
}

/** The whole map as a Markdown outline (export). */
export function mapMarkdown(map: CanvasFull): string {
  const root = map.nodes.find((n) => n.parentId === null);
  const out: string[] = [`# ${map.title}`, ''];
  const walk = (node: CanvasNode, depth: number): void => {
    out.push(`${'  '.repeat(depth)}- ${node.label ?? ''}${node.body !== null && node.body.trim() !== '' ? ` — ${node.body}` : ''}`);
    for (const c of childrenOf(map.nodes, node.id)) walk(c, depth + 1);
  };
  if (root !== undefined) {
    for (const c of childrenOf(map.nodes, root.id)) walk(c, 0);
  }
  return out.join('\n');
}

// ─── Knowledge graph ──────────────────────────────────────────────────────────

const GRAPH_SYNC_DELAY_MS = 5_000;
const pendingGraphSync = new Map<string, ReturnType<typeof setTimeout>>();
const GRAPH_REF: Partial<Record<RefType, string>> = { note: 'note', content_item: 'document', spark: 'spark', discover_item: 'discover_item' };

/**
 * Mirrors a map into the knowledge graph: a 'canvas' node with 'on_map'
 * edges to its linked notes and to every item placed on it. Debounced.
 */
function scheduleGraphSync(canvasId: string): void {
  const existing = pendingGraphSync.get(canvasId);
  if (existing !== undefined) clearTimeout(existing);
  pendingGraphSync.set(canvasId, setTimeout(() => {
    pendingGraphSync.delete(canvasId);
    void syncMapToGraph(canvasId).catch((err: unknown) => {
      console.error('[maps] graph sync failed:', err instanceof Error ? err.message : String(err));
    });
  }, GRAPH_SYNC_DELAY_MS));
}

async function syncMapToGraph(canvasId: string): Promise<void> {
  const db = getDb();
  const map = await getCanvas(canvasId);
  if (map === null) return;
  const labels = map.nodes.map((n) => n.label ?? '').filter((l) => l !== '');
  const graphId = await upsertNode(db, canvasId, 'canvas', map.title, labels.slice(0, GRAPH_TAG_LABELS));
  const refs = new Map<string, string>(); // `${refType}:${refId}` → graph ref type
  for (const n of map.linkedNotes) refs.set(`note:${n.id}`, 'note');
  for (const n of map.nodes) {
    const g = n.refType !== null ? GRAPH_REF[n.refType] : undefined;
    if (g !== undefined && n.refId !== null) refs.set(`${g}:${n.refId}`, g);
  }
  await db.query(`DELETE FROM edges WHERE source_node_id = $1 AND edge_type = 'on_map'`, [graphId]);
  for (const key of refs.keys()) {
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
