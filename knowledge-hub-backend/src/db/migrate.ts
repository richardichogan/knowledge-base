import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './db.js';
import type { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Runs the schema.sql and any numbered migrations/*.sql files that haven't
 * been applied yet. SQL and tracking commit together under a session lock.
 * Exported so it can also be called once on server startup (idempotent —
 * every statement is IF NOT EXISTS / tracked), not just via `npm run migrate`.
 */
export async function applyMigrations(db: Pool, schemaSql: string, migrations: { filename: string; sql: string }[]): Promise<void> {
  const client = await db.connect();
  let locked = false;
  let discard = false;
  try {
    await client.query('SELECT pg_advisory_lock(741903, 1)');
    locked = true;
    await client.query('BEGIN');
    try {
      await client.query(schemaSql);
      await client.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
        filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    for (const { filename, sql } of migrations) {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query('SELECT filename FROM applied_migrations WHERE filename = $1', [filename]);
        if (rows.length === 0) {
          console.warn(`  apply ${filename}`);
          await client.query(sql);
          await client.query('INSERT INTO applied_migrations (filename) VALUES ($1)', [filename]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } catch (error) {
    discard = true;
    throw error;
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(741903, 1)'); }
      catch (error) { discard = true; console.error('[Migrations] Could not release advisory lock:', error); }
    }
    client.release(discard);
  }
}

export async function runMigrations(): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  const migrationsDir = join(__dirname, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  await applyMigrations(getDb(), schemaSql, files.map(filename => ({
    filename, sql: readFileSync(join(migrationsDir, filename), 'utf-8'),
  })));
  console.warn('Migration complete.');
}

// Only run as a standalone CLI script (npm run migrate) when this module is
// the entry point — not when imported by server.ts on startup.
if (process.argv[1] === __filename) {
  const { assertSafeDatabase } = await import('../runtime.js');
  const { env } = await import('../config/env.js');
  assertSafeDatabase(env.DATABASE_MODE, env.DATABASE_URL, env.NODE_ENV);
  runMigrations()
    .then(async () => {
      await closeDb();
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
