import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PROJECT_TYPES } from '../src/services/projectTypes.js';

const migration = readFileSync(new URL('../src/db/migrations/130_project_work_types.sql', import.meta.url), 'utf8');
// Migration 130's five types; later migrations (141) extend the current PROJECT_TYPES list.
const MIGRATION_130_TYPES = ['project', 'bau', 'aspiration', 'exploration', 'side-project'] as const;

test('work type migration preserves content, maps both legacy types and accepts only the five approved types', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, description TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW(),
        project_type TEXT NOT NULL DEFAULT 'standard' CHECK (project_type IN ('standard','formal-client'))
      );
      INSERT INTO projects (id, description, project_type) VALUES
        ('practice', 'Ongoing practice description', 'standard'),
        ('client', 'Client description', 'formal-client');
    `);
    await db.exec(migration);
    assert.deepEqual((await db.query('SELECT id, description, project_type FROM projects ORDER BY id')).rows, [
      { id: 'client', description: 'Client description', project_type: 'project' },
      { id: 'practice', description: 'Ongoing practice description', project_type: 'project' },
    ]);
    assert.ok(MIGRATION_130_TYPES.every(type => (PROJECT_TYPES as readonly string[]).includes(type)));
    for (const type of MIGRATION_130_TYPES) {
      await db.query('INSERT INTO projects (id, description, project_type) VALUES ($1, $2, $1)', [type, 'Preserved']);
    }
    await db.exec(migration);
    assert.deepEqual((await db.query("SELECT project_type FROM projects WHERE description = 'Preserved' ORDER BY project_type")).rows.map(row => row['project_type']),
      [...MIGRATION_130_TYPES].sort());
    await db.exec("INSERT INTO projects (id, description) VALUES ('default', 'Default type')");
    assert.equal((await db.query("SELECT project_type FROM projects WHERE id = 'default'")).rows[0]?.['project_type'], 'project');
    for (const type of ['standard', 'formal-client', 'invalid']) {
      await assert.rejects(db.query("UPDATE projects SET project_type = $1 WHERE id = 'practice'", [type]), /check constraint/);
    }
  } finally {
    await db.close();
  }
});
