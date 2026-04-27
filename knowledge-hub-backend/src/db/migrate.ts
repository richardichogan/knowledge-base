import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Runs the schema.sql migration against the configured PostgreSQL database.
 * Safe to run multiple times — all statements use IF NOT EXISTS.
 */
async function migrate(): Promise<void> {
  const db = getDb();
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');

  console.warn('Running database migration...');
  await db.query(sql);
  console.warn('Migration complete.');
  await db.end();
}

migrate().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
