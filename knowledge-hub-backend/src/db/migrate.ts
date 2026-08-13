import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Runs the schema.sql and any numbered migrations/*.sql files that haven't
 * been applied yet.  Uses a simple applied_migrations table to track state.
 * Exported so it can also be called once on server startup (idempotent —
 * every statement is IF NOT EXISTS / tracked), not just via `npm run migrate`.
 */
export async function runMigrations(): Promise<void> {
  const db = getDb();

  // 1. Base schema (idempotent CREATE TABLE IF NOT EXISTS statements)
  const schemaPath = join(__dirname, 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  console.warn('Running base schema...');
  await db.query(schemaSql);

  // 2. Ensure tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // 3. Run numbered migration files in order
  const migrationsDir = join(__dirname, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await db.query<{ filename: string }>(
      'SELECT filename FROM applied_migrations WHERE filename = $1',
      [file],
    );
    if (rows.length > 0) {
      console.warn(`  skip  ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.warn(`  apply ${file}`);
    await db.query(sql);
    await db.query('INSERT INTO applied_migrations (filename) VALUES ($1)', [file]);
  }

  console.warn('Migration complete.');
}

// Only run as a standalone CLI script (npm run migrate) when this module is
// the entry point — not when imported by server.ts on startup.
if (process.argv[1] === __filename) {
  runMigrations()
    .then(async () => {
      await closeDb();
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
