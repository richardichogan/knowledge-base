import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';

export const SESSION = '00000000-0000-4000-8000-0000000000a1';
export const OTHER_SESSION = '00000000-0000-4000-8000-0000000000a2';
export const NOTE_A = '10000000-0000-4000-8000-000000000001';
export const NOTE_B = '10000000-0000-4000-8000-000000000002';
export const MIRROR_A = '20000000-0000-4000-8000-000000000001';
export const NODE_A = '30000000-0000-4000-8000-000000000001';
export const ITEM_DOC = '20000000-0000-4000-8000-000000000002';
export const NODE_DOC = '30000000-0000-4000-8000-000000000002';
export const NODE_DANGLING = '30000000-0000-4000-8000-000000000009';

export const asPool = (db: PGlite): Pool => db as unknown as Pool;

export function noteContent(title: string, paragraphs: string[], extra: unknown[] = []): string {
  const blocks = [
    ...paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }], children: [] })),
    ...extra,
  ];
  return JSON.stringify({ title, contentType: 'note', contentJson: JSON.stringify(blocks) });
}

export async function knowledgeFixture(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '', lifecycle_state TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'normal', project_id TEXT, due_date DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-03-01', updated_at TIMESTAMPTZ NOT NULL DEFAULT '2026-03-02');
    CREATE TABLE notes (id UUID PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', project_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-03-01', updated_at TIMESTAMPTZ NOT NULL DEFAULT '2026-03-02');
    CREATE TABLE content_items (id UUID PRIMARY KEY, source TEXT NOT NULL, source_id TEXT, title TEXT NOT NULL, summary TEXT, body TEXT,
      published_at TIMESTAMPTZ, url TEXT, project_context TEXT NOT NULL DEFAULT 'personal', metadata JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT '2026-03-02');
    CREATE TABLE nodes (id UUID PRIMARY KEY, ref_id TEXT NOT NULL, ref_type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE kb_images (id UUID PRIMARY KEY, vision_analysis TEXT NOT NULL DEFAULT '');
    CREATE TABLE ai_chat_sessions (id UUID PRIMARY KEY, excluded_sources JSONB NOT NULL DEFAULT '[]');
    CREATE TABLE chat_outputs (id UUID PRIMARY KEY, session_id UUID NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'document');
    CREATE TABLE chat_output_versions (output_id UUID NOT NULL, version INT NOT NULL, content TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'athena',
      note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-03-03', PRIMARY KEY (output_id, version));
    INSERT INTO ai_chat_sessions (id) VALUES ('${SESSION}'), ('${OTHER_SESSION}');
  `);
  return db;
}

export async function addNote(db: PGlite, id: string, title: string, paragraphs: string[], projectId: string | null = null): Promise<void> {
  await db.query(`INSERT INTO notes (id, content, project_id) VALUES ($1, $2, $3)`, [id, noteContent(title, paragraphs), projectId]);
}

export async function excludeInSession(db: PGlite, sessionId: string, ...ids: string[]): Promise<void> {
  await db.query(`UPDATE ai_chat_sessions SET excluded_sources = $2::jsonb WHERE id = $1`,
    [sessionId, JSON.stringify(ids.map((id) => ({ id, kind: 'note', title: 'hidden title', url: '' })))]);
}
