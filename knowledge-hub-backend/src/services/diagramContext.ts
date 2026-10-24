import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { KnowledgeAccess } from '../types/knowledge.js';
import { ValidationError } from '../types/errors.js';
import { decodeCursor, encodeCursor } from './knowledge/cursor.js';
import type { DiagramDocument } from '../types/diagram.js';
import { checkAiFlow } from './aiFlow.js';
import { renderNoteAsText } from './noteTextService.js';
import { parseNoteContent } from '../utils/noteContent.js';

const MAX_GOVERNANCE_FINDINGS = 25;
const MAX_PREVIEW_NOTES = 5;
const MAX_PREVIEW_NOTE_CHARS = 2000;
const MAX_PREVIEW_NOTE_TITLE_CHARS = 500;

export const DIAGRAM_READING_GUIDANCE = [
  'These are saved diagram records, not screenshots. Read shapes, labels, descriptions, explicit parent/container IDs and connectors as evidence.',
  'For arrows=end, direction is source to target; both means bidirectional; none means an undirected connection, not a directed flow.',
  'Standalone line objects are decorative marks, not connectors. Position, colour, proximity and matching labels do not establish a relationship.',
  'Text shapes may have calloutType: question, risk, issue, assumption, decision or action. These are annotation categories, not workflow states; a decision callout does not prove approval and an action callout is not a saved Plan task.',
  'Compare diagrams using search_diagrams and read_diagram. Cite diagram titles and shape labels; distinguish explicit connections from inferred similarities or gaps.',
  'Footnotes are numbered annotations on a shape or connector (targetId); their text explains that element. The key maps border (stroke) colours to meanings; a shape\'s keyLabel is that meaning. Collapsed containers still contain their child shapes.',
  'elementNotes are Think notes linked to one specific shape, connector or footnote (elementId).',
  'diagramType ai-flow is an AI flow / governance diagram: swimlanes are lanes (lane.order top to bottom, lane.owner is the owning team or persona) and a step\'s lane is its parentId. flow.stepType says whether a step is a human task, Digital Steward (orchestrating agent), Digital Worker, Specialist Agent, decision rules, integration, data operation, channel interaction or external party; flow.agent holds autonomy mode, assertion level, tools, knowledge, guardrails and escalation; flow.controls holds data sensitivity, auth, audit logging, human approval and regulatory tags. Connector flow.edgeType distinguishes primary, supporting, conditional, dependency and control flows. governanceFindings are automatic advisory checks of missing controls, not confirmed incidents; an absent field means not recorded, not that the control does not exist.',
  'Linked notes are supporting context, not diagram shapes. Asset names identify uploaded icons only: their pixels have not been analysed. Full checkpointed reads contain the stored nodes/edges and footnotes; summaries are derived memory, not verbatim source.',
  'Truncated content is incomplete: do not claim an omitted shape, connector or detail is absent.',
  'To change a diagram (add shapes, connectors, footnotes or key entries), call update_diagram with its id; to draw a new one, call create_diagram.',
  'You may analyse and recommend changes but cannot modify diagrams. propose_map_changes is for brainstorm canvases only.',
].join('\n');

interface DiagramRow {
  id: string; title: string; description: string | null; project: string | null;
  revision: number; updated_at: string; document: DiagramDocument;
  linked_notes: Array<{ id: string; content: string }>;
  element_notes: Array<{ elementId: string; noteId: string; content: string }>;
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
  const keyLabels = new Map((document.legend?.entries ?? [])
    .filter(e => e.label.trim() !== '').map(e => [e.colour.toLowerCase(), e.label.trim()] as const));
  const byId = new Map<string, { label: string; description?: string }>([...document.nodes, ...document.edges].map(item => [item.id, item]));
  const footnotes = (document.footnotes ?? []).map((f, i) => {
    const target = byId.get(f.targetId);
    const text = f.source === 'custom' ? f.text ?? '' : target?.description ?? '';
    if (text.length > 1500) shortened = true;
    return { number: i + 1, id: f.id, targetId: f.targetId, targetLabel: clipped(target?.label ?? '', 200), source: f.source, text: clipped(text, 1500) };
  });
  const annotations = JSON.stringify({ footnotes, key: [...keyLabels].map(([colour, label]) => ({ colour, label })) });
  remaining = Math.max(0, remaining - Math.min(annotations.length, Math.floor(remaining / 4)));
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
      ...(node.calloutType !== undefined ? { calloutType: node.calloutType } : {}),
      description: clipped(node.description ?? '', 1500), parentId: node.parentId,
      bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
      assetId: node.assetId, ...(node.id === selectedId ? { selected: true } : {}),
      ...(keyLabels.has(node.stroke.toLowerCase()) ? { keyLabel: keyLabels.get(node.stroke.toLowerCase()) } : {}),
      ...(node.collapsed === true ? { collapsed: true } : {}),
      ...(node.lane !== undefined ? { lane: node.lane } : {}),
      ...(node.flow !== undefined ? { flow: node.flow } : {}),
      ...(node.kind === 'line' ? { lineStart: node.lineStart ?? { x: 0, y: 0.5 }, lineEnd: node.lineEnd ?? { x: 1, y: 0.5 } } : {}),
    });
    if (record !== null) shapes.push(record);
  }
  remaining += connectionReserve;
  for (const edge of document.edges) {
    if (edge.label.length > 800 || (edge.description?.length ?? 0) > 1500) shortened = true;
    const record = take({ id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId,
      arrows: edge.arrows, label: clipped(edge.label, 800), description: clipped(edge.description ?? '', 1500),
      ...(edge.flow !== undefined ? { flow: edge.flow } : {}),
      ...(edge.id === selectedId ? { selected: true } : {}) });
    if (record !== null) connectors.push(record);
  }
  const aiFlow = document.diagramType === 'ai-flow' ? checkAiFlow(document) : undefined;
  return JSON.stringify({ version: document.version, ...(document.diagramType !== undefined ? { diagramType: document.diagramType } : {}),
    ...(aiFlow !== undefined ? {
      governanceFindings: aiFlow.slice(0, MAX_GOVERNANCE_FINDINGS).map(f => ({ severity: f.severity, code: f.code, targetId: f.targetId, message: f.message })),
      omittedGovernanceFindings: Math.max(0, aiFlow.length - MAX_GOVERNANCE_FINDINGS),
    } : {}),
    totalShapes: document.nodes.length,
    totalConnectors: document.edges.length, omittedShapes: document.nodes.length - shapes.length,
    omittedConnectors: document.edges.length - connectors.length, truncatedDetails: shortened,
    shapes, connectors, ...(annotations.length <= Math.floor(budget / 4)
      ? JSON.parse(annotations) as object
      : { footnotes: footnotes.slice(0, 20), omittedFootnotes: Math.max(0, footnotes.length - 20), key: [...keyLabels].map(([colour, label]) => ({ colour, label })) }) });
}

export async function findDiagramContext(db: Pool, args: {
  query?: string; diagramId?: string; projectId?: string; limit?: number; selectedId?: string;
  excludedIds?: ReadonlySet<string>; fullSource?: boolean;
}): Promise<{ results: Array<{ id: string; title: string; project: string | null; url: string; content: string; version: string }>; resultCount: number; guidance: string }> {
  const limit = Math.max(1, Math.min(5, Math.floor(args.limit ?? 3)));
  const query = (args.query ?? '').trim().slice(0, 500);
  const { rows } = await db.query<DiagramRow>(`
    SELECT c.id::text, c.title, c.description, c.project, d.revision, d.updated_at, d.document,
      COALESCE((SELECT json_agg(json_build_object('id', n.id::text, 'content', n.content) ORDER BY cn.created_at)
        FROM canvas_notes cn JOIN notes n ON n.id::text = cn.note_id AND n.status = 'active'
        WHERE cn.canvas_id = c.id), '[]'::json) AS linked_notes,
      COALESCE((SELECT json_agg(json_build_object('elementId', e.element_id::text, 'noteId', n.id::text, 'content', n.content) ORDER BY e.created_at)
        FROM diagram_element_notes e JOIN notes n ON n.id::text = e.note_id AND n.status = 'active'
        WHERE e.canvas_id = c.id), '[]'::json) AS element_notes,
      COALESCE((SELECT json_agg(json_build_object('id', a.id::text, 'name', a.name))
        FROM canvas_diagram_assets a WHERE a.canvas_id = c.id), '[]'::json) AS assets
    FROM canvases c JOIN canvas_diagrams d ON d.canvas_id = c.id
    WHERE c.canvas_type = 'diagram' AND c.deleted_at IS NULL
      AND ($1::text IS NULL OR c.id::text = $1)
      AND NOT (c.id::text = ANY($5::text[]))
      AND ($2::text IS NULL OR c.project = $2 OR EXISTS (
        SELECT 1 FROM canvas_notes cn JOIN notes n ON n.id::text = cn.note_id
        WHERE cn.canvas_id = c.id AND n.status = 'active' AND n.project_id = $2))
      AND ($3::text = '' OR strpos(lower(c.title || ' ' || COALESCE(c.description, '')), lower($3)) > 0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.document->'nodes') item
          WHERE strpos(lower(COALESCE(item->>'label', '') || ' ' || COALESCE(item->>'description', '') || ' ' || COALESCE(item->>'calloutType', '')
            || ' ' || COALESCE(item->>'flow', '') || ' ' || COALESCE(item->>'lane', '')), lower($3)) > 0)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.document->'edges') item
          WHERE strpos(lower(COALESCE(item->>'label', '') || ' ' || COALESCE(item->>'description', '') || ' ' || COALESCE(item->>'flow', '')), lower($3)) > 0)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(d.document->'footnotes', '[]'::jsonb)) item
          WHERE strpos(lower(COALESCE(item->>'text', '')), lower($3)) > 0)
        OR EXISTS (SELECT 1 FROM canvas_notes cn JOIN notes n ON n.id::text = cn.note_id
          WHERE cn.canvas_id = c.id AND n.status = 'active' AND strpos(lower(n.content), lower($3)) > 0))
    ORDER BY c.updated_at DESC, c.id LIMIT $4`,
  [args.diagramId ?? null, args.projectId ?? null, query, limit, [...(args.excludedIds ?? [])]]);
  const results = await Promise.all(rows.map(async row => {
    const notes: Array<{ id: string; title: string; url: string; text: string; truncated: boolean }> = [];
    let noteBudget = 6000;
    for (const note of row.linked_notes) {
      if (args.excludedIds?.has(note.id) === true) continue;
      if (!args.fullSource && (noteBudget <= 0 || notes.length >= MAX_PREVIEW_NOTES)) break;
      const text = await renderNoteAsText(db, note.content);
      const share = args.fullSource ? text.length : Math.min(MAX_PREVIEW_NOTE_CHARS, noteBudget);
      const title = parseNoteContent(note.content).title ?? 'Untitled';
      notes.push({ id: note.id, title: args.fullSource ? title : title.slice(0, MAX_PREVIEW_NOTE_TITLE_CHARS),
        url: `/think?noteId=${encodeURIComponent(note.id)}`, text: text.slice(0, share), truncated: text.length > share });
      noteBudget -= Math.min(text.length, share);
    }
    const content = args.fullSource ? [
      JSON.stringify({ title: row.title, description: row.description, project: row.project, revision: row.revision, savedAt: row.updated_at }),
      JSON.stringify(row.document),
      JSON.stringify({ elementNotes: row.element_notes.filter(n => args.excludedIds?.has(n.noteId) !== true)
        .map(n => ({ elementId: n.elementId, noteId: n.noteId, url: `/think?noteId=${encodeURIComponent(n.noteId)}` })) }),
      JSON.stringify({ linkedNotes: notes, assets: row.assets }),
    ].join('\n') : [
        JSON.stringify({ title: row.title, description: row.description?.slice(0, 1500) ?? null,
          project: row.project, revision: row.revision, savedAt: row.updated_at }),
        diagramEvidence(row.document, args.diagramId === undefined ? 12_000 : 24_000, args.selectedId),
        JSON.stringify({ elementNotes: row.element_notes.filter(n => args.excludedIds?.has(n.noteId) !== true).slice(0, 50).map(n => ({
          elementId: n.elementId, noteId: n.noteId, title: (parseNoteContent(n.content).title ?? 'Untitled').slice(0, 300),
          url: `/think?noteId=${encodeURIComponent(n.noteId)}` })) }),
        JSON.stringify({ linkedNotes: notes, omittedLinkedNotes: row.linked_notes.length - notes.length,
          assets: row.assets.slice(0, 100), omittedAssets: Math.max(0, row.assets.length - 100) }),
      ].join('\n');
    return { id: row.id, title: row.title, project: row.project, url: `/think?mapId=${encodeURIComponent(row.id)}`,
      content, version: createHash('sha256').update(content).digest('hex') };
  }));
  return { results, resultCount: results.length, guidance: DIAGRAM_READING_GUIDANCE };
}

const DIAGRAM_PAGE_CHARS = 12_000;

/** Versioned pages feed the existing checkpointed reader, including diagrams larger than one model context. */
export async function readDiagramPage(db: Pool, args: {
  diagramId: string; sessionId: string; cursor?: unknown; excludedIds?: ReadonlySet<string>;
}): Promise<KnowledgeAccess> {
  let offset = 0;
  let version: string | undefined;
  const binding = { ref: `diagram:${args.diagramId}`, sessionId: args.sessionId,
    scope: JSON.stringify([...(args.excludedIds ?? [])].sort()) };
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string') throw new ValidationError('Invalid diagram reading cursor.');
    const value = decodeCursor(args.cursor, binding);
    offset = value.offset;
    version = value.version;
  }
  if (args.excludedIds?.has(args.diagramId)) return { status: 'excluded' };
  const result = await findDiagramContext(db, { diagramId: args.diagramId, fullSource: true,
    ...(args.excludedIds !== undefined && { excludedIds: args.excludedIds }) });
  const source = result.results[0];
  if (!source) return { status: 'not_found' };
  if (version !== undefined && version !== source.version) return {
    status: 'unavailable', code: 'version_changed', retryable: true,
    message: 'The diagram or its linked context changed during reading. Restart to read one consistent version.',
  };
  if (offset > source.content.length) throw new ValidationError('Diagram reading offset is beyond the source.');
  const end = Math.min(offset + DIAGRAM_PAGE_CHARS, source.content.length);
  const nextCursor = end < source.content.length
    ? encodeCursor({ ...binding, version: source.version, offset: end }) : null;
  return {
    status: nextCursor === null ? 'ok' : 'partial', issues: [],
    coverage: { totalChars: source.content.length, returnedChars: end - offset, complete: offset === 0 && nextCursor === null },
    record: {
      ref: { kind: 'diagram', id: source.id }, title: source.title, projectId: source.project,
      fields: {}, origin: 'saved-diagram', version: source.version, createdAt: null, updatedAt: null,
      locator: { internalPath: source.url }, extractionState: 'complete', untrusted: true,
      content: source.content.slice(offset, end), startOffset: offset, endOffset: end,
      totalChars: source.content.length, nextCursor,
    },
  };
}
