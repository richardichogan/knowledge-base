import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { AdmittedQuery } from '../src/services/knowledge/admission.js';

export const PINNED_NOW = new Date('2026-10-22T09:00:00Z');

/** Minimal content_items/tasks schema plus the real 089 migration. */
export async function phase2Db(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE content_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source TEXT NOT NULL, source_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ NOT NULL DEFAULT '2026-10-01T00:00:00Z', indexed_at TIMESTAMPTZ NOT NULL DEFAULT '2026-10-21T00:00:00Z',
      url TEXT, project_context TEXT NOT NULL DEFAULT 'personal', metadata JSONB NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), foundry_indexed_at TIMESTAMPTZ,
      search_vector TSVECTOR, UNIQUE (source, source_id));
    CREATE OR REPLACE FUNCTION content_items_sv() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A')
        || setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'B') || setweight(to_tsvector('english', coalesce(NEW.body, '')), 'C');
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER content_items_sv_trg BEFORE INSERT OR UPDATE ON content_items FOR EACH ROW EXECUTE FUNCTION content_items_sv();
    CREATE TABLE note_github_publications (repo TEXT, path TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', project_id TEXT,
      priority TEXT, due_date DATE, archived BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT '2026-10-01T00:00:00Z');
  `);
  await db.exec(await readFile(new URL('../src/db/migrations/089_knowledge_indexing_work.sql', import.meta.url), 'utf8'));
  return db;
}

export const asQuery = (db: PGlite): AdmittedQuery => db as unknown as AdmittedQuery;

export async function insertContent(
  db: PGlite, o: { source?: string; sourceId: string; title?: string; summary?: string; body?: string; project?: string;
    metadata?: Record<string, unknown>; publishedAt?: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO content_items (source, source_id, title, summary, body, project_context, metadata, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, '2026-10-01T00:00:00Z')) RETURNING id::text AS id`,
    [o.source ?? 'note', o.sourceId, o.title ?? '', o.summary ?? '', o.body ?? '', o.project ?? 'personal',
      JSON.stringify(o.metadata ?? {}), o.publishedAt ?? null]);
  return rows[0]!.id;
}
