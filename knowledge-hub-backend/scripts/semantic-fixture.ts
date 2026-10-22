import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { SemanticContext } from '../src/services/semantic/types.js';

/** Pinned clock: 22 Oct 2026 09:00 UTC (10:00 BST), Europe/London. */
export const NOW = new Date('2026-10-22T09:00:00Z');
export const ctx = (extra: Partial<SemanticContext> = {}): SemanticContext => ({ now: NOW, ...extra });

export const P1 = 'p-imagine';
export const P2 = 'p-other';
export const S1 = '00000000-0000-4000-8000-0000000000a1';
export const SD1 = '00000000-0000-4000-8000-0000000000d1';
export const SD2 = '00000000-0000-4000-8000-0000000000d2';
export const SD3 = '00000000-0000-4000-8000-0000000000d3';
export const N1 = '00000000-0000-4000-8000-0000000000b1';
export const D1 = '00000000-0000-4000-8000-0000000000c1';
export const C1 = '00000000-0000-4000-8000-0000000000c2';
export const R1 = '00000000-0000-4000-8000-0000000000e1';
export const N1_REF = { kind: 'source', id: `note:${N1}` } as const;

export interface Fixture { raw: PGlite; db: Pool }

/** PGlite reports affectedRows; the app's pg Pool reports rowCount. */
export function asPool(raw: PGlite): Pool {
  return {
    query: async (text: string, params?: unknown[]) => {
      const result = await raw.query(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  } as unknown as Pool;
}

async function run(raw: PGlite, file: string): Promise<void> {
  await raw.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
}

export async function fixtureDb(): Promise<Fixture> {
  const raw = new PGlite();
  await raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', lifecycle_state TEXT NOT NULL DEFAULT 'active',
      expected_outputs JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE ai_chat_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL DEFAULT '', project_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', project_id TEXT, priority TEXT NOT NULL DEFAULT 'medium',
      due_date DATE, waiting_on TEXT, archived BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', revision INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE content_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source TEXT NOT NULL DEFAULT 'document', title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '', published_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), project_context TEXT);
  `);
  for (const file of ['043_chat_outputs_decisions.sql', '068_project_register.sql', '090_decision_semantics.sql']) await run(raw, file);
  const q = (text: string, params: unknown[] = []): Promise<unknown> => raw.query(text, params);
  await q(`INSERT INTO projects (id, name, goal) VALUES ($1,'Imagine','Claims automation'), ($2,'Other','')`, [P1, P2]);
  await q(`INSERT INTO ai_chat_sessions (id, title, project_id) VALUES ($1,'Gate chat',$2)`, [S1, P1]);
  await q(`INSERT INTO notes (id, content) VALUES ($1,'Human approval remains required for claims over GBP 25,000')`, [N1]);
  await q(`INSERT INTO content_items (id, title, summary, published_at) VALUES
    ($1,'Manual approval threshold is GBP 50,000','Approval policy update','2026-10-15T10:00:00Z'),
    ($2,'Approve > GBP 50,000','Diagram: approval flow','2026-10-16T10:00:00Z')`, [D1, C1]);
  await q(`INSERT INTO tasks (id, title, status, project_id, due_date, archived) VALUES
    ('t1','Review approval threshold','blocked',$1,'2026-10-21',false),
    ('t2','Done thing','completed',$1,'2026-10-01',false),
    ('t3','Archived thing','backlog',$1,'2026-10-01',true),
    ('t4','Other project task','in-progress',$2,'2026-10-30',false)`, [P1, P2]);
  await q(`INSERT INTO chat_decisions (id, session_id, status, text, source, created_at, accepted_at, acceptance_origin, review_date) VALUES
    ($1,$4,'decided','Review, but do not remove, the approval gate','user','2026-10-01T10:00:00Z','2026-10-02T10:00:00Z','user_confirmed','2026-10-21'),
    ($2,$4,'decided','Maybe remove the gate','auto','2026-10-10T10:00:00Z',NULL,NULL,NULL),
    ($3,$4,'decided','Replace the gate with a GBP 50,000 threshold','user','2026-10-20T10:00:00Z','2026-10-20T11:00:00Z','user_confirmed',NULL)`, [SD1, SD2, SD3, S1]);
  await q(`INSERT INTO project_register_items (id, project_id, kind, title, source_type, source_id, task_id) VALUES ($1,$2,'risk','Gate review slips','chat_decision',$3,'t1')`, [R1, P1, SD1]);
  const edge = (rel: string, fk: string, fid: string, tk: string, tid: string, origin: string, eff: string | null): Promise<unknown> =>
    q(`INSERT INTO semantic_edges (relationship, from_kind, from_id, to_kind, to_id, origin, effective_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [rel, fk, fid, tk, tid, origin, eff]);
  await edge('supported_by', 'decision', SD1, 'source', `note:${N1}`, 'explicit', null);
  await edge('implements', 'task', 't1', 'decision', SD1, 'explicit', null);
  await edge('implements', 'task', 't2', 'decision', SD1, 'user_confirmed', null);
  await edge('implements', 'task', 't3', 'decision', SD1, 'explicit', null);
  await edge('implements', 'task', 't4', 'decision', SD1, 'inferred', null);
  await edge('supersedes', 'decision', SD2, 'decision', SD1, 'explicit', '2026-10-11T00:00:00Z');
  await edge('supersedes', 'decision', SD3, 'decision', SD1, 'user_confirmed', '2026-10-23T00:00:00Z');
  return { raw, db: asPool(raw) };
}
