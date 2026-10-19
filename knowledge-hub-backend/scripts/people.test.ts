import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, mock } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { getPerson, importPeople, listPeople, savePerson, validatePerson } from '../src/services/people.js';
import { buildPeopleContext } from '../src/services/peopleContext.js';
import { peopleRouter } from '../src/routes/people.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { findLinkTargets, entityBacklinks, linkPreview, resolveNoteLinks } from '../src/services/noteLinks.js';

const personInput = { name: 'Example Person', emails: ['Example@Example.com'], organisation: 'Example Org',
  role: 'Manager', notes: 'Personal context', threads: 'Planning', source: 'Email report', sourcePeriod: '1-14 October 2026',
  contactGroup: 'Regular', emailCount: 3 };

test('people validate names, text, emails and frequency without coercing invalid input', () => {
  assert.deepEqual(validatePerson({ name: 'Example', emails: ['A@example.com', 'a@example.com'] }).emails, ['a@example.com']);
  for (const bad of [null, [], { name: 42 }, { name: '' }, { name: 'x', emails: ['bad address'] },
    { name: 'x', emailCount: -1 }, { name: 'x', emailCount: '2' }, { name: 'x', notes: 'x'.repeat(10001) }]) {
    assert.throws(() => validatePerson(bad));
  }
});

test('seed migration loads the contact report once, with aliases, without overwriting existing people', async () => {
  const db = new PGlite();
  await db.exec('CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT,status TEXT DEFAULT \'active\',updated_at TIMESTAMPTZ DEFAULT NOW());');
  const sql = async (filename: string) => db.exec(await readFile(new URL(`../src/db/migrations/${filename}`, import.meta.url), 'utf8'));
  for (const filename of ['064_note_list_metadata.sql', '082_note_links.sql', '085_people.sql']) await sql(filename);
  await db.query(`INSERT INTO people(id,name,emails,notes) VALUES (gen_random_uuid(),'Miha Kralj',ARRAY['miha.kralj@ibm.com'],'Hand-written note')`);
  await sql('086_people_seed.sql');
  await sql('086_people_seed.sql');
  const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM people');
  assert.equal(count.rows[0]?.n, 40);
  const miha = await db.query<{ notes: string }>(`SELECT notes FROM people WHERE name='Miha Kralj'`);
  assert.deepEqual(miha.rows, [{ notes: 'Hand-written note' }], 'existing person kept, not duplicated');
  const pool = getDb();
  const query = mock.method(pool, 'query', (text: string, args?: unknown[]) => db.query(text, args));
  try {
    const [chad] = await listPeople(pool, 'chad.thomas@neudesic.com');
    assert.equal(chad?.name, 'Chad Thomas');
    assert.deepEqual(chad?.emails, ['chad.thomas@ibm.com', 'chad.thomas@neudesic.com']);
    assert.equal(chad?.organisation, 'IBM / Neudesic');
    assert.equal(chad?.emailCount, 12);
    const [chris] = await listPeople(pool, 'Chris McGuire');
    assert.equal(chris?.role, 'your manager');
    assert.equal(chris?.sourcePeriod, '5 – 19 October 2026');
    assert.equal((await listPeople(pool, 'anya.keating@reckitt.com'))[0]?.name, 'Anya Keating');
    assert.equal((await listPeople(pool, 'Celonis'))[0]?.name, 'Jonathan Elwyn');
  } finally { query.mock.restore(); }
});

test('persistent people CRUD/import, alias lookup, note mentions, backlinks, previews and chat grounding', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT,status TEXT DEFAULT 'active',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE sparks(id UUID PRIMARY KEY,body TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE canvases(id UUID PRIMARY KEY,title TEXT,canvas_type TEXT,deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,lifecycle_state TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tasks(id UUID PRIMARY KEY,title TEXT,archived BOOLEAN,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE use_cases(id UUID PRIMARY KEY,title TEXT,stage TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE content_items(id UUID PRIMARY KEY,title TEXT,url TEXT,source TEXT,published_at TIMESTAMPTZ,indexed_at TIMESTAMPTZ);
  `);
  for (const filename of ['064_note_list_metadata.sql', '082_note_links.sql', '085_people.sql', '085_people.sql']) {
    await db.exec(await readFile(new URL(`../src/db/migrations/${filename}`, import.meta.url), 'utf8'));
  }
  const pool = getDb();
  const query = mock.method(pool, 'query', (sql: string, args?: unknown[]) => db.query(sql, args));
  const connect = mock.method(pool, 'connect', async () => ({
    query: (sql: string, args?: unknown[]) => db.query(sql, args), release: () => {},
  }));
  const app = express(); app.use(express.json()); app.use('/people', peopleRouter); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => { server.once('listening', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/people`;
  try {
    const created = await savePerson(pool, personInput);
    assert.equal(created.name, personInput.name);
    assert.deepEqual(created.emails, ['example@example.com']);
    assert.equal((await getPerson(pool, created.id)).id, created.id);
    await assert.rejects(savePerson(pool, { ...personInput, name: 'Duplicate' }), /already belongs/);
    const imported = { ...personInput, emails: ['example@example.com', 'alias@example.org'], emailCount: 5, notes: '' };
    assert.deepEqual(await importPeople(pool, [imported]), { created: 0, updated: 1 });
    assert.deepEqual(await importPeople(pool, [imported]), { created: 0, updated: 1 });
    const current = await getPerson(pool, created.id);
    assert.equal(current.emailCount, 5, 'reimport does not double email counts');
    assert.equal(current.notes, 'Personal context', 'import preserves hand-edited notes');
    assert.equal((await listPeople(pool, 'alias@example.org'))[0]?.id, created.id);
    assert.equal((await listPeople(pool, '%')).length, 0, 'literal wildcard search');
    const found = await findLinkTargets(pool, 'alias@example.org');
    assert.equal(found[0]?.type, 'person');
    assert.equal(found[0]?.href, `/people?personId=${created.id}`);
    const preview = await linkPreview(pool, 'person', created.id);
    assert.ok(preview.details.some(detail => detail.value.includes('alias@example.org')));
    const noteId = '00000000-0000-4000-8000-000000000001';
    const content = JSON.stringify({ title: 'Working note', contentJson: JSON.stringify([
      { type: 'paragraph', content: [{ type: 'entityMention', props: { entityType: 'person', entityId: created.id } }] },
    ]) });
    await db.query('INSERT INTO notes(id,content) VALUES($1,$2)', [noteId, content]);
    assert.equal((await db.query('SELECT * FROM note_entity_links')).rows.length, 1);
    assert.equal((await entityBacklinks(pool, 'person', created.id, 0)).items[0]?.id, noteId);
    await savePerson(pool, { ...current, name: 'Renamed Person' }, created.id);
    assert.match(JSON.stringify(await resolveNoteLinks(pool, content)), /Renamed Person/);
    const token = `Ask @[Example Person](/people?personId=${created.id}) about planning`;
    const grounding = await buildPeopleContext(pool, [token]);
    assert.match(grounding, /Renamed Person/);
    assert.match(grounding, /alias@example.org/);
    assert.match(grounding, /1-14 October/);
    assert.equal(await buildPeopleContext(pool, ['normal text with no mention']), '');
    await savePerson(pool, { name: 'Separate person', emails: ['other@example.com'] });
    await assert.rejects(importPeople(pool, [{ name: 'Atomic new', emails: [] },
      { ...current, emails: ['example@example.com', 'other@example.com'] }]), /Multiple existing/);
    assert.equal((await listPeople(pool, 'Atomic new')).length, 0, 'import rolls back the whole batch on conflicts');
    assert.equal((await fetch(`${base}?q=a&q=b`)).status, 422);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":""}' })).status, 422);
    const listed = await fetch(base); assert.equal(listed.status, 200);
    const removed = await fetch(`${base}/${created.id}`, { method: 'DELETE' }); assert.equal(removed.status, 200);
    assert.equal((await fetch(`${base}/${created.id}`)).status, 404);
    assert.match(JSON.stringify(await resolveNoteLinks(pool, content)), /Unavailable person/);
    assert.match(await buildPeopleContext(pool, [token]), /unavailableIds/);
  } finally {
    query.mock.restore(); connect.mock.restore();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  }
});
