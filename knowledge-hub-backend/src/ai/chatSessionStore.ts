/**
 * chatSessionStore.ts — Postgres-backed AI chat session/history persistence.
 *
 * Replaces the old in-memory `Map` in routes/ai.ts, which lost every
 * conversation on backend restart or redeploy. Athena's standalone chat
 * window is meant to be a daily-driver surface, so history now survives
 * restarts and can be restored by the frontend after a page reload.
 */

import type { Pool } from 'pg';
import type { ConversationMessage } from '../types/aiContext.js';

export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Ensures a session row exists, then returns its current message history. */
export async function getOrCreateSessionHistory(db: Pool, sessionId: string): Promise<StoredChatMessage[]> {
  await db.query(
    `INSERT INTO ai_chat_sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [sessionId],
  );
  return getSessionHistory(db, sessionId);
}

/** Reads a session's message history in chronological order. Empty array if the session doesn't exist. */
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
