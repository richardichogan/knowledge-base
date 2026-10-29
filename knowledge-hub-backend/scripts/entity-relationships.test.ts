import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { addRelationship, listRelationships, relationshipScope, removeRelationship } from '../src/services/entityRelationships.js';

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

test('relationship scopes reject unsupported types and non-diagram element scopes', () => {
  assert.throws(() => relationshipScope('document', id(1)));
  assert.throws(() => relationshipScope('task', id(1), id(2)));
  assert.throws(() => relationshipScope('diagram', id(1), 'invalid'));
  assert.deepEqual(relationshipScope('diagram', id(1), id(2)), { type: 'diagram', id: id(1), elementId: id(2) });
});

test('manual links are reciprocal, canonical, scoped and preserve legacy links and note content', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT,status TEXT DEFAULT 'active',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE sparks(id UUID PRIMARY KEY,body TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE canvases(id UUID PRIMARY KEY,title TEXT,canvas_type TEXT,deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,lifecycle_state TEXT DEFAULT 'active',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tasks(id UUID PRIMARY KEY,title TEXT,archived BOOLEAN DEFAULT false,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE use_cases(id UUID PRIMARY KEY,title TEXT,stage TEXT DEFAULT 'candidate',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE people(id UUID PRIMARY KEY,name TEXT,organisation TEXT,emails TEXT[],updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE companies(id UUID PRIMARY KEY,name TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE content_items(id UUID PRIMARY KEY,title TEXT,source TEXT,url TEXT,published_at TIMESTAMPTZ,indexed_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE canvas_diagrams(canvas_id UUID PRIMARY KEY,revision INTEGER,document JSONB);
    CREATE TABLE task_links(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),task_id UUID,target_type TEXT,target_id TEXT,target_title TEXT,target_url TEXT,
      UNIQUE(task_id,target_type,target_id));
    CREATE TABLE canvas_notes(canvas_id UUID,note_id TEXT,UNIQUE(canvas_id,note_id));
    CREATE TABLE diagram_element_notes(canvas_id UUID,element_id UUID,note_id TEXT,UNIQUE(canvas_id,element_id,note_id));
  `);
  await db.exec(await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8'));
  const migration = await readFile(new URL('../src/db/migrations/118_entity_manual_links.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const original = JSON.stringify({ title: 'Source note', contentJson: '[]' });
  await db.query('INSERT INTO notes(id,content) VALUES ($1,$2),($3,$4)',
    [id(1), original, id(2), JSON.stringify({ title: 'Other note', contentJson: '[]' })]);
  await db.query("INSERT INTO tasks(id,title) VALUES ($1,'Task one'),($2,'Task two')", [id(3), id(4)]);
  await db.query("INSERT INTO canvases(id,title,canvas_type) VALUES ($1,'Process','diagram')", [id(5)]);
  await db.query('INSERT INTO canvas_diagrams VALUES($1,1,$2)', [id(5), JSON.stringify({
    nodes: [{ id: id(6), label: 'First step' }, { id: id(7), label: 'Second step' }], edges: [],
  })]);
  await db.query('INSERT INTO canvas_notes VALUES ($1,$2)', [id(5), id(1)]);
  await db.query('INSERT INTO diagram_element_notes VALUES ($1,$2,$3)', [id(5), id(6), id(1)]);
  const query = mock.method(getDb(), 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  const note = { type: 'note', id: id(1) } as const;
  const otherNote = { type: 'note', id: id(2) } as const;
  const task = { type: 'task', id: id(3) } as const;
  const diagram = { type: 'diagram', id: id(5) } as const;
  const shape = { ...diagram, elementId: id(6) };
  try {
    const inherited = await listRelationships(note);
    assert.equal(inherited.length, 2, 'whole-diagram and shape links remain distinct');
    assert.equal(inherited.find(link => link.elementId)?.elementTitle, 'First step');
    assert.equal((await listRelationships(shape))[0]?.id, note.id);

    await addRelationship(note, otherNote);
    await addRelationship(otherNote, note);
    const back = (await listRelationships(otherNote))[0]!;
    assert.equal(back.id, note.id);
    assert.equal((await db.query('SELECT * FROM entity_manual_links')).rows.length, 1, 'inverse creation is idempotent');
    await removeRelationship(otherNote, back.key);
    assert.equal((await listRelationships(note)).some(link => link.id === otherNote.id), false);
    assert.equal((await db.query<{ content: string }>('SELECT content FROM notes WHERE id=$1', [note.id])).rows[0]?.content, original);

    await addRelationship(diagram, task);
    await addRelationship(shape, task);
    await addRelationship({ ...diagram, elementId: id(7) }, task);
    const taskLinks = await listRelationships(task);
    assert.equal(taskLinks.length, 3, 'diagram and individual shapes can each link the same task');
    assert.deepEqual(new Set(taskLinks.map(link => link.elementId)), new Set(['', id(6), id(7)]));
    await removeRelationship(task, taskLinks.find(link => link.elementId === id(6))!.key);
    assert.equal((await listRelationships(shape)).some(link => link.type === 'task'), false);
    assert.equal((await listRelationships(diagram)).some(link => link.type === 'task'), true);

    await addRelationship(task, { type: 'task', id: id(4) });
    assert.equal((await listRelationships({ type: 'task', id: id(4) }))[0]?.id, task.id);
    await assert.rejects(() => addRelationship(note, note));
    await assert.rejects(() => addRelationship({ ...diagram, elementId: id(99) }, task));
    await assert.rejects(() => removeRelationship(otherNote, taskLinks[0]!.key), 'cannot unlink an unrelated item');
  } finally {
    query.mock.restore();
    await db.close();
  }
});
