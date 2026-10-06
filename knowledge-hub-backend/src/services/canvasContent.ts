/**
 * services/canvasContent.ts — the full content behind a canvas card, for the
 * Preview tab and for Athena (who reasons over everything on the canvas).
 *
 *   Think note        → the note rendered as text (images as their descriptions)
 *   document/meeting/post/article → the indexed content_items body
 *   Athena chat       → the conversation
 *   Spark             → the spark text
 *   idea              → its label and annotation
 */
import type { Pool } from 'pg';
import { renderNoteAsText } from './noteTextService.js';
import { assertBrainstorm, mapOutline, type CanvasFull, type CanvasNode } from './canvasService.js';
import { selectRelevantExcerpt } from '../ai/contextBuilder.js';

export interface CardContent {
  kind: string;
  title: string;
  text: string;
  url: string | null;
  date: string | null;
}

const SOURCE_KIND: Record<string, string> = {
  'graph-calendar': 'Meeting', 'cms-blog': 'Blog post', 'cms-newsletter': 'Newsletter', 'cms-podcast-show-notes': 'Podcast notes',
  'discovered-article': 'Discover article', note: 'Think note',
};
const CHAT_MESSAGE_LIMIT = 200;

export async function loadCardText(db: Pool, node: CanvasNode): Promise<CardContent> {
  const title = node.label ?? 'Untitled';
  const annotation = node.body !== null && node.body.trim() !== '' ? node.body : '';
  const idea: CardContent = { kind: node.refType === null ? 'Idea' : 'Item', title, text: annotation, url: node.url, date: null };
  if (node.refId === null) return idea;

  switch (node.refType) {
    case 'note': {
      const r = await db.query<{ content: string; updated_at: string }>(
        `SELECT content, updated_at FROM notes WHERE id::text = $1 AND status = 'active'`, [node.refId]);
      const row = r.rows[0];
      if (row === undefined) return { ...idea, kind: 'Think note', text: 'This note has been deleted or archived.' };
      return { kind: 'Think note', title, text: await renderNoteAsText(db, row.content), url: null, date: row.updated_at };
    }
    case 'content_item':
    case 'discover_item': {
      const r = await db.query<{ source: string; title: string | null; summary: string | null; body: string | null; url: string | null; published_at: string | null }>(
        `SELECT source, title, summary, body, url, published_at FROM content_items WHERE id::text = $1`, [node.refId]);
      const row = r.rows[0];
      if (row === undefined) return { ...idea, text: annotation || 'This item is no longer in the library.' };
      const text = [row.source === 'graph-calendar' ? row.summary : null, row.body ?? row.summary].filter((t): t is string => t !== null && t.trim() !== '').join('\n\n');
      return { kind: SOURCE_KIND[row.source] ?? 'Library document', title: row.title ?? title, text, url: row.url, date: row.published_at };
    }
    case 'ai_session': {
      const r = await db.query<{ role: string; content: string; created_at: string }>(
        `SELECT role, content, created_at FROM ai_chat_messages WHERE session_id::text = $1 ORDER BY created_at LIMIT $2`,
        [node.refId, CHAT_MESSAGE_LIMIT]);
      const text = r.rows.map((m) => `${m.role === 'user' ? 'Richard' : 'Athena'}: ${m.content}`).join('\n\n');
      return { kind: 'Athena chat', title, text, url: null, date: r.rows[r.rows.length - 1]?.created_at ?? null };
    }
    case 'spark': {
      const r = await db.query<{ body: string; created_at: string }>(`SELECT body, created_at FROM sparks WHERE id::text = $1`, [node.refId]);
      return { kind: 'Spark', title, text: r.rows[0]?.body ?? annotation, url: null, date: r.rows[0]?.created_at ?? null };
    }
    default:
      return idea;
  }
}

// ── Athena's view of a canvas ─────────────────────────────────────────────────

/** Total characters of card content given to Athena for one turn. */
const CANVAS_CONTEXT_BUDGET = 40_000;
/** Every card gets at least this much, even on a crowded canvas. */
const MIN_CARD_BUDGET = 1_500;
/** A trimmed card may run to twice its share when its relevant parts are long. */
const MAX_SHARE_MULTIPLE = 2;

/**
 * The canvas for Athena: its outline (cards with aliases, connections) and
 * the full text behind every card. When everything won't fit, each card's
 * text is cut down to the parts most relevant to the question.
 */
export async function buildCanvasContext(
  db: Pool,
  map: CanvasFull,
  question: string,
  selectedId?: string,
): Promise<{ text: string; aliases: Map<string, string> }> {
  assertBrainstorm(map);
  const outline = mapOutline(map, selectedId);
  const contents = await Promise.all(map.nodes.map(async (n) => {
    try { return await loadCardText(db, n); } catch { return null; }
  }));
  const withText = map.nodes
    .map((n, i) => ({ node: n, alias: `c${(i + 1).toString()}`, content: contents[i] ?? null }))
    .filter((c): c is { node: CanvasNode; alias: string; content: CardContent } => c.content !== null && c.content.text.trim() !== '');
  const total = withText.reduce((sum, c) => sum + c.content.text.length, 0);
  const share = Math.max(MIN_CARD_BUDGET, Math.floor(CANVAS_CONTEXT_BUDGET / Math.max(1, withText.length)));

  const sections = await Promise.all(withText.map(async ({ node, alias, content }) => {
    let body = content.text;
    let note = '';
    if (total > CANVAS_CONTEXT_BUDGET && body.length > share) {
      const { excerpt } = await selectRelevantExcerpt(body, `${question} ${node.label ?? ''}`, share, share);
      body = excerpt.length > share * MAX_SHARE_MULTIPLE ? excerpt.slice(0, share * MAX_SHARE_MULTIPLE) : excerpt;
      note = ' (excerpt — the parts most relevant to the question)';
    }
    return `### [${alias}] ${content.title} — ${content.kind}${note}\n${body}`;
  }));

  const text = [
    outline.text,
    ...(sections.length > 0 ? ['', '## Content of the cards', ...sections] : []),
  ].join('\n');
  return { text, aliases: outline.aliases };
}
