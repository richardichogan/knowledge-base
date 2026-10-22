import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

/**
 * Applies schema.sql and src/db/migrations/*.sql to an isolated database. Reads ONLY PERF_DATABASE_URL
 * (never .env) and refuses anything that is not a loopback host, so production can never be targeted.
 */
export async function migrateIsolated(url: string): Promise<number> {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error(`Refusing non-loopback host ${host}`);
  const root = resolve(import.meta.dirname, '..', 'src', 'db');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(readFileSync(join(root, 'schema.sql'), 'utf-8'));
    await client.query('CREATE TABLE IF NOT EXISTS applied_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const files = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if ((await client.query('SELECT 1 FROM applied_migrations WHERE filename=$1', [f])).rowCount) continue;
      await client.query('BEGIN');
      try {
        // Migration 078 updates content_items.workflow_state, and relevance_explanation, which no repo migration creates (pre-existing gap).
        if (f.startsWith('078_')) await client.query(`ALTER TABLE content_items ADD COLUMN IF NOT EXISTS workflow_state TEXT, ADD COLUMN IF NOT EXISTS relevance_explanation TEXT`);
        if (f.startsWith('080_')) await client.query('CREATE TABLE IF NOT EXISTS content_item_tags (content_item_id UUID NOT NULL, tag_id UUID NOT NULL, PRIMARY KEY (content_item_id, tag_id)); CREATE TABLE IF NOT EXISTS cfp_item_tags (cfp_item_id UUID NOT NULL, tag_id UUID NOT NULL, PRIMARY KEY (cfp_item_id, tag_id))');
        await client.query(readFileSync(join(root, 'migrations', f), 'utf-8'));
        await client.query('INSERT INTO applied_migrations (filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw new Error(`${f}: ${e instanceof Error ? e.message : e}`); }
    }
    return files.length;
  } finally { client.release(); await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const url = process.env.PERF_DATABASE_URL;
  if (!url) { console.error('PERF_DATABASE_URL required'); process.exitCode = 2; }
  else migrateIsolated(url).then((n) => console.log(`applied schema + ${n} migrations`), (e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
