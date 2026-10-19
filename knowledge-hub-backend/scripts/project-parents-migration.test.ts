import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = readFileSync(new URL('../src/db/migrations/084_project_parents.sql', import.meta.url), 'utf8');

async function seed(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, category TEXT, updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE tags (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      colour TEXT, role TEXT NOT NULL, parent_id UUID REFERENCES tags(id) ON DELETE RESTRICT,
      project_id TEXT REFERENCES projects(id), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE note_tags (note_id TEXT, tag_id UUID REFERENCES tags(id) ON DELETE CASCADE, source TEXT, PRIMARY KEY (note_id, tag_id));
    CREATE TABLE discover_item_tags (discover_item_id TEXT, tag_id UUID REFERENCES tags(id) ON DELETE CASCADE, is_primary BOOL, source TEXT, PRIMARY KEY (discover_item_id, tag_id));
    CREATE TABLE document_tags (doc_id TEXT, tag_id UUID REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (doc_id, tag_id));
    CREATE TABLE task_tags (task_id TEXT, tag_id UUID REFERENCES tags(id) ON DELETE CASCADE, source TEXT, PRIMARY KEY (task_id, tag_id));
    CREATE TABLE content_item_tags (content_item_id TEXT, tag_id UUID REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (content_item_id, tag_id));
    CREATE TABLE cfp_item_tags (cfp_item_id TEXT, tag_id UUID REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (cfp_item_id, tag_id));
    CREATE TABLE tag_rejections (content_kind TEXT, content_id TEXT, tag_id UUID REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (content_kind, content_id, tag_id));
    CREATE TABLE tasks (id TEXT PRIMARY KEY, linked_tag_id UUID REFERENCES tags(id));
    CREATE TABLE pending_tag_suggestions (id SERIAL, merged_to_id UUID REFERENCES tags(id));
    CREATE TABLE repo_tag_mappings (id SERIAL, tag_id UUID REFERENCES tags(id));
    CREATE TABLE repo_project_mappings (id SERIAL, project_tag_id UUID REFERENCES tags(id));

    INSERT INTO tags (name, slug, role) VALUES
      ('IBM Projects', 'ibm-projects', 'filing'), ('Eminence', 'eminence', 'filing'),
      ('Independent Ventures', 'independent-ventures', 'filing'), ('Nelfin', 'nelfin', 'filing'),
      ('Content and Eminence', 'content-and-eminence', 'concept');
    INSERT INTO projects VALUES
      ('imagine', 'IMAGINE', 'work'), ('cloudy', 'Cloudy with a Chance of Insights', 'work'),
      ('blog-site', 'Blog Site', 'personal'), ('structara-ai', 'Structara AI', 'side-hustle'),
      ('modelair', 'ModelAIr', 'side-hustle'), ('knowledge-hub', 'Knowledge Hub', 'side-hustle'),
      ('auto-queue-app', 'Auto Queue App', 'side-hustle'), ('content-pipeline', 'Content Pipeline', 'side-hustle'),
      ('healthwise', 'Healthwise', 'side-hustle'), ('personal', 'Personal', 'work');
    INSERT INTO tags (name, slug, role, project_id, parent_id) VALUES
      ('IMAGINE', 'imagine', 'filing', 'imagine', (SELECT id FROM tags WHERE slug = 'ibm-projects')),
      ('Cloudy', 'cloudy', 'filing', 'cloudy', (SELECT id FROM tags WHERE slug = 'eminence')),
      ('Blog Site', 'blog-site', 'filing', 'blog-site', (SELECT id FROM tags WHERE slug = 'eminence')),
      ('Structara AI', 'structara-ai', 'filing', 'structara-ai', (SELECT id FROM tags WHERE slug = 'independent-ventures')),
      ('Healthwise', 'healthwise', 'filing', 'healthwise', (SELECT id FROM tags WHERE slug = 'nelfin')),
      ('Personal', 'personal', 'filing', 'personal', NULL);
    INSERT INTO tags (name, slug, role, project_id, parent_id)
      SELECT name, id, 'filing', id, (SELECT id FROM tags WHERE slug = 'independent-ventures')
        FROM projects WHERE id IN ('modelair', 'knowledge-hub', 'auto-queue-app', 'content-pipeline');
    INSERT INTO note_tags VALUES
      ('eminence-note', (SELECT id FROM tags WHERE slug = 'eminence'), 'manual'),
      ('ibm-note', (SELECT id FROM tags WHERE slug = 'ibm-projects'), 'manual');
    INSERT INTO task_tags VALUES ('venture-task', (SELECT id FROM tags WHERE slug = 'independent-ventures'), 'manual');
  `);
  return db;
}

async function migrate(db: PGlite): Promise<void> {
  await db.exec('BEGIN');
  await db.exec(MIGRATION);
  await db.exec('COMMIT');
}

test('migration 084 files every project under IBM, Nelfin or Personal and is safe to re-run', async () => {
  const db = await seed();
  await migrate(db);
  await migrate(db);

  const groups = await db.query<{ name: string }>(
    `SELECT name FROM tags WHERE role = 'filing' AND parent_id IS NULL AND project_id IS NULL ORDER BY name`,
  );
  assert.deepEqual(groups.rows.map((row) => row.name), ['IBM', 'Nelfin', 'Personal']);

  const placement = await db.query<{ id: string; name: string; category: string; parent: string }>(`
    SELECT p.id, p.name, p.category, g.name AS parent
      FROM projects p JOIN tags t ON t.project_id = p.id JOIN tags g ON g.id = t.parent_id
     ORDER BY p.id`);
  assert.deepEqual(placement.rows, [
    { id: 'auto-queue-app', name: 'Auto Queue App', category: 'personal', parent: 'Personal' },
    { id: 'blog-site', name: 'Blog Site', category: 'personal', parent: 'Personal' },
    { id: 'cloudy', name: 'Cloudy with a Chance of Insights', category: 'work', parent: 'IBM' },
    { id: 'content-pipeline', name: 'Content Pipeline', category: 'personal', parent: 'Personal' },
    { id: 'healthwise', name: 'Healthwise', category: 'side-hustle', parent: 'Nelfin' },
    { id: 'imagine', name: 'IMAGINE', category: 'work', parent: 'IBM' },
    { id: 'knowledge-hub', name: 'Knowledge Hub', category: 'personal', parent: 'Personal' },
    { id: 'modelair', name: 'ModelAIr', category: 'personal', parent: 'Personal' },
    { id: 'personal', name: 'General', category: 'personal', parent: 'Personal' },
    { id: 'structara-ai', name: 'Structara AI', category: 'personal', parent: 'Personal' },
  ]);
  await db.close();
});

test('migration 084 keeps content that was tagged with a retired group', async () => {
  const db = await seed();
  await migrate(db);

  const notes = await db.query<{ note_id: string; name: string }>(
    `SELECT x.note_id, t.name FROM note_tags x JOIN tags t ON t.id = x.tag_id ORDER BY x.note_id`,
  );
  assert.deepEqual(notes.rows, [
    { note_id: 'eminence-note', name: 'Content and Eminence' },
    { note_id: 'ibm-note', name: 'IBM' },
  ]);
  const tasks = await db.query<{ name: string }>(`SELECT t.name FROM task_tags x JOIN tags t ON t.id = x.tag_id`);
  assert.deepEqual(tasks.rows, [{ name: 'Personal' }]);
  await db.close();
});
