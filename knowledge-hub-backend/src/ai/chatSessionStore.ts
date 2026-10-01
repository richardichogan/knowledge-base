/**
 * chatSessionStore.ts — Postgres-backed AI chat session/history persistence.
 *
 * Replaces the old in-memory `Map` in routes/ai.ts, which lost every
 * conversation on backend restart or redeploy. Athena's standalone chat
 * window is meant to be a daily-driver surface, so history now survives
 * restarts and can be restored by the frontend after a page reload.
 *
 * Also backs the chat history sidebar (multiple named sessions, like a
 * ChatGPT/Claude sidebar) and rolling mid-conversation summarisation, so a
 * long-running session doesn't replay unbounded history — and cost — to the
 * model on every turn.
 */

import type { Pool } from 'pg';
import {
  AI_ROLLING_SUMMARY_TRIGGER_MESSAGES,
  AI_ROLLING_SUMMARY_KEEP_TAIL,
  AI_SESSION_TITLE_MAX_LENGTH,
} from '../config/constants.js';
import type { ConversationMessage } from '../types/aiContext.js';

export interface StoredChatMessage {
  /** Row id (as text) — lets the UI refer to a reply (e.g. "Ask another model"). */
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Persona that produced an assistant reply (null for user turns / older rows). */
  persona?: string;
  /** Tool names the reply drew on, e.g. ['list_tasks'] (assistant turns only). */
  sources?: string[];
}

interface StoredChatMessageRow extends Omit<StoredChatMessage, 'id'> {
  id: number;
}

export interface SessionListItem {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  preview: string;
  persona: string;
  projectId: string | null;
  pinned: boolean;
}

/** Ensures a session row exists, then returns its current message history. */
export async function getOrCreateSessionHistory(db: Pool, sessionId: string): Promise<StoredChatMessage[]> {
  await db.query(
    `INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [sessionId],
  );
  return getSessionHistory(db, sessionId);
}

/** Reads a session's current persona ("general" by default). */
export async function getSessionPersona(db: Pool, sessionId: string): Promise<string> {
  const { rows } = await db.query<{ persona: string }>(
    `SELECT persona FROM ai_chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.persona ?? 'general';
}

/** Sets a session's persona — an explicit user action (e.g. switching to "brainstorming"), never inferred. */
export async function setSessionPersona(db: Pool, sessionId: string, persona: string): Promise<void> {
  await db.query(
    `INSERT INTO ai_chat_sessions (id, persona) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET persona = EXCLUDED.persona`,
    [sessionId, persona],
  );
}

/** Reads the project associated with a session, if one has been assigned. */
export async function getSessionProjectId(db: Pool, sessionId: string): Promise<string | null> {
  const { rows } = await db.query<{ project_id: string | null }>(
    `SELECT project_id FROM ai_chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.project_id ?? null;
}

/** Assigns or clears a session's project. */
export async function setSessionProjectId(db: Pool, sessionId: string, projectId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO ai_chat_sessions (id, project_id) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id`,
    [sessionId, projectId],
  );
}

/** Reads a session's full message history in chronological order — used for display, not for the model call. */
export async function getSessionHistory(db: Pool, sessionId: string): Promise<StoredChatMessage[]> {
  const { rows } = await db.query<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
    persona: string | null;
    sources: string[] | null;
  }>(
    `SELECT id::text, role, content, created_at, persona, sources FROM ai_chat_messages
      WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    timestamp: r.created_at,
    ...(r.persona !== null && { persona: r.persona }),
    ...(r.sources !== null && r.sources.length > 0 && { sources: r.sources }),
  }));
}

/** Appends a user/assistant message pair and bumps the session's updated_at. */
export async function appendTurn(
  db: Pool,
  sessionId: string,
  userMessage: string,
  assistantReply: string,
  replyMeta: { persona?: string; sources?: string[] } = {},
): Promise<{ assistantMessageId: string }> {
  const { rows } = await db.query<{ id: string; role: string }>(
    `INSERT INTO ai_chat_messages (session_id, role, content, persona, sources)
       VALUES ($1, 'user', $2, NULL, NULL), ($1, 'assistant', $3, $4, $5)
     RETURNING id::text, role`,
    [sessionId, userMessage, assistantReply, replyMeta.persona ?? null, replyMeta.sources ?? null],
  );
  await db.query(`UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
  return { assistantMessageId: rows.find((r) => r.role === 'assistant')?.id ?? '' };
}

/**
 * For re-answering one of Athena's replies: the user message it answered,
 * the conversation before that (most recent turns), and the reply's persona.
 */
export async function getTurnForAlternate(
  db: Pool,
  sessionId: string,
  assistantMessageId: string,
): Promise<{ userMessage: string; history: ConversationMessage[]; persona: string } | null> {
  const { rows } = await db.query<{ id: string; role: 'user' | 'assistant'; content: string; persona: string | null }>(
    `SELECT id::text, role, content, persona FROM ai_chat_messages
      WHERE session_id = $1 AND id <= $2 ORDER BY created_at ASC, id ASC`,
    [sessionId, assistantMessageId],
  );
  const last = rows[rows.length - 1];
  const user = rows[rows.length - 2];
  if (last?.id !== assistantMessageId || last.role !== 'assistant' || user?.role !== 'user') return null;
  const history = rows.slice(Math.max(0, rows.length - 2 - 20), rows.length - 2).map((r) => ({ role: r.role, content: r.content }));
  return { userMessage: user.content.replace(/^\[Viewing [^\]]*\]\n/, ''), history, persona: last.persona ?? 'general' };
}

/** Replaces a stored message's text (an alternative answer chosen with "Use this one"). */
export async function replaceMessageContent(db: Pool, messageId: string, content: string): Promise<void> {
  await db.query(`UPDATE ai_chat_messages SET content = $2 WHERE id = $1`, [messageId, content]);
}

/** Converts stored history into the plain {role, content} shape the LLM/conversation service expects. */
export function toConversationMessages(history: StoredChatMessage[]): ConversationMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Sets a session's sidebar title from its first user message, if it doesn't
 * already have one. Cheap truncation, not an LLM call — matches the ChatGPT/
 * Claude default-title pattern without spending a completion on it.
 */
export async function setSessionTitleIfMissing(db: Pool, sessionId: string, firstUserMessage: string): Promise<void> {
  const trimmed = firstUserMessage.trim();
  const title = trimmed.length > AI_SESSION_TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, AI_SESSION_TITLE_MAX_LENGTH).trimEnd()}…`
    : trimmed;
  await db.query(
    `UPDATE ai_chat_sessions SET title = $2 WHERE id = $1 AND title IS NULL`,
    [sessionId, title],
  );
}

/**
 * Replaces an automatic title with an AI-generated one — unless the user has
 * renamed the chat themselves (title_locked), which always wins.
 */
export async function setGeneratedSessionTitle(db: Pool, sessionId: string, title: string): Promise<void> {
  const clean = title.trim().replace(/^["'“”]+|["'“”.]+$/g, '').slice(0, AI_SESSION_TITLE_MAX_LENGTH);
  if (clean === '') return;
  await db.query(
    `UPDATE ai_chat_sessions SET title = $2 WHERE id = $1 AND title_locked = FALSE`,
    [sessionId, clean],
  );
}

/** User rename — locks the title so automatic titling never overwrites it. */
export async function renameSession(db: Pool, sessionId: string, title: string): Promise<void> {
  await db.query(
    `UPDATE ai_chat_sessions SET title = $2, title_locked = TRUE WHERE id = $1`,
    [sessionId, title.trim().slice(0, AI_SESSION_TITLE_MAX_LENGTH)],
  );
}

/** Pins or unpins a chat in the sidebar. */
export async function setSessionPinned(db: Pool, sessionId: string, pinned: boolean): Promise<void> {
  await db.query(`UPDATE ai_chat_sessions SET pinned = $2 WHERE id = $1`, [sessionId, pinned]);
}

/** Number of user turns in a session — used to decide when to (re)generate a title. */
export async function countUserTurns(db: Pool, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ai_chat_messages WHERE session_id = $1 AND role = 'user'`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Sidebar search: ids of sessions whose title or any message matches the
 * query (message text uses the existing idx_ai_chat_messages_fts index).
 */
export async function searchSessionIds(db: Pool, query: string, limit = 50): Promise<string[]> {
  const q = query.trim();
  if (q === '') return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id
       FROM ai_chat_sessions s
      WHERE s.title ILIKE '%' || $1 || '%'
         OR EXISTS (
              SELECT 1 FROM ai_chat_messages m
               WHERE m.session_id = s.id
                 AND (to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
                      OR m.content ILIKE '%' || $1 || '%')
            )
      ORDER BY s.updated_at DESC
      LIMIT $2`,
    [q, limit],
  );
  return rows.map((r) => r.id);
}

/** Lists sessions for the chat history sidebar: pinned first, then most recently active. */
export async function listSessions(db: Pool, limit = 50): Promise<SessionListItem[]> {
  const { rows } = await db.query<{
    id: string;
    title: string | null;
    started_at: string;
    updated_at: string;
    preview: string | null;
    persona: string;
    project_id: string | null;
    pinned: boolean;
  }>(
    `SELECT s.id, s.title, s.started_at, s.updated_at, s.persona, s.project_id, s.pinned,
            (SELECT content FROM ai_chat_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS preview
       FROM ai_chat_sessions s
      WHERE EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)
      ORDER BY s.pinned DESC, s.updated_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? 'New chat',
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    preview: (r.preview ?? '').slice(0, 140),
    persona: r.persona,
    projectId: r.project_id,
    pinned: r.pinned,
  }));
}

/** Deletes a session and all of its messages (ON DELETE CASCADE handles the messages). */
export async function deleteSession(db: Pool, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM ai_chat_sessions WHERE id = $1`, [sessionId]);
}

/**
 * Finds the chat session already linked to a note, if any. Used by the
 * Think-embedded Athena panel to restore the right conversation when the
 * user switches notes, instead of always showing whatever session happens
 * to be globally active.
 */
export async function getSessionIdForNote(db: Pool, noteId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ai_chat_sessions WHERE note_id = $1`,
    [noteId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Links a session to a note. A note has at most one linked session at a
 * time, so any prior session linked to this note is unlinked first — this
 * is what makes "start a new chat while viewing this note" replace the
 * note's remembered conversation rather than conflicting with the unique
 * index on note_id.
 */
export async function linkSessionToNote(db: Pool, sessionId: string, noteId: string): Promise<void> {
  await db.query(`UPDATE ai_chat_sessions SET note_id = NULL WHERE note_id = $1 AND id != $2`, [noteId, sessionId]);
  await db.query(
    `INSERT INTO ai_chat_sessions (id, note_id) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET note_id = EXCLUDED.note_id`,
    [sessionId, noteId],
  );
}

/**
 * Builds the conversation history to send to the model: the rolling summary
 * (if one exists) as a leading system-role message, followed by every
 * message since the last summarisation point, verbatim. This is what keeps
 * a long-running session from replaying its entire history — and cost — on
 * every single turn.
 */
export async function getModelHistory(db: Pool, sessionId: string): Promise<ConversationMessage[]> {
  const { rows: sessionRows } = await db.query<{ summary: string | null; summarized_through_id: number }>(
    `SELECT summary, summarized_through_id FROM ai_chat_sessions WHERE id = $1`,
    [sessionId],
  );
  const session = sessionRows[0];
  const summarizedThroughId = session?.summarized_through_id ?? 0;

  const { rows: recentRows } = await db.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM ai_chat_messages WHERE session_id = $1 AND id > $2 ORDER BY created_at ASC, id ASC`,
    [sessionId, summarizedThroughId],
  );

  const recent: ConversationMessage[] = recentRows.map((r) => ({ role: r.role, content: r.content }));

  if (session?.summary != null && session.summary.trim() !== '') {
    return [
      { role: 'system', content: `Earlier in this conversation (summarised for brevity): ${session.summary}` },
      ...recent,
    ];
  }
  return recent;
}

/**
 * If a session has accumulated more unsummarized messages than the trigger
 * threshold, folds the oldest overflow batch into (or alongside) the
 * existing rolling summary via the provided summariser, keeping the most
 * recent AI_ROLLING_SUMMARY_KEEP_TAIL messages verbatim. No-op otherwise.
 * The full raw history in ai_chat_messages is never deleted — this only
 * changes what gets replayed to the model on future turns.
 */
export async function rollUpSummaryIfNeeded(
  db: Pool,
  sessionId: string,
  summarise: (previousSummary: string | null, batch: StoredChatMessage[]) => Promise<string>,
): Promise<void> {
  const { rows: sessionRows } = await db.query<{ summary: string | null; summarized_through_id: number }>(
    `SELECT summary, summarized_through_id FROM ai_chat_sessions WHERE id = $1`,
    [sessionId],
  );
  const session = sessionRows[0];
  if (session === undefined) return;

  const { rows: unsummarized } = await db.query<StoredChatMessageRow & { created_at: string }>(
    `SELECT id, role, content, created_at FROM ai_chat_messages
      WHERE session_id = $1 AND id > $2 ORDER BY created_at ASC, id ASC`,
    [sessionId, session.summarized_through_id],
  );

  if (unsummarized.length <= AI_ROLLING_SUMMARY_TRIGGER_MESSAGES) return;

  const overflow = unsummarized.slice(0, unsummarized.length - AI_ROLLING_SUMMARY_KEEP_TAIL);
  if (overflow.length === 0) return;

  const batch: StoredChatMessage[] = overflow.map((m) => ({ role: m.role, content: m.content, timestamp: m.created_at }));
  const updatedSummary = await summarise(session.summary, batch);
  const newSummarizedThroughId = overflow[overflow.length - 1]?.id ?? session.summarized_through_id;

  await db.query(
    `UPDATE ai_chat_sessions SET summary = $2, summarized_through_id = $3 WHERE id = $1`,
    [sessionId, updatedSummary, newSummarizedThroughId],
  );
}

/** A chat turn that was running on the server when last recorded (see 042_chat_pending_turn.sql). */
export interface PendingTurn {
  turnId: string;
  message: string;
  startedAt: string;
}

/** Records (or clears, with null) the turn currently running for a session. */
export async function setPendingTurn(db: Pool, sessionId: string, turn: PendingTurn | null): Promise<void> {
  if (turn === null) {
    // UPDATE, not upsert: clearing must not recreate a chat deleted mid-turn.
    await db.query(`UPDATE ai_chat_sessions SET pending_turn = NULL WHERE id = $1`, [sessionId]);
    return;
  }
  await db.query(
    `INSERT INTO ai_chat_sessions (id, pending_turn) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET pending_turn = EXCLUDED.pending_turn`,
    [sessionId, JSON.stringify(turn)],
  );
}

export async function getPendingTurn(db: Pool, sessionId: string): Promise<PendingTurn | null> {
  const { rows } = await db.query<{ pending_turn: PendingTurn | null }>(
    `SELECT pending_turn FROM ai_chat_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.pending_turn ?? null;
}
