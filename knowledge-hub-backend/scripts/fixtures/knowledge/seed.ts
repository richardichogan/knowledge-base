import { CORPUS, EDGES, noisyMatches, unrelatedRecords, type CorpusRecord } from './corpus.js';
import { FIXTURE_PROJECTS, PINNED_NOW_ISO } from './constants.js';
import { MINIMAL_FIXTURES } from './familyFixtures.js';

/** The subset of PGlite / pg that the seeder needs. */
export interface FixtureDb {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface SeedOptions {
  /** Add the 30 noisy lexical matches (SRC-01/05/06). */
  noise?: boolean;
  /** Add N unrelated notes (CTX-01 uses 1,000). */
  unrelated?: number;
  /** Add one minimal fixture per manifest family and per ContentSource. */
  minimal?: boolean;
}

/**
 * Fixture-private tables (kf_ prefix) so seeding never collides with application migrations
 * or another agent's schema work. Idempotent: safe to call repeatedly on the same database.
 */
export const FIXTURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kf_projects (
  id TEXT PRIMARY KEY, uuid UUID NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL,
  goal TEXT NOT NULL, target_date DATE NOT NULL
);
CREATE TABLE IF NOT EXISTS kf_records (
  id UUID PRIMARY KEY, alias TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, source TEXT,
  project_id TEXT, title TEXT NOT NULL, path TEXT, body TEXT NOT NULL, state TEXT,
  provenance TEXT NOT NULL, role TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, imported_at TIMESTAMPTZ,
  deleted BOOLEAN NOT NULL DEFAULT FALSE, meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  stale_indexed_copy JSONB, raw_metadata TEXT
);
CREATE INDEX IF NOT EXISTS kf_records_kind_idx ON kf_records(kind, project_id);
CREATE INDEX IF NOT EXISTS kf_records_title_idx ON kf_records(lower(title));
CREATE TABLE IF NOT EXISTS kf_edges (
  id UUID PRIMARY KEY, from_alias TEXT NOT NULL, to_alias TEXT NOT NULL, type TEXT NOT NULL,
  provenance TEXT NOT NULL, confidence REAL
);
CREATE TABLE IF NOT EXISTS kf_clock (id INTEGER PRIMARY KEY CHECK (id = 1), now TIMESTAMPTZ NOT NULL, timezone TEXT NOT NULL);
`;

export async function createFixtureSchema(db: FixtureDb): Promise<void> {
  await db.exec(FIXTURE_SCHEMA_SQL);
}

async function insertRecord(db: FixtureDb, r: CorpusRecord): Promise<void> {
  await db.query(
    `INSERT INTO kf_records (id, alias, kind, source, project_id, title, path, body, state, provenance, role, version,
       created_at, updated_at, imported_at, deleted, meta, stale_indexed_copy, raw_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19)
     ON CONFLICT (id) DO NOTHING`,
    [r.id, r.alias, r.kind, r.source ?? null, r.projectId, r.title, r.path ?? null, r.text, r.state ?? null, r.provenance, r.role,
      r.version ?? 1, r.createdAt, r.updatedAt, r.importedAt ?? null, r.deleted ?? false, JSON.stringify(r.meta ?? {}),
      r.staleIndexedCopy ? JSON.stringify(r.staleIndexedCopy) : null, r.excludedField?.value ?? null],
  );
}

export async function seedKnowledgeFixtures(db: FixtureDb, options: SeedOptions = {}): Promise<{ records: number; edges: number }> {
  await createFixtureSchema(db);
  await db.query(`INSERT INTO kf_clock (id, now, timezone) VALUES (1, $1, 'Europe/London') ON CONFLICT (id) DO NOTHING`, [PINNED_NOW_ISO]);
  for (const p of FIXTURE_PROJECTS) {
    await db.query(
      `INSERT INTO kf_projects (id, uuid, name, visibility, goal, target_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.uuid, p.name, p.visibility, p.goal, p.targetDate],
    );
  }
  const records: CorpusRecord[] = [...CORPUS];
  if (options.noise) records.push(...noisyMatches());
  if (options.unrelated) records.push(...unrelatedRecords(options.unrelated));
  if (options.minimal) records.push(...MINIMAL_FIXTURES.map((f) => f.record));
  for (const r of records) await insertRecord(db, r);
  for (const e of EDGES) {
    await db.query(
      `INSERT INTO kf_edges (id, from_alias, to_alias, type, provenance, confidence) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [e.id, e.from, e.to, e.type, e.provenance, e.confidence ?? null],
    );
  }
  return { records: records.length, edges: EDGES.length };
}
