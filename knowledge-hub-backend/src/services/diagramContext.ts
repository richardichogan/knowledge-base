import type { Pool } from 'pg';
import type { DiagramDocument } from '../types/diagram.js';
import { renderNoteAsText } from './noteTextService.js';
import { parseNoteContent } from '../utils/noteContent.js';

export const DIAGRAM_READING_GUIDANCE = [
  'These are saved diagram records, not screenshots. Read shapes, labels, descriptions, explicit parent/container IDs and connectors as evidence.',
  'For arrows=end, direction is source to target; both means bidirectional; none means an undirected connection, not a directed flow.',
  'Standalone line objects are decorative marks, not connectors. Position, colour, proximity and matching labels do not establish a relationship.',
  'Compare diagrams using search_diagrams and read_diagram. Cite diagram titles and shape labels; distinguish explicit connections from inferred similarities or gaps.',
  'Linked notes are supporting context, not diagram shapes. Asset names identify uploaded icons only: their pixels have not been analysed.',
  'Truncated content is incomplete: do not claim an omitted shape, connector or detail is absent.',
  'You may analyse and recommend changes but cannot modify diagrams. propose_map_changes is for brainstorm canvases only.',
].join('\n');

interface DiagramRow {
  id: string; title: string; description: string | null; project: string | null;
  revision: number; updated_at: string; document: DiagramDocument;
  linked_notes: Array<{ id: string; content: string }>;
  assets: Array<{ id: string; name: string }>;
}

/** Bounded, whole-record output so truncated diagrams never acquire dangling partial JSON. */
export function diagramEvidence(document: DiagramDocument, budget = 24_000, selectedId?: string): string {
  const clipped = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)} [truncated]` : text;
  let remaining = Math.max(0, budget - 700);
  let shortened = false;
  const take = (record: object): object | null => {
    const size = JSON.stringify(record).length + 1;
    if (size > remaining) return null;
    remaining -= size;
    return record;
  };
  const shapes: object[] = [];
  const connectors: object[] = [];
  // Reserve space for relationships rather than letting long shape descriptions consume it all.
  const shapeBudget = Math.floor(remaining * 0.65);
  const connectionReserve = remaining - shapeBudget;
  remaining = shapeBudget;
  const ordered = selectedId === undefined ? document.nodes
    : [...document.nodes.filter(n => n.id === selectedId), ...document.nodes.filter(n => n.id !== selectedId)];
  for (const node of ordered) {
    if (node.label.length > 800 || (node.description?.length ?? 0) > 1500) shortened = true;
    const record = take({
      id: node.id, kind: node.kind, label: clipped(node.label, 800),
      description: clipped(node.description ?? '', 1500), parentId: node.parentId,
      bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
      assetId: node.assetId, ...(node.id === selectedId ? { selected: true } : {}),
      ...(node.kind === 'line' ? { lineStart: node.lineStart ?? { x: 0, y: 0.5 }, lineEnd: node.lineEnd ?? { x: 1, y: 0.5 } } : {}),
    });
    if (record !== null) shapes.push(record);
  }
  remaining += connectionReserve;
  for (const edge of document.edges) {
    if (edge.label.length > 800 || (edge.description?.length ?? 0) > 1500) shortened = true;
    const record = take({ id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId,
      arrows: edge.arrows, label: clipped(edge.label, 800), description: clipped(edge.description ?? '', 1500),
      ...(edge.id === selectedId ? { selected: true } : {}) });
    if (record !== null) connectors.push(record);
  }
  return JSON.stringify({ version: document.version, totalShapes: document.nodes.length,
    totalConnectors: document.edges.length, omittedShapes: document.nodes.length - shapes.length,
    omittedConnectors: document.edges.length - connectors.length, truncatedDetails: shortened,
    shapes, connectors });
}

export async function findDiagramContext(db: Pool, args: {
  query?: string; diagramId?: string; projectId?: string; limit?: number; selectedId?: string;
  excludedIds?: ReadonlySet<string>;
}): Promise<{ results: Array<{ id: string; title: string; project: string | null; url: string; content: string }>; resultCount: number; guidance: string }> {
  const limit = Math.max(1, Math.min(5, Math.floor(args.limit ?? 3)));
  const query = (args.query ?? '').trim().slice(0, 500);
  const { rows } = await db.query<DiagramRow>(`
    SELECT c.id::text, c.title, c.description, c.project, d.revision, d.updated_at, d.document,
      COALESCE((SELECT json_agg(json_build_object('id', n.id::text, 'content', n.content) ORDER BY cn.created_at)
        FROM canvas_notes cn JOIN notes n ON n.id::text = cn.note_id AND n.status = 'active'
        WHERE cn.canvas_id = c.id), '[]'::json) AS linked_notes,
      COALESCE((SELECT json_agg(json_build_object('id', a.id::text, 'name', a.name))
        FROM canvas_diagram_assets a WHERE a.canvas_id = c.id), '[]'::json) AS assets
    FROM canvases c JOIN canvas_diagrams d ON d.canvas_id = c.id
    WHERE c.canvas_type = 'diagram'
      AND ($1::text IS NULL OR c.id::text = $1)
      AND NOT (c.id::text = ANY($5::text[]))
      AND ($2::text IS NULL OR c.project = $2 OR EXISTS (
        SELECT 1 FROM canvas_notes cn JOIN notes n ON n.id::text = cn.note_id
        WHERE cn.canvas_id = c.id AND n.status = 'active' AND n.project_id = $2))
      AND ($3::text = '' OR strpos(lower(c.title || ' ' || COALESCE(c.description, '')), lower($3)) > 0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.document->'nodes') item
          WHERE strpos(lower(COALESCE(item->>'label', '') || ' ' || COALESCE(item->>'description', '')), lower($3)) > 0)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.document->'edges') item
          WHERE strpos(lower(COALESCE(item->>'label', '') || ' ' || COALESCE(item->>'description', '')), lower($3)) > 0)
        OR EXISTS (SELECT 1 FROM canvas_notes cn JOIN notes n ON n.id::text = cn.note_id
          WHERE cn.canvas_id = c.id AND n.status = 'active' AND strpos(lower(n.content), lower($3)) > 0))
    ORDER BY c.updated_at DESC, c.id LIMIT $4`,
  [args.diagramId ?? null, args.projectId ?? null, query, limit, [...(args.excludedIds ?? [])]]);
  const results = await Promise.all(rows.map(async row => {
    const notes: Array<{ id: string; title: string; url: string; text: string; truncated: boolean }> = [];
    let noteBudget = 6000;
    for (const note of row.linked_notes) {
      if (args.excludedIds?.has(note.id) === true) continue;
      if (noteBudget <= 0 || notes.length >= 5) break;
      const text = await renderNoteAsText(db, note.content);
      const share = Math.min(2000, noteBudget);
      notes.push({ id: note.id, title: (parseNoteContent(note.content).title ?? 'Untitled').slice(0, 500),
        url: `/think?noteId=${encodeURIComponent(note.id)}`, text: text.slice(0, share), truncated: text.length > share });
      noteBudget -= Math.min(text.length, share);
    }
    return { id: row.id, title: row.title, project: row.project, url: `/think?mapId=${encodeURIComponent(row.id)}`,
      content: [
        JSON.stringify({ title: row.title, description: row.description?.slice(0, 1500) ?? null,
          project: row.project, revision: row.revision, savedAt: row.updated_at }),
        diagramEvidence(row.document, args.diagramId === undefined ? 12_000 : 24_000, args.selectedId),
        JSON.stringify({ linkedNotes: notes, omittedLinkedNotes: row.linked_notes.length - notes.length,
          assets: row.assets.slice(0, 100), omittedAssets: Math.max(0, row.assets.length - 100) }),
      ].join('\n') };
  }));
  return { results, resultCount: results.length, guidance: DIAGRAM_READING_GUIDANCE };
}
