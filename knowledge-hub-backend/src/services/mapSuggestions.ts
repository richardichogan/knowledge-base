/**
 * services/mapSuggestions.ts — related content for an idea on a mind map:
 * Think notes, Library documents, meetings, blog/newsletter posts and past
 * Athena chats, ranked by relevance to the idea (and, more lightly, to its
 * parent and the central idea), plus knowledge-graph neighbours when the idea
 * is itself a linked note or document. Items already on the map are hidden.
 */
import { getDb } from '../db/db.js';
import type { CanvasFull, RefType } from './canvasService.js';

export type SuggestionKind = 'note' | 'document' | 'meeting' | 'post' | 'article' | 'chat';

export interface MapSuggestion {
  kind: SuggestionKind;
  refType: RefType;
  refId: string;
  title: string;
  excerpt: string;
  date: string | null;
  url: string | null;
  /** Why it was suggested: 'search' or 'graph'. */
  via: 'search' | 'graph';
}

const MAX_SUGGESTIONS = 24;
const PLACEHOLDER_LABELS = new Set(['', 'central idea', 'new idea', 'untitled', 'untitled map', 'untitled canvas']);
const PER_SOURCE_LIMIT = 40;
const CHAT_LIMIT = 5;
const EXCERPT_CHARS = 220;
const MIN_TERM_LENGTH = 3;
const MAX_TERMS = 12;
const GRAPH_NEIGHBOURS = 8;
// Chat score = matching messages (max 4) + 10 if one message matches every word;
// scaled so a chat that matches the whole idea ranks alongside a matching document.
const CHAT_SCORE_PER_MESSAGE = 0.08;

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'what', 'how', 'why', 'our', 'your', 'are', 'was', 'will', 'can', 'new', 'untitled', 'idea', 'map', 'does', 'look', 'like', 'have', 'just', 'more', 'some', 'than', 'then', 'them', 'they', 'when', 'where', 'which', 'would', 'could', 'should', 'there', 'their', 'what', 'who', 'its', 'also', 'any', 'all', 'not', 'but', 'has', 'had', 'been', 'being', 'does', 'did']);

const SOURCE_KIND: Record<string, SuggestionKind> = {
  note: 'note',
  'github-doc': 'document', 'github-content-store': 'document', 'user-upload': 'document',
  'onedrive-document': 'document', 'ica-document': 'document',
  'graph-calendar': 'meeting',
  'cms-blog': 'post', 'cms-newsletter': 'post', 'cms-podcast-show-notes': 'post',
  'discovered-article': 'article',
};

function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? [])
    .flatMap((t) => t.split('-'))
    .filter((t) => t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t)))].slice(0, MAX_TERMS);
}

/** The idea's text as the user sees it (it may not be saved yet). */
export interface SuggestionText { label?: string; body?: string; parentLabel?: string }

export async function suggestionsFor(map: CanvasFull, nodeId: string | undefined, text: SuggestionText = {}): Promise<MapSuggestion[]> {
  const db = getDb();
  const root = map.nodes.find((n) => n.parentId === null);
  const saved = map.nodes.find((n) => n.id === nodeId) ?? (text.label === undefined ? root : undefined);
  const node = saved !== undefined
    ? { ...saved, label: text.label ?? saved.label, body: text.body ?? saved.body }
    : { id: nodeId ?? '', parentId: null, refType: null, refId: null, label: text.label ?? '', body: text.body ?? null };
  if (node.label === null && root === undefined) return [];
  const parentLabel = text.parentLabel ?? map.nodes.find((n) => n.id === node.parentId)?.label ?? '';

  // Placeholder labels ("Central idea", "New idea") aren't worth searching for.
  if (PLACEHOLDER_LABELS.has((node.label ?? '').trim().toLowerCase()) && (node.body ?? '').trim() === '') return [];

  const onMap = new Set(map.nodes.filter((n) => n.refId !== null).map((n) => n.refId as string));
  const focus = terms(`${node.label ?? ''} ${node.body ?? ''}`);
  const context = terms(`${parentLabel} ${root?.id !== node.id ? root?.label ?? '' : ''}`).filter((t) => !focus.includes(t));
  const results: Array<MapSuggestion & { score: number }> = [];

  if (focus.length > 0) {
    // Any focus word must match; context words (parent, central idea) only raise the rank.
    const focusQ = focus.join(' | ');
    // Matching every word of the idea counts for much more than matching one.
    const allQ = focus.join(' & ');
    const contextQ = context.length > 0 ? context.join(' | ') : null;
    const rows = await db.query<{
      id: string; source: string; source_id: string; title: string; url: string | null;
      published_at: string | null; excerpt: string; score: number;
    }>(
      `SELECT ci.id::text, ci.source, ci.source_id, COALESCE(NULLIF(ci.title, ''), 'Untitled') AS title, ci.url,
              ci.published_at,
              ts_headline('english', left(coalesce(ci.body, ci.summary, ''), 20000), to_tsquery('english', $1),
                'MaxFragments=1, MinWords=10, MaxWords=35, StartSel="", StopSel=""') AS excerpt,
              ts_rank_cd(ci.search_vector, to_tsquery('english', $1), 32)
                + CASE WHEN $2::text IS NULL THEN 0 ELSE 0.5 * ts_rank_cd(ci.search_vector, to_tsquery('english', $2), 32) END
                + CASE WHEN ci.search_vector @@ to_tsquery('english', $5) THEN 1 ELSE 0 END
                + CASE WHEN ci.source = 'note' THEN 0.05 ELSE 0 END AS score
         FROM content_items ci
        WHERE ci.source = ANY($3::text[])
          AND ci.search_vector @@ to_tsquery('english', $1)
        ORDER BY score DESC
        LIMIT $4`,
      [focusQ, contextQ, Object.keys(SOURCE_KIND), PER_SOURCE_LIMIT, allQ],
    );
    for (const r of rows.rows) {
      const kind = SOURCE_KIND[r.source] ?? 'document';
      // Notes are placed by their note id (opens in Think); everything else by content item id.
      const refType: RefType = kind === 'note' ? 'note' : kind === 'article' ? 'discover_item' : 'content_item';
      const refId = kind === 'note' ? r.source_id : r.id;
      if (onMap.has(refId)) continue;
      results.push({
        kind, refType, refId, title: r.title, excerpt: r.excerpt.slice(0, EXCERPT_CHARS),
        date: r.published_at, url: r.url, via: 'search', score: Number(r.score),
      });
    }

    const chats = await db.query<{ id: string; title: string | null; updated_at: string; excerpt: string | null; score: number }>(
      `SELECT s.id::text, s.title, s.updated_at,
              (SELECT left(m.content, 300) FROM ai_chat_messages m
                WHERE m.session_id = s.id AND to_tsvector('english', m.content) @@ to_tsquery('english', $1)
                ORDER BY m.created_at DESC LIMIT 1) AS excerpt,
              LEAST((SELECT COUNT(*) FROM ai_chat_messages m
                WHERE m.session_id = s.id AND to_tsvector('english', m.content) @@ to_tsquery('english', $1)), 4)::float
                + CASE WHEN EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id
                    AND to_tsvector('english', m.content) @@ to_tsquery('english', $3)) THEN 10 ELSE 0 END AS score
         FROM ai_chat_sessions s
        WHERE EXISTS (SELECT 1 FROM ai_chat_messages m
                       WHERE m.session_id = s.id AND to_tsvector('english', m.content) @@ to_tsquery('english', $1))
        ORDER BY score DESC, s.updated_at DESC
        LIMIT $2`,
      [focusQ, CHAT_LIMIT, allQ],
    );
    for (const c of chats.rows) {
      if (onMap.has(c.id)) continue;
      results.push({
        kind: 'chat', refType: 'ai_session', refId: c.id, title: c.title ?? 'Athena chat',
        excerpt: (c.excerpt ?? '').replace(/\s+/g, ' ').slice(0, EXCERPT_CHARS), date: c.updated_at, url: null,
        via: 'search', score: CHAT_SCORE_PER_MESSAGE * c.score,
      });
    }
  }

  // Knowledge-graph neighbours of a linked note/document.
  const graphRef = node.refType === 'note' ? 'note' : node.refType === 'content_item' ? 'document' : null;
  if (graphRef !== null && node.refId !== null) {
    const neighbours = await db.query<{ ref_id: string; ref_type: string; title: string; confidence: number }>(
      `SELECT n2.ref_id, n2.ref_type, n2.title, e.confidence
         FROM nodes n1
         JOIN edges e ON e.source_node_id = n1.id OR e.target_node_id = n1.id
         JOIN nodes n2 ON n2.id = CASE WHEN e.source_node_id = n1.id THEN e.target_node_id ELSE e.source_node_id END
        WHERE n1.ref_id = $1 AND n1.ref_type = $2 AND n2.ref_type IN ('note', 'document')
        ORDER BY e.confidence DESC
        LIMIT $3`,
      [node.refId, graphRef, GRAPH_NEIGHBOURS],
    );
    for (const g of neighbours.rows) {
      if (onMap.has(g.ref_id) || results.some((r) => r.refId === g.ref_id)) continue;
      results.push({
        kind: g.ref_type === 'note' ? 'note' : 'document', refType: g.ref_type === 'note' ? 'note' : 'content_item',
        refId: g.ref_id, title: g.title, excerpt: 'Connected in the knowledge graph', date: null, url: null,
        via: 'graph', score: Number(g.confidence),
      });
    }
  }

  const seen = new Set<string>();
  return results
    .sort((a, b) => b.score - a.score)
    .filter((r) => { const k = `${r.refType}:${r.refId}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX_SUGGESTIONS)
    .map(({ score: _score, ...s }) => s);
}
