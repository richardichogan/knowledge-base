import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Runs the schema.sql and any numbered migrations/*.sql files that haven't
 * been applied yet.  Uses a simple applied_migrations table to track state.
 */
async function migrate(): Promise<void> {
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
  await db.end();
}

migrate().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
