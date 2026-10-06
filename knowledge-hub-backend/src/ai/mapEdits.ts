/**
 * ai/mapEdits.ts — changes Athena *proposes* to the canvas open next to the
 * chat. She refers to cards by the aliases in the canvas outline (c1, c2 …)
 * and to cards she adds by her own keys; content she found with a search
 * (notes, documents, meetings …) is looked up by its id. These are resolved
 * here into concrete canvas changes that the user previews and applies.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertBrainstorm, type CanvasFull, type MapOp, type RefType } from '../services/canvasService.js';

export interface MapChangeProposal {
  summary: string;
  ops: MapOp[];
}

type Action = 'add_idea' | 'add_content' | 'connect' | 'retype' | 'disconnect' | 'annotate' | 'rename' | 'remove';
const ACTIONS: readonly Action[] = ['add_idea', 'add_content', 'connect', 'retype', 'disconnect', 'annotate', 'rename', 'remove'];
const MAX_CHANGES = 60;
const SUMMARY_MAX_CHARS = 200;

// The kind shown on a card, by content source (matches the app's labels).
const SOURCE_KIND: Record<string, string> = {
  note: 'Think note', 'graph-calendar': 'Meeting', 'discovered-article': 'Discover article',
  'cms-blog': 'Blog / newsletter', 'cms-newsletter': 'Blog / newsletter', 'cms-podcast-show-notes': 'Blog / newsletter',
};

/** Resolves an id Athena got from a search into a card reference (note, or any other content item). */
async function resolveContent(db: Pool, rawId: string): Promise<{ refType: RefType; refId: string; title: string; url: string | null; kind: string } | null> {
  const id = rawId.trim();
  const item = await db.query<{ id: string; source: string; source_id: string; title: string | null; url: string | null }>(
    `SELECT id::text, source, source_id, title, url FROM content_items WHERE id::text = $1 OR (source = 'note' AND source_id = $1) LIMIT 1`, [id]);
  const row = item.rows[0];
  if (row !== undefined) {
    const kind = SOURCE_KIND[row.source] ?? 'Library document';
    if (row.source === 'note') return { refType: 'note', refId: row.source_id, title: row.title ?? 'Untitled note', url: null, kind };
    return { refType: row.source === 'discovered-article' ? 'discover_item' : 'content_item', refId: row.id, title: row.title ?? 'Untitled', url: row.url, kind };
  }
  const session = await db.query<{ title: string | null }>(`SELECT title FROM ai_chat_sessions WHERE id::text = $1`, [id]);
  if (session.rows[0] !== undefined) return { refType: 'ai_session', refId: id, title: session.rows[0].title ?? 'Athena chat', url: null, kind: 'Athena chat' };
  return null;
}

/**
 * Validates Athena's proposed changes against the canvas. Returns one
 * proposal per change (each a small list of ops), plus problems to report back.
 */
export async function resolveMapChanges(
  db: Pool,
  raw: unknown,
  map: CanvasFull,
  aliases: Map<string, string>,
): Promise<{ proposals: MapChangeProposal[]; problems: string[] }> {
  assertBrainstorm(map);
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_CHANGES);
  const keys = new Map<string, string>(); // Athena's key for a new card → its id
  const proposals: MapChangeProposal[] = [];
  const problems: string[] = [];
  const onCanvas = new Map(map.nodes.filter((n) => n.refId !== null).map((n) => [n.refId as string, n.id]));

  const ref = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const v = value.trim().replace(/^\[|\]$/g, '');
    return aliases.get(v) ?? keys.get(v);
  };
  const edgeBetween = (a: string, b: string): string | undefined =>
    map.edges.find((e) => (e.sourceId === a && e.targetId === b) || (e.sourceId === b && e.targetId === a))?.id;

  for (const [i, item] of list.entries()) {
    const c = (item ?? {}) as Record<string, unknown>;
    const n = `change ${(i + 1).toString()}`;
    const action = ACTIONS.find((a) => a === c['action']);
    const str = (k: string): string | undefined => { const v = c[k]; return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined; };
    const summary = (str('summary') ?? action ?? 'Change').slice(0, SUMMARY_MAX_CHARS);
    const type = str('type');
    if (action === undefined) { problems.push(`${n}: unknown action`); continue; }

    switch (action) {
      case 'add_idea':
      case 'add_content': {
        const connectTo = c['connect_to'] !== undefined ? ref(c['connect_to']) : undefined;
        if (c['connect_to'] !== undefined && connectTo === undefined) { problems.push(`${n}: "connect_to" must be a card alias (e.g. c3) or the key of a card added earlier`); continue; }
        const id = randomUUID();
        let card: MapOp & { op: 'add' };
        if (action === 'add_idea') {
          const label = str('label');
          if (label === undefined) { problems.push(`${n}: add_idea needs a "label"`); continue; }
          const note = str('note');
          card = { op: 'add', id, label, ...(note !== undefined && { body: note }) };
        } else {
          const contentId = str('content_id');
          if (contentId === undefined) { problems.push(`${n}: add_content needs "content_id" (the id from a search result)`); continue; }
          const found = await resolveContent(db, contentId);
          if (found === null) { problems.push(`${n}: no note, document, meeting or chat with id ${contentId}`); continue; }
          const existing = onCanvas.get(found.refId);
          if (existing !== undefined) {
            // Already on the canvas: just connect it.
            const k = str('key');
            if (k !== undefined) keys.set(k, existing);
            if (connectTo !== undefined && edgeBetween(connectTo, existing) === undefined) {
              proposals.push({ summary, ops: [{ op: 'link', id: randomUUID(), sourceId: connectTo, targetId: existing, ...(type !== undefined && { type }) }] });
            }
            continue;
          }
          const note = str('note');
          card = { op: 'add', id, label: str('label') ?? found.title, refType: found.refType, refId: found.refId, tags: [found.kind],
            ...(found.url !== null && { url: found.url }), ...(note !== undefined && { body: note }) };
          onCanvas.set(found.refId, id);
        }
        if (connectTo !== undefined) card.connectTo = { nodeId: connectTo, edgeId: randomUUID(), ...(type !== undefined && { type }) };
        const key = str('key');
        if (key !== undefined) keys.set(key, id);
        proposals.push({ summary, ops: [card] });
        continue;
      }
      case 'connect': {
        const from = ref(c['from']);
        const to = ref(c['to']);
        if (from === undefined || to === undefined) { problems.push(`${n}: connect needs "from" and "to" card aliases`); continue; }
        const label = str('label');
        proposals.push({ summary, ops: [{ op: 'link', id: randomUUID(), sourceId: from, targetId: to, ...(type !== undefined && { type }), ...(label !== undefined && { label }) }] });
        continue;
      }
      case 'retype':
      case 'disconnect': {
        const from = ref(c['from']);
        const to = ref(c['to']);
        const edge = from !== undefined && to !== undefined ? edgeBetween(from, to) : undefined;
        if (edge === undefined) { problems.push(`${n}: no connection between those cards`); continue; }
        if (action === 'disconnect') { proposals.push({ summary, ops: [{ op: 'unlink', id: edge }] }); continue; }
        if (type === undefined) { problems.push(`${n}: retype needs "type"`); continue; }
        const label = str('label');
        proposals.push({ summary, ops: [{ op: 'update_link', id: edge, type, ...(label !== undefined && { label }) }] });
        continue;
      }
      case 'annotate': {
        const id = ref(c['card']);
        const note = str('note');
        if (id === undefined || note === undefined) { problems.push(`${n}: annotate needs "card" and "note"`); continue; }
        proposals.push({ summary, ops: [{ op: 'update', id, body: note }] });
        continue;
      }
      case 'rename': {
        const id = ref(c['card']);
        const label = str('label');
        if (id === undefined || label === undefined) { problems.push(`${n}: rename needs "card" and "label"`); continue; }
        proposals.push({ summary, ops: [{ op: 'update', id, label }] });
        continue;
      }
      case 'remove': {
        const id = ref(c['card']);
        if (id === undefined) { problems.push(`${n}: remove needs "card"`); continue; }
        proposals.push({ summary, ops: [{ op: 'delete', id }] });
        continue;
      }
    }
  }
  return { proposals, problems };
}
