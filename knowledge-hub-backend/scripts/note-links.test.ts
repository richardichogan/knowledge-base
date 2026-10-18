import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { findLinkTargets, noteBacklinks, resolveNoteLinks } from '../src/services/noteLinks.js';
import { noteLinksRouter } from '../src/routes/noteLinks.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { noteMarkdown } from '../src/services/noteMarkdown.js';
import { renderNoteAsText } from '../src/services/noteTextService.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mention = (n: number) => ({ type: 'noteMention', props: { noteId: id(n) } });
const writing = (title: string, content: unknown[]) => JSON.stringify({
  title, contentType: 'note', contentJson: JSON.stringify(content),
});

test('entity link search, atomic derived backlinks, nested content, rename/deletion and exports', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE notes(id UUID PRIMARY KEY, content TEXT, status TEXT DEFAULT 'active',
      updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE sparks(id UUID PRIMARY KEY, body TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE canvases(id UUID PRIMARY KEY, title TEXT, canvas_type TEXT, deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, lifecycle_state TEXT DEFAULT 'active', updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tasks(id UUID PRIMARY KEY, title TEXT, archived BOOLEAN DEFAULT false, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE content_items(id UUID PRIMARY KEY, source TEXT, title TEXT, url TEXT, published_at TIMESTAMPTZ, indexed_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE use_cases(id UUID PRIMARY KEY, title TEXT, stage TEXT DEFAULT 'candidate', updated_at TIMESTAMPTZ DEFAULT NOW());
  `);
  await db.exec(await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8'));
  const migration = await readFile(new URL('../src/db/migrations/082_note_links.sql', import.meta.url), 'utf8');
  await db.query('INSERT INTO notes(id,content) VALUES($1,$2)', [id(1), writing('Target', [])]);
  await db.query('INSERT INTO notes(id,content) VALUES($1,$2)',
    [id(2), writing('Source', [{ type: 'paragraph', content: [mention(1)] }])]);
  await db.exec(migration);
  await db.exec(migration);
  const pool = getDb();
  const query = mock.method(pool, 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  try {
    assert.equal((await noteBacklinks(pool, id(1), 0)).items[0]?.id, id(2), 'migration indexes existing references idempotently');
    await db.query('INSERT INTO sparks VALUES($1,$2,NOW())', [id(3), 'Target spark']);
    await db.query("INSERT INTO canvases(id,title,canvas_type) VALUES($1,'Target diagram','diagram'),($2,'Hidden board','brainstorm')", [id(4), id(5)]);
    await db.query("INSERT INTO projects(id,name) VALUES('target-project','Target project')");
    await db.query("INSERT INTO tasks(id,title) VALUES($1,'Target task'),($2,'Target archived task')", [id(6), id(7)]);
    await db.query('UPDATE tasks SET archived=true WHERE id=$1', [id(7)]);
    await db.query("INSERT INTO use_cases(id,title) VALUES($1,'Target use case'),($2,'Target dropped')", [id(8), id(9)]);
    await db.query("UPDATE use_cases SET stage='dropped' WHERE id=$1", [id(9)]);
    await db.query("INSERT INTO content_items(id,source,title,url) VALUES($1,'discovered-article','Target article','https://example.com/a'),($2,'email','Target email','https://example.com/b')", [id(11), id(12)]);
    const found = await findLinkTargets(pool, 'Target');
    assert.deepEqual(new Set(found.map(item => item.type)), new Set(['note', 'spark', 'diagram', 'project', 'task', 'usecase', 'article']));
    assert.ok(found.some(item => item.type === 'article' && item.href === 'https://example.com/a'), 'articles link to their source URL');
    assert.equal(found.some(item => item.title === 'Target email'), false, 'only Discover articles are link targets');
    assert.equal(found.filter(item => item.type === 'task' || item.type === 'usecase').length, 2, 'archived tasks and dropped use cases are excluded');
    assert.ok(found.some(item => item.href === `/plan?taskId=${id(6)}`));
    assert.ok(found.some(item => item.href === `/plan?view=use-cases&useCase=${id(8)}`));
    assert.ok(found.some(item => item.href === `/think?view=sparks&sparkId=${id(3)}`));
    assert.ok(found.some(item => item.href === '/projects?projectId=target-project'));
    assert.equal((await findLinkTargets(pool, '', 'note', id(1))).length, 1);
    assert.equal((await findLinkTargets(pool, 'Target', undefined, undefined, id(1))).some(item => item.id === id(1)), false);
    assert.equal((await findLinkTargets(pool, '%')).length, 0, 'SQL wildcards are literal');
    assert.equal((await findLinkTargets(pool, "' OR TRUE --")).length, 0);
    const nested = writing('Source', [{ type: 'table', content: { rows: [{ cells: [{ content: [mention(1), mention(1),
      { type: 'entityMention', props: { entityType: 'project', entityId: 'target-project' } }] }] }] },
      children: [{ type: 'paragraph', content: [mention(1)] }] }]);
    await db.query('UPDATE notes SET content=$2 WHERE id=$1', [id(2), nested]);
    assert.equal((await db.query('SELECT * FROM note_links')).rows.length, 1, 'nested duplicate references are one backlink');
    assert.equal((await db.query('SELECT * FROM note_entity_links')).rows.length, 1);
    await db.exec('BEGIN');
    await db.query('UPDATE notes SET content=$2 WHERE id=$1', [id(2), writing('Source', [])]);
    assert.equal((await db.query('SELECT * FROM note_links')).rows.length, 0);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT * FROM note_links')).rows.length, 1, 'derived links roll back with writing');
    await db.query('UPDATE notes SET content=$2 WHERE id=$1', [id(1), writing('Renamed target', [])]);
    const plain = writing('Source', [{ type: 'paragraph', content: [{ type: 'text', text: 'See ', styles: {} }, mention(1)] }]);
    assert.ok(JSON.stringify(await resolveNoteLinks(pool, plain)).includes('Renamed target'));
    const markdown = await noteMarkdown(plain, id(2));
    assert.match(markdown, /\[Renamed target\]\(https?:\/\/[^)]+\/think\?noteId=/, 'GitHub export keeps readable, absolute deep links');
    assert.match(await renderNoteAsText(pool, plain), /See Renamed target/, 'Athena and search read resolved titles instead of dropping mentions');
    await db.query("UPDATE notes SET status='archived' WHERE id=$1", [id(2)]);
    assert.equal((await noteBacklinks(pool, id(1), 0)).items.length, 0, 'archived source notes are excluded');
    await db.query("UPDATE notes SET status='archived' WHERE id=$1", [id(1)]);
    assert.equal((await findLinkTargets(pool, '', 'note', id(1))).length, 0);
    assert.ok(JSON.stringify(await resolveNoteLinks(pool, plain)).includes('Unavailable note'));
    await db.query("UPDATE notes SET status='active' WHERE id=ANY($1::uuid[])", [[id(1), id(2)]]);
    await db.query('UPDATE notes SET content=$2 WHERE id=$1', [id(2), writing('Source', [{ type: 'paragraph', content: ['[[Renamed target]]'] }])]);
    assert.equal((await db.query('SELECT * FROM note_links')).rows.length, 0, 'pasted wiki syntax never silently creates references');
    for (let n = 10; n < 33; n++) {
      await db.query('INSERT INTO notes(id,content) VALUES($1,$2)',
        [id(n), writing(`Source ${n}`, [{ type: 'paragraph', content: [mention(1)] }])]);
    }
    const first = await noteBacklinks(pool, id(1), 0);
    const second = await noteBacklinks(pool, id(1), 20);
    assert.equal(first.items.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(second.items.length, 3);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 23);
    await db.query('DELETE FROM notes WHERE id=$1', [id(1)]);
    assert.equal((await db.query('SELECT * FROM note_links')).rows.length, 0);
  } finally { query.mock.restore(); await db.close(); }
});

test('link routes validate query shapes and surface failures', async () => {
  const app = express();
  app.use('/api/notes', noteLinksRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const pool = getDb();
  const query = mock.method(pool, 'query', async () => { throw new Error('Link database unavailable'); });
  try {
    for (const route of ['link-targets?type=unknown', 'link-targets?q=a&q=b', `link-targets?q=${'a'.repeat(201)}`,
      'invalid/backlinks', `${id(1)}/backlinks?page=-1`, `${id(1)}/backlinks?page=10001`]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/notes/${route}`);
      assert.equal(response.status, 422, route);
      assert.equal((await response.json() as { success: boolean }).success, false);
    }
    const failed = await fetch(`http://127.0.0.1:${address.port}/api/notes/link-targets?q=Target`);
    assert.equal(failed.status, 500, 'lookup failures must not look like an empty successful search');
  } finally {
    query.mock.restore();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
