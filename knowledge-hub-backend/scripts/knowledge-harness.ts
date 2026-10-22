import type { PGlite } from '@electric-sql/pglite';
import { mock } from 'node:test';
import type { Pool } from 'pg';
import { FoundryClient, type LlmMessage, type LlmToolChoice, type LlmToolDefinition } from '../src/ai/foundryClient.js';
import { phase2Db } from './knowledge-phase2-fixture.js';
import { SESSION } from './knowledge-fixtures.js';

const WRITE_STATEMENT = /^\s*(?:insert|update|delete|create|alter|drop|truncate|merge|copy|grant|revoke|call|do|vacuum|lock)\b|^\s*with\b[\s\S]*\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;

export interface RecordingPool {
  pool: Pool;
  statements: string[];
  writes: string[];
  failedReads: string[];
}

/**
 * Wraps PGlite as a Pool. Writes are recorded and refused (never executed); reads against tables the
 * fixture does not model return no rows, so conversation plumbing runs without a full schema.
 */
export function recordingPool(db: PGlite): RecordingPool {
  const statements: string[] = [];
  const writes: string[] = [];
  const failedReads: string[] = [];
  const query = async (arg: string | { text: string; values?: unknown[] }, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const text = typeof arg === 'string' ? arg : arg.text;
    const values = typeof arg === 'string' ? params : arg.values;
    statements.push(text);
    if (WRITE_STATEMENT.test(text)) {
      writes.push(text);
      return { rows: [], rowCount: 0 };
    }
    try {
      const result = await db.query(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rows.length };
    } catch {
      failedReads.push(text);
      return { rows: [], rowCount: 0 };
    }
  };
  return { pool: { query } as unknown as Pool, statements, writes, failedReads };
}

/** Content plus the native tables the reader and conversation context touch, on top of the real indexing migration. */
export async function harnessDb(): Promise<PGlite> {
  const db = await phase2Db();
  await db.exec(`
    ALTER TABLE tasks ADD COLUMN body TEXT NOT NULL DEFAULT '', ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-10-01T00:00:00Z';
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '', lifecycle_state TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE notes (id UUID PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', project_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-10-01', updated_at TIMESTAMPTZ NOT NULL DEFAULT '2026-10-02');
    CREATE TABLE nodes (id UUID PRIMARY KEY, ref_id TEXT NOT NULL, ref_type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE kb_images (id UUID PRIMARY KEY, vision_analysis TEXT NOT NULL DEFAULT '');
    CREATE TABLE ai_chat_sessions (id UUID PRIMARY KEY, excluded_sources JSONB NOT NULL DEFAULT '[]');
    CREATE TABLE chat_outputs (id UUID PRIMARY KEY, session_id UUID NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'document');
    CREATE TABLE chat_output_versions (output_id UUID NOT NULL, version INT NOT NULL, content TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'athena',
      note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-10-03', PRIMARY KEY (output_id, version));
    CREATE TABLE tags (id UUID PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '');
    CREATE TABLE task_tags (task_id TEXT NOT NULL, tag_id UUID NOT NULL);
    CREATE TABLE athena_memories (kind TEXT, content TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now());
    INSERT INTO athena_memories VALUES ('profile', 'seeded so no legacy import write occurs', 'archived');
    INSERT INTO ai_chat_sessions (id) VALUES ('${SESSION}');
  `);
  return db;
}

/** Order-independent fingerprint of every row of every public table. */
export async function snapshotAllTables(db: PGlite): Promise<string> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const parts: string[] = [];
  for (const { table_name: name } of tables.rows) {
    const rows = await db.query<{ r: string }>(`SELECT t::text AS r FROM "${name}" t ORDER BY 1`);
    parts.push(`${name}:${JSON.stringify(rows.rows.map((row) => row.r))}`);
  }
  return parts.join('\n');
}

export interface ScriptedCall { name: string; args: Record<string, unknown> }
export interface ModelRound { messages: LlmMessage[]; tools: LlmToolDefinition[]; toolChoice: LlmToolChoice }
export type ModelStep = (round: ModelRound, index: number) => ScriptedCall[] | string;

/** Replaces the chat model with a script; returns every request it received. */
export function scriptModel(step: ModelStep): { rounds: ModelRound[]; restore: () => void; callCount: () => number } {
  const rounds: ModelRound[] = [];
  const completion = mock.method(FoundryClient.prototype, 'chatWithTools',
    async (_model: unknown, messages: LlmMessage[], tools: LlmToolDefinition[], _max: unknown, toolChoice: LlmToolChoice) => {
      const round = { messages: messages.map((m) => ({ ...m })) as LlmMessage[], tools, toolChoice };
      rounds.push(round);
      const out = step(round, rounds.length - 1);
      if (typeof out === 'string') return { content: out, toolCalls: [], finishReason: 'stop' };
      return {
        content: '', finishReason: 'tool_calls',
        toolCalls: out.map((c, n) => ({ id: `call-${rounds.length.toString()}-${n.toString()}`, type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      };
    });
  return { rounds, restore: () => { completion.mock.restore(); }, callCount: () => completion.mock.callCount() };
}

export const toolResults = (round: ModelRound): unknown[] =>
  round.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)) as unknown);

export const requestText = (round: ModelRound): string =>
  round.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
