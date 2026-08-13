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
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface StoredChatMessageRow extends StoredChatMessage {
  id: number;
}

export interface SessionListItem {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  preview: string;
  persona: string;
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

/** Reads a session's full message history in chronological order — used for display, not for the model call. */
export async function getSessionHistory(db: Pool, sessionId: string): Promise<StoredChatMessage[]> {
  const { rows } = await db.query<{ role: 'user' | 'assistant'; content: string; created_at: string }>(
    `SELECT role, content, created_at FROM ai_chat_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
  return rows.map((r) => ({ role: r.role, content: r.content, timestamp: r.created_at }));
}

/** Appends a user/assistant message pair and bumps the session's updated_at. */
export async function appendTurn(
  db: Pool,
  sessionId: string,
  userMessage: string,
  assistantReply: string,
): Promise<void> {
  await db.query(
    `INSERT INTO ai_chat_messages (session_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
    [sessionId, userMessage, assistantReply],
  );
  await db.query(`UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
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

/** Lists sessions for the chat history sidebar, most recently active first. */
export async function listSessions(db: Pool, limit = 50): Promise<SessionListItem[]> {
  const { rows } = await db.query<{
    id: string;
    title: string | null;
    started_at: string;
    updated_at: string;
    preview: string | null;
    persona: string;
  }>(
    `SELECT s.id, s.title, s.started_at, s.updated_at, s.persona,
            (SELECT content FROM ai_chat_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS preview
       FROM ai_chat_sessions s
      WHERE EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)
      ORDER BY s.updated_at DESC
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
  }));
}

/** Deletes a session and all of its messages (ON DELETE CASCADE handles the messages). */
export async function deleteSession(db: Pool, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM ai_chat_sessions WHERE id = $1`, [sessionId]);
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
