import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { readNoteFiling, readNoteTags, setNoteTags } from '../src/services/noteTagService.js';
import { executeToolCall } from '../src/ai/chatTools.js';

test('note filing shares transactional validation, conflicts and auto-tag rejection across Athena and the editor', async () => {
  const db = new PGlite();
  const note = '11111111-1111-4111-8111-111111111111';
  const parent = '22222222-2222-4222-8222-222222222222';
  const child = '33333333-3333-4333-8333-333333333333';
  const missing = '44444444-4444-4444-8444-444444444444';
  await db.exec(`CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT,status TEXT);
    CREATE TABLE tags(id UUID PRIMARY KEY,name TEXT,slug TEXT,parent_id UUID,colour TEXT,role TEXT,project_id TEXT);
    CREATE TABLE note_tags(note_id UUID REFERENCES notes(id),tag_id UUID REFERENCES tags(id),source TEXT DEFAULT 'user',
      PRIMARY KEY(note_id,tag_id));
    CREATE TABLE tag_rejections(content_kind TEXT,content_id TEXT,tag_id UUID,PRIMARY KEY(content_kind,content_id,tag_id));
    CREATE TABLE nodes(id UUID,ref_id UUID);
    CREATE TABLE content_items(id UUID,source TEXT,source_id TEXT);`);
  await db.query("INSERT INTO notes VALUES($1,'Unrelated saved writing','active')", [note]);
  await db.query("INSERT INTO tags VALUES($1,'Research','research',NULL,NULL,'filing',NULL),($2,'AI','ai',$1,NULL,'concept',NULL)", [parent, child]);
  await db.query("INSERT INTO note_tags VALUES($1,$2,'auto')", [note, parent]);
  const pool = getDb();
  const query = mock.method(pool, 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  const connect = mock.method(pool, 'connect', async () => ({ query: (sql: string, values?: unknown[]) => db.query(sql, values), release() {} }));
  try {
    const tags = await readNoteTags(pool, note);
    assert.equal(tags[0]?.path, 'Research');
    const filing = await readNoteFiling(pool, note);
    assert.deepEqual(filing.expectedTagIds, [parent]);
    assert.ok(filing.folders.some(folder => folder.path === 'Research / AI'));
    assert.equal(filing.hasMore, false);
    await setNoteTags(pool, note, [parent], [parent]);
    assert.equal((await readNoteTags(pool, note))[0]?.source, 'auto', 'An unchanged filing does not convert an auto tag to a user tag');
    await assert.rejects(() => setNoteTags(pool, note, [child], []), /changed elsewhere/);
    await assert.rejects(() => setNoteTags(pool, note, [missing], [parent]), /no longer exist/);
    await assert.rejects(() => setNoteTags(pool, note, ['invalid'], [parent]), /valid tag IDs/);
    assert.deepEqual((await readNoteTags(pool, note)).map(tag => tag.id), [parent], 'Rejected writes leave filing intact');
    assert.deepEqual(await setNoteTags(pool, note, [child, child], [parent]), { noteId: note, tagIds: [child] });
    assert.equal((await readNoteTags(pool, note))[0]?.path, 'Research / AI');
    assert.equal((await readNoteTags(pool, note))[0]?.source, 'user');
    const rejections = await db.query<{ tag_id: string }>('SELECT tag_id FROM tag_rejections');
    assert.equal(rejections.rows[0]?.tag_id, parent, 'Removing an automatic tag preserves the existing rejection rule');
    assert.equal((await db.query<{ content: string }>('SELECT content FROM notes')).rows[0]?.content, 'Unrelated saved writing');
    const readonly = await executeToolCall(pool, 'set_note_tags', JSON.stringify({ noteId: note, tagIds: [], expectedTagIds: [child] }),
      undefined, { readOnly: true });
    assert.match(JSON.stringify(readonly), /read-only/);
    const excluded = await executeToolCall(pool, 'read_note_tags', JSON.stringify({ noteId: note }),
      undefined, { excludedIds: new Set([note]) });
    assert.deepEqual(excluded, { status: 'excluded' });
    assert.deepEqual(await executeToolCall(pool, 'set_note_tags', JSON.stringify({ noteId: note, tagIds: [], expectedTagIds: [child] }),
      undefined, { excludedIds: new Set([note]) }), { status: 'excluded' });
    assert.deepEqual((await readNoteTags(pool, note)).map(tag => tag.id), [child]);
    await db.query("UPDATE notes SET status='archived'");
    await assert.rejects(() => setNoteTags(pool, note, [], [child]), /archived/);
  } finally { query.mock.restore(); connect.mock.restore(); await db.close(); }
});
