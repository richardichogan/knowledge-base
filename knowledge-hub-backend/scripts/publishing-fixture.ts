import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

export async function addPublishingSchema(pg: PGlite): Promise<void> {
  await pg.exec(readFileSync(new URL('../src/db/migrations/100_discover_publishing.sql', import.meta.url), 'utf8'));
  await pg.exec(`CREATE TABLE IF NOT EXISTS content_items(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),title TEXT NOT NULL,body TEXT DEFAULT '',url TEXT,source TEXT,
    metadata JSONB DEFAULT '{}',workflow_state TEXT,published_at TIMESTAMPTZ DEFAULT NOW(),
    indexed_at TIMESTAMPTZ DEFAULT NOW(),relevance_score DOUBLE PRECISION);
  `);
}
export async function publishingFixture(): Promise<{ pg: PGlite; db: Pool; close: () => Promise<void> }> {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL('../src/db/migrations/099_managed_jobs.sql', import.meta.url), 'utf8'));
  await addPublishingSchema(pg);
  let queue = Promise.resolve();
  async function acquire(): Promise<() => void> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
  const raw = async (sql: string, values?: unknown[]) => {
    if (/pg_advisory_(?:xact_)?lock|pg_advisory_unlock|pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    const result = await pg.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const db = {
    query: async (sql: string, values?: unknown[]) => { const release = await acquire(); try { return await raw(sql, values); } finally { release(); } },
    connect: async () => {
      let unlock: (() => void) | undefined;
      return {
        query: async (sql: string, values?: unknown[]) => {
          if (sql === 'BEGIN') { unlock = await acquire(); return raw(sql, values); }
          if (unlock) {
            try { return await raw(sql, values); } finally { if (sql === 'COMMIT' || sql === 'ROLLBACK') { unlock(); unlock = undefined; } }
          }
          const release = await acquire(); try { return await raw(sql, values); } finally { release(); }
        },
        release: () => { unlock?.(); unlock = undefined; },
      };
    },
  } as unknown as Pool;
  return { pg, db, close: () => pg.close() };
}
