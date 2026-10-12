import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { notesRouter } from '../src/routes/notes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

test('note summaries exhaust stable pages and filter saved writing, types and explicit/legacy project scopes', async () => {
  const db = new PGlite();
  const parent = '11111111-1111-4111-8111-111111111111';
  const child = '22222222-2222-4222-8222-222222222222';
  const extra = '33333333-3333-4333-8333-333333333333';
  const otherChild = '44444444-4444-4444-8444-444444444444';
  const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const writing = (title: string, type = 'note', text = 'Body') => JSON.stringify({
    title, contentType: type, contentJson: JSON.stringify([{ type: 'paragraph', content: [{ text }] }]),
  });
  await db.exec(`CREATE TABLE notes (
    id UUID PRIMARY KEY, content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT '2026-10-01',
    updated_at TIMESTAMPTZ DEFAULT '2026-10-02', tags TEXT[] DEFAULT '{}',
    linked_items TEXT[] DEFAULT '{}', status TEXT DEFAULT 'active', project_id TEXT, revision INTEGER DEFAULT 1);
    CREATE TABLE tags (id UUID PRIMARY KEY, parent_id UUID);
    CREATE TABLE note_tags (note_id UUID REFERENCES notes(id), tag_id UUID REFERENCES tags(id),
      PRIMARY KEY(note_id,tag_id));`);
  const migration = await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  await db.query('INSERT INTO tags VALUES ($1,NULL),($2,$1),($3,NULL)', [parent, child, extra]);
  await db.query('INSERT INTO tags VALUES ($1,$2)', [otherChild, parent]);
  for (let i = 0; i < 105; i++) {
    await db.query('INSERT INTO notes (id,content,project_id) VALUES ($1,$2,$3)',
      [id(i), writing(`Title ${String(i).padStart(3, '0')}`, i === 104 ? 'blog' : 'note',
        i === 104 ? 'Hidden needle and 50%_literal' : 'Body'), 'alpha']);
  }
  await db.query('INSERT INTO notes (id,content) VALUES ($1,$2),($3,$4),($5,$6)',
    [id(105), writing('Legacy alpha'), id(106), 'Plain legacy text', id(108),
      JSON.stringify([{ type: 'heading', content: [] }, { type: 'heading', content: [{ text: 'Ignored second heading' }] },
        { type: 'paragraph', content: [{ text: 'Paragraph ' }, { text: 'fallback' }] }])]);
  await db.query('INSERT INTO notes (id,content,project_id) VALUES ($1,$2,$3)', [id(107), writing('Explicit beta'), 'beta']);
  await db.query("INSERT INTO notes (id,content,status) VALUES ($1,$2,'archived')", [id(109), writing('Archived needle')]);
  await db.query('INSERT INTO note_tags VALUES ($1,$2),($1,$3),($4,$2),($5,$2)',
    [id(104), child, extra, id(105), id(107)]);
  await db.query('INSERT INTO note_tags VALUES ($1,$2)', [id(105), otherChild]);

  const pool = getDb();
  const query = mock.method(pool, 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  const app = express();
  app.use('/api/notes', notesRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  type Page = { items: { id: string; title: string; contentType: string; content?: string; taxonomyTagIds: string[] }[];
    total: number; page: number; hasMore: boolean };
  const read = async (params = ''): Promise<Page> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/notes?view=summary&pageSize=100&${params}`);
    assert.equal(response.status, 200);
    const envelope = await response.json() as { success: boolean; data: Page };
    assert.equal(envelope.success, true);
    return envelope.data;
  };
  try {
    for (const sort of ['modified', 'created', 'title']) {
      const first = await read(`sort=${sort}`);
      const second = await read(`sort=${sort}&page=2`);
      assert.equal(first.total, 109);
      assert.equal(first.items.length, 100);
      assert.equal(first.hasMore, true);
      assert.equal(second.items.length, 9);
      assert.equal(second.hasMore, false);
      assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 109);
      assert.deepEqual((await read(`sort=${sort}`)).items, first.items);
      assert.ok(first.items.every((item) => !('content' in item)), 'summary pages must not expose full bodies');
    }
    assert.deepEqual((await read('q=needle')).items.map((item) => item.id), [id(104)]);
    assert.equal((await read('q=50%25_literal')).total, 1, 'wildcards must be literal');
    assert.equal((await read('q=%27%20OR%201%3D1%20--')).total, 0);
    assert.deepEqual((await read('contentType=blog')).items.map((item) => item.id), [id(104)]);
    assert.equal((await read('projectId=alpha')).total, 105);
    assert.equal((await read(`projectId=alpha&projectTagIds=${child}`)).total, 106);
    assert.equal((await read(`projectId=other-legacy&projectTagIds=${otherChild}`)).total, 0,
      'legacy project resolution must use the same first child tag as the displayed list');
    assert.deepEqual((await read(`projectId=beta&projectTagIds=${child}`)).items.map((item) => item.id),
      [id(107), id(105)]);
    assert.equal((await read('projectId=__none__')).total, 2);
    assert.equal((await read(`tagIds=${child},${extra}`)).total, 3, 'multiple matching tags must not duplicate rows');
    assert.equal((await read(`projectId=alpha&projectTagIds=${child}&tagIds=${child}&contentType=blog&q=needle`)).total, 1);
    assert.equal((await read('q=Plain%20legacy')).items[0]?.title, 'Untitled');
    assert.equal((await read('q=Ignored%20second%20heading')).items[0]?.title, 'Untitled');
    const metadata = await db.query<{ metadata: { title: string; contentType: string } }>(
      'SELECT note_list_metadata($1) AS metadata', [writing('Wrapped title', 'article', 'Nested text')]);
    assert.deepEqual(metadata.rows[0]?.metadata, { title: 'Wrapped title', contentType: 'article' });
    for (const params of ['page=NaN', 'page=-1', 'page=1.5', 'pageSize=0', 'page=9007199254740991',
      'sort=invalid', 'tagIds=invalid', 'projectTagIds=invalid', 'q=a&q=b']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/notes?${params}`);
      assert.ok(response.status >= 400 && response.status < 500, params);
      assert.equal((await response.json() as { success: boolean }).success, false);
    }
  } finally {
    query.mock.restore();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
  }
});
