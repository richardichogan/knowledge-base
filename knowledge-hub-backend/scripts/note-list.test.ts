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
      PRIMARY KEY(note_id,tag_id));
    CREATE TABLE podcast_episodes (note_id UUID PRIMARY KEY REFERENCES notes(id),
      show_notes_note_id UUID REFERENCES notes(id), script_note_id UUID REFERENCES notes(id));`);
  const migration = await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(await readFile(new URL('../src/db/migrations/060_note_history.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../src/db/migrations/061_note_github_publications.sql', import.meta.url), 'utf8'));
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
  const connect = mock.method(pool, 'connect', async () => ({ query: (sql: string, values?: unknown[]) => db.query(sql, values), release() {} }));
  let queuedIndexing = 0;
  const originalTimeout = globalThis.setTimeout;
  const timers = mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000) {
      queuedIndexing++;
      return originalTimeout(() => undefined, 0);
    }
    return originalTimeout(callback, delay, ...args);
  });
  const app = express();
  app.use(express.json());
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
    const archived = await read('status=archived&sort=modified');
    assert.equal(archived.total, 1);
    assert.deepEqual(archived.items.map(item => item.id), [id(109)]);
    const hidden = await fetch(`http://127.0.0.1:${address.port}/api/notes/${id(109)}`);
    assert.equal(hidden.status, 404, 'Normal deep links cannot open archived writing');
    const preview = await fetch(`http://127.0.0.1:${address.port}/api/notes/${id(109)}?status=archived`);
    assert.equal(preview.status, 200);
    for (const [route, payload] of [
      ['bad-id/restore-archive', { expectedRevision: 1 }],
      [`${id(109)}/restore-archive`, { expectedRevision: -1 }],
      ['bad-id/recover-draft', { expectedRevision: 1, writing: JSON.parse(writing('Local')) }],
      [`${id(0)}/recover-draft`, { writing: JSON.parse(writing('Local')) }],
      [`${id(0)}/recover-draft`, { expectedRevision: 1, writing: [] }],
      [`${id(0)}/recover-draft`, { expectedRevision: 1, writing: { contentJson: '[]' } }],
      [`${id(0)}/recover-draft`, { expectedRevision: 1, writing: { title: 'Local', contentType: 'note', contentJson: '{}' } }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/notes/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 422, `Recovery uses the existing validation envelope: ${route}`);
    }
    assert.equal((await read(`tagIds=${child},${extra}`)).total, 3, 'multiple matching tags must not duplicate rows');
    assert.equal((await read(`projectId=alpha&projectTagIds=${child}&tagIds=${child}&contentType=blog&q=needle`)).total, 1);
    assert.equal((await read('q=Plain%20legacy')).items[0]?.title, 'Untitled');
    assert.equal((await read('q=Ignored%20second%20heading')).items[0]?.title, 'Untitled');
    const metadata = await db.query<{ metadata: { title: string; contentType: string } }>(
      'SELECT note_list_metadata($1) AS metadata', [writing('Wrapped title', 'article', 'Nested text')]);
    assert.deepEqual(metadata.rows[0]?.metadata, { title: 'Wrapped title', contentType: 'article' });
    for (const params of ['page=NaN', 'page=-1', 'page=1.5', 'pageSize=0', 'page=9007199254740991',
      'sort=invalid', 'tagIds=invalid', 'projectTagIds=invalid', 'q=a&q=b', 'status=all', 'status=active&status=archived', 'structure=invalid']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/notes?${params}`);
      assert.ok(response.status >= 400 && response.status < 500, params);
      assert.equal((await response.json() as { success: boolean }).success, false);
    }
    const post = async (route: string, payload: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/notes/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() as { success: boolean; data: { revision?: number; content?: string; projectId?: string; restored?: boolean; note?: { revision: number } } } };
    };
    const exactWriting = JSON.parse(writing('Recovered route', 'note', 'Exact rich route body')) as { title: string; contentType: string; contentJson: string };
    const recovered = await post(`${id(0)}/recover-draft`, { expectedRevision: 1, writing: exactWriting });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.success, true);
    assert.equal(recovered.body.data.revision, 2);
    assert.equal(recovered.body.data.projectId, 'alpha');
    assert.equal(JSON.parse(recovered.body.data.content!).contentJson, exactWriting.contentJson);
    const checkpoint = await db.query<{ reason: string; writing: { title: string } }>('SELECT reason,writing FROM note_versions WHERE note_id = $1', [id(0)]);
    assert.equal(checkpoint.rows[0]?.reason, 'before_restore');
    assert.equal(checkpoint.rows[0]?.writing.title, 'Title 000');
    const staleRecovery = await post(`${id(0)}/recover-draft`, { expectedRevision: 1, writing: exactWriting });
    assert.equal(staleRecovery.status, 409);
    const restoredArchive = await post(`${id(109)}/restore-archive`, { expectedRevision: 1 });
    assert.equal(restoredArchive.status, 200);
    assert.equal(restoredArchive.body.data.restored, true);
    assert.equal(restoredArchive.body.data.note?.revision, 2);
    const repeatedArchive = await post(`${id(109)}/restore-archive`, { expectedRevision: 1 });
    assert.equal(repeatedArchive.status, 200);
    assert.equal(repeatedArchive.body.data.restored, false);
    assert.equal(repeatedArchive.body.data.note?.revision, 2);
    assert.equal(queuedIndexing, 2, 'Only accepted writing recovery and actual archive transition queue normal indexing; fixture callbacks never execute.');
    assert.equal((await read('status=archived')).total, 0);

    await db.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4),($5,$6)', [
      id(120), writing('Podcast episode', 'podcast-episode'),
      id(121), writing('Owned show notes', 'podcast-show-notes', 'Episode-owned reference content'),
      id(122), writing('Owned script', 'podcast-script', 'Episode-owned script content'),
    ]);
    await db.query('INSERT INTO podcast_episodes VALUES($1,$2,$3)', [id(120), id(121), id(122)]);
    assert.deepEqual((await read('q=Episode-owned')).items.map(item => item.id), [id(120)]);
    assert.equal((await read('contentType=podcast-show-notes')).total, 0);
    assert.equal((await read('contentType=podcast-script')).total, 0);
    const owned = await fetch(`http://127.0.0.1:${address.port}/api/notes/${id(121)}`);
    assert.equal(owned.status, 200, 'The episode editor can still load its owned show notes');

    await db.exec(`
      CREATE TABLE designs(id UUID PRIMARY KEY,parent_note_id UUID,source_note_id UUID,source_use_case_id UUID);
      CREATE TABLE design_assets(design_id UUID,source_type TEXT,source_id TEXT,role TEXT,excluded BOOLEAN,
        PRIMARY KEY(design_id,source_type,source_id));
      CREATE TABLE note_links(source_note_id UUID,target_note_id UUID);
      CREATE TABLE use_cases(id UUID PRIMARY KEY,spec_note_id UUID);
      CREATE TABLE use_case_sources(use_case_id UUID,source_type TEXT,source_id TEXT);
    `);
    await db.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4)', [
      id(110), writing('Publishing package', 'design'), id(111), writing('Second package', 'design'),
    ]);
    await db.query('UPDATE notes SET content=$2 WHERE id=$1', [id(104), writing('Title 104', 'spec', 'Hidden needle and 50%_literal')]);
    await db.query('UPDATE notes SET content=$2 WHERE id=$1', [id(105), writing('Legacy alpha', 'architecture')]);
    await db.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4)', [
      id(112), writing('Digital Steward', 'note', 'Shared governance reference'),
      id(113), writing('Reference specification', 'spec', 'Reference-only document'),
    ]);
    await db.query('INSERT INTO designs VALUES($1,$1,$2,NULL),($3,$3,NULL,$3)', [id(110), id(104), id(111)]);
    await db.query('INSERT INTO note_links VALUES($1,$2),($1,$3),($1,$4)', [id(104), id(105), id(112), id(113)]);
    await db.query("INSERT INTO design_assets VALUES($1,'note',$2,'use_case',false),($1,'note',$3,'reference',false),($4,'note',$5,'reference',false)",
      [id(110), id(106), id(113), id(111), id(112)]);
    await db.query('INSERT INTO use_cases VALUES($1,$2)', [id(111), id(107)]);
    await db.query("INSERT INTO use_case_sources VALUES($1,'note',$2),($1,'note',$3)", [id(111), id(104), id(112)]);
    const flat = await read();
    const grouped = await read('structure=designs');
    const secondPage = await read('structure=designs&page=2');
    const groupedIds = [...grouped.items, ...secondPage.items].map(item => item.id);
    assert.deepEqual((await read('structure=designs&q=Episode-owned')).items.map(item => item.id), [id(120)]);
    assert.ok(!groupedIds.includes(id(121)) && !groupedIds.includes(id(122)));
    assert.equal(flat.total - grouped.total, 4, 'Count distinct originals, including shared memberships, before pagination');
    for (const hiddenId of [104, 105, 106, 107]) assert.ok(!groupedIds.includes(id(hiddenId)));
    for (const visibleId of [108, 110, 111, 112, 113]) assert.ok(groupedIds.includes(id(visibleId)));
    assert.equal(new Set(groupedIds).size, grouped.total);
    assert.equal(secondPage.hasMore, false);
    assert.deepEqual(new Set((await read('structure=designs&q=needle')).items.map(item => item.id)),
      new Set([id(109), id(110), id(111)]), 'Search linked bodies returns their parents, while standalone matches remain visible');
    assert.deepEqual((await read('structure=designs&q=Digital%20Steward')).items.map(item => item.id), [id(112)],
      'A shared reference returns its own note, not the Designs that mention it');
    assert.deepEqual((await read('structure=designs&q=Reference-only&contentType=spec')).items.map(item => item.id), [id(113)],
      'An explicit reference role overrides the inferred document role');
    await db.query("INSERT INTO design_assets VALUES($1,'note',$2,'architecture',true)", [id(110), id(105)]);
    assert.equal((await read('structure=designs')).total, grouped.total + 1, 'Explicit exclusions override inherited links');
    await db.query("UPDATE notes SET status='archived' WHERE id=$1", [id(110)]);
    assert.ok((await read('structure=designs&q=Plain%20legacy')).items.some(item => item.id === id(106)),
      'Archiving a Design reveals originals that have no other active parent');
    await db.query('UPDATE notes SET content=$2 WHERE id=$1', [id(111), writing('No longer a Design')]);
    assert.ok((await read('structure=designs&q=needle')).items.some(item => item.id === id(104)),
      'Retyping the last parent reveals the shared original');
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/notes/${id(104)}`)).status, 200,
      'Grouping never removes direct access to an original');
  } finally {
    query.mock.restore();
    connect.mock.restore();
    timers.mock.restore();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
  }
});
