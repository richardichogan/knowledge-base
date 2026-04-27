/**
 * scripts/run-taxonomy-migration.ts
 * Run: node --import tsx/esm scripts/run-taxonomy-migration.ts
 *
 * 1. Creates taxonomy tables from 005_taxonomy.sql
 * 2. Seeds parent tags
 * 3. Migrates notes.project_id → note_tags
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/knowledgehub';

const SEED_TAGS: { name: string; colour: string }[] = [
  { name: 'Podcast',         colour: '#8a3ffc' },
  { name: 'Newsletter',      colour: '#0f62fe' },
  { name: 'Blog',            colour: '#198038' },
  { name: 'Structara AI',    colour: '#6929c4' },
  { name: 'ATOM',            colour: '#005d5d' },
  { name: 'Imagine',         colour: '#9f1853' },
  { name: 'IBM',             colour: '#0043ce' },
  { name: 'AI',              colour: '#ff832b' },
  { name: 'Azure',           colour: '#0072c6' },
  { name: 'Architecture',    colour: '#007d79' },
  { name: 'Microsoft 365',   colour: '#d12771' },
];

function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function run(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('[taxonomy-migration] Connected to database');

  // 1. Run DDL
  const sql = readFileSync(resolve(__dirname, '../src/db/migrations/005_taxonomy.sql'), 'utf8');
  await client.query(sql);
  console.log('[taxonomy-migration] DDL applied');

  // 2. Seed parent tags (upsert on slug)
  const tagIdBySlug = new Map<string, string>();

  for (const tag of SEED_TAGS) {
    const slug = toSlug(tag.name);
    const res = await client.query<{ id: string }>(
      `INSERT INTO tags (name, slug, colour)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, colour = EXCLUDED.colour
       RETURNING id`,
      [tag.name, slug, tag.colour],
    );
    tagIdBySlug.set(slug, res.rows[0]!.id);
  }
  console.log(`[taxonomy-migration] Seeded ${SEED_TAGS.length} parent tags`);

  // 3. Migrate notes.project_id → note_tags
  const notesWithProject = await client.query<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM notes WHERE project_id IS NOT NULL`,
  );

  let migrated = 0;
  for (const note of notesWithProject.rows) {
    const projectSlug = toSlug(note.project_id);
    // Check if a tag exists for this project
    let tagId = tagIdBySlug.get(projectSlug);

    if (tagId === undefined) {
      // Create a new parent tag for unknown project
      const res = await client.query<{ id: string }>(
        `INSERT INTO tags (name, slug)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [note.project_id, projectSlug],
      );
      tagId = res.rows[0]!.id;
      tagIdBySlug.set(projectSlug, tagId);
    }

    await client.query(
      `INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [note.id, tagId],
    );
    migrated++;
  }
  console.log(`[taxonomy-migration] Migrated ${migrated} note project assignments to note_tags`);

  await client.end();
  console.log('[taxonomy-migration] Done');
}

run().catch((err) => {
  console.error('[taxonomy-migration] FAILED:', err);
  process.exit(1);
});
