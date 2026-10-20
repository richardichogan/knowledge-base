import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { chatMentionTargets, chatReferences, resolveChatReferences } from '../src/ai/chatReferences.js';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mention = (n: number): string => `@[Client label](/library?contentItemId=${id(n)})`;
test('typed references only accept local document/note paths and stable UUIDs', () => {
  assert.deepEqual(chatReferences(`${mention(1)} ${mention(1)}`), [{ type: 'document', id: id(1) }]);
  assert.deepEqual(chatReferences(`@[Fake](https://evil.invalid/library?contentItemId=${id(1)}) @[Fake](/library?contentItemId=invalid)`), []);
  assert.deepEqual(chatReferences(`@[Spec](/think?noteId=${id(2)})`), [{ type: 'note', id: id(2) }]);
});

test('mention search and grounding use saved readable records, not client labels, with limits and exclusions', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE people(id UUID PRIMARY KEY,name TEXT,organisation TEXT,emails TEXT[],updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,lifecycle_state TEXT DEFAULT 'active',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT,status TEXT DEFAULT 'active',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE content_items(id UUID PRIMARY KEY,title TEXT,body TEXT,source TEXT,project_context TEXT,metadata JSONB DEFAULT '{}',updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE note_github_publications(repo TEXT,path TEXT);
  `);
  await db.exec(await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8'));
  await db.query("INSERT INTO content_items(id,title,body,source) VALUES($1,'Authoritative spec','Grounded requirement','user-upload'),($2,'Not a document','Email contents','email')", [id(1), id(3)]);
  await db.query("INSERT INTO notes(id,content) VALUES($1,$2)", [id(2), JSON.stringify({
    title: 'Saved note', contentType: 'spec', contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: 'Actual note requirement', styles: {} }] }]),
  })]);
  await db.query("INSERT INTO people(id,name,organisation,emails) VALUES($1,'Richard Hogan','IBM',ARRAY['r@example.test'])", [id(4)]);
  await db.query("INSERT INTO projects(id,name) VALUES('imagine','IMAGINE')");
  const pool = getDb();
  const query = mock.method(pool, 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  try {
    const targets = await chatMentionTargets(pool, '');
    assert.deepEqual(new Set(targets.map(target => target.type)), new Set(['note', 'document', 'person', 'project']));
    assert.equal(targets.find(target => target.type === 'document')?.href, `/library?contentItemId=${id(1)}`);
    assert.equal((await chatMentionTargets(pool, '%')).length, 0, 'SQL wildcards are literal');
    const resolved = await resolveChatReferences(pool, [mention(1), `Follow up on @[Misleading](/think?noteId=${id(2)})`]);
    assert.match(resolved.block, /Authoritative spec/);
    assert.match(resolved.block, /Grounded requirement/);
    assert.match(resolved.block, /Actual note requirement/);
    assert.doesNotMatch(resolved.block, /Misleading/);
    assert.equal(resolved.sources.length, 2, 'earlier selected sources survive a follow-up');
    await assert.rejects(resolveChatReferences(pool, [mention(3)]), /unavailable/);
    assert.equal((await resolveChatReferences(pool, [mention(1), 'Follow-up'], new Set([id(1)]))).sources.length, 0);
    await assert.rejects(resolveChatReferences(pool, [mention(1)], new Set([id(1)])), /excluded/);
    await assert.rejects(resolveChatReferences(pool, [[1, 2, 3, 4, 5, 6].map(mention).join(' ')]), /up to five/);
    await db.query("UPDATE content_items SET body=$2 WHERE id=$1", [id(1), 'x'.repeat(50_000)]);
    assert.match((await resolveChatReferences(pool, [mention(1)])).block, /Source clipped/);
    for (const n of [5, 6, 7, 8]) {
      await db.query("INSERT INTO content_items(id,title,body,source) VALUES($1,$2,$3,'user-upload')",
        [id(n), `Source ${n}`, `source-${n}-` + 'x'.repeat(50_000)]);
    }
    const bounded = await resolveChatReferences(pool, [[1, 5, 6, 7, 8].map(mention).join(' ')]);
    assert.equal(bounded.sources.length, 5);
    for (const n of [5, 6, 7, 8]) assert.ok(bounded.block.includes(`source-${n}-`), 'every source receives a fair budget');
    assert.ok(bounded.block.length < 104_000);
    await db.query("UPDATE notes SET status='archived' WHERE id=$1", [id(2)]);
    await assert.rejects(resolveChatReferences(pool, [`@[Spec](/think?noteId=${id(2)})`]), /unavailable/);
    assert.match((await resolveChatReferences(pool, [`@[Spec](/think?noteId=${id(2)})`, 'Follow up'])).block, /now unavailable/);
  } finally { query.mock.restore(); await db.close(); }
});
