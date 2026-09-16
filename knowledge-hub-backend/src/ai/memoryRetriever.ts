import type { Pool } from 'pg';
import { MEMORY_ITEMS_LIMIT } from '../config/constants.js';
import { isLowSignalMessage } from './ragRetriever.js';

export interface MemoryItem {
  sessionId: string;
  sessionTitle: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/** Same stopword set used by the FTS OR-fallback in db/queries.ts, kept local so this module has no coupling to it. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'will', 'would',
  'should', 'may', 'might', 'must', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'and', 'or', 'but', 'not', 'so', 'if', 'as', 'like', 'sure', 'ok', 'okay',
]);

function toOrQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => w.replace(/[^\w]/g, ''))
    .filter((w) => w !== '' && !STOPWORDS.has(w.toLowerCase()))
    .join(' | ');
}

/**
 * Retrieves the single most relevant message from each of up to
 * MEMORY_ITEMS_LIMIT OTHER chat sessions, so Athena can cross-reference
 * things discussed in earlier, separate conversations — not just the
 * current session's own history (which is already replayed in full/summary
 * form) and not just the "official" knowledge base library (handled
 * separately by ragRetriever.ts).
 *
 * One snippet per session (via DISTINCT ON) so a single long-running thread
 * can't dominate every slot at the expense of genuine cross-conversation
 * recall.
 */
export async function retrieveCrossSessionMemory(
  db: Pool,
  query: string,
  currentSessionId: string,
): Promise<MemoryItem[]> {
  if (!query.trim() || isLowSignalMessage(query)) {
    return [];
  }

  const andResult = await db.query<{
    session_id: string;
    title: string | null;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (m.session_id)
              m.session_id, s.title, m.role, m.content, m.created_at,
              ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', $1)) AS rank
         FROM ai_chat_messages m
         JOIN ai_chat_sessions s ON s.id = m.session_id
        WHERE m.session_id != $2
          AND to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
        ORDER BY m.session_id, rank DESC
     ) sub
     ORDER BY rank DESC
     LIMIT $3`,
    [query, currentSessionId, MEMORY_ITEMS_LIMIT],
  );

  const rows = andResult.rows.length > 0 ? andResult.rows : await fallbackOrSearch(db, query, currentSessionId);

  return rows.map((r) => ({
    sessionId: r.session_id,
    sessionTitle: r.title ?? 'Untitled conversation',
    role: r.role,
    content: r.content,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Same AND-then-OR fallback pattern as getRagItems — a multi-word phrase otherwise misses rows containing only some of the words. */
async function fallbackOrSearch(
  db: Pool,
  query: string,
  currentSessionId: string,
): Promise<{ session_id: string; title: string | null; role: 'user' | 'assistant'; content: string; created_at: string }[]> {
  const orQuery = toOrQuery(query);
  if (orQuery === '') return [];

  const result = await db.query<{
    session_id: string;
    title: string | null;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (m.session_id)
              m.session_id, s.title, m.role, m.content, m.created_at,
              ts_rank(to_tsvector('english', m.content), to_tsquery('english', $1)) AS rank
         FROM ai_chat_messages m
         JOIN ai_chat_sessions s ON s.id = m.session_id
        WHERE m.session_id != $2
          AND to_tsvector('english', m.content) @@ to_tsquery('english', $1)
        ORDER BY m.session_id, rank DESC
     ) sub
     ORDER BY rank DESC
     LIMIT $3`,
    [orQuery, currentSessionId, MEMORY_ITEMS_LIMIT],
  );
  return result.rows;
}

/**
 * Formats cross-session memory items into a text block for injection into
 * the system prompt. Explicitly labelled as auto-retrieved, past-conversation
 * recall — never something the user just said or pasted in THIS message.
 */
export function formatMemoryContext(items: MemoryItem[]): string {
  if (items.length === 0) {
    return '';
  }

  const lines = items.map((item, index) => {
    const date = new Date(item.createdAt).toISOString().substring(0, 10);
    return [
      `[${index + 1}] From an earlier, separate conversation ("${item.sessionTitle}", ${date}):`,
      `${item.role === 'user' ? 'Richard said' : 'You (Athena) replied'}: ${item.content.substring(0, 500)}${item.content.length > 500 ? '...' : ''}`,
    ].join('\n');
  });

  return [
    '## Relevant memory from past conversations (system-generated, NOT part of this message)',
    'This is a best-effort full-text search match against OTHER chat sessions, run automatically for ' +
      'every message, so you can cross-reference what was discussed previously — the same way you already ' +
      'cross-reference the knowledge base library. It may be irrelevant to the current message — use it ' +
      'only if it genuinely helps. Never claim the user just said this, and never refer to it as ' +
      '"snippets" or "retrieved context" in your reply — if you use it, refer to it naturally (e.g. "as we ' +
      'discussed before" or "you mentioned earlier").',
    '',
    lines.join('\n\n---\n\n'),
  ].join('\n');
}
