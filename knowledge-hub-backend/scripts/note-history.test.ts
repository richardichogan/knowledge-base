import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { automaticCheckpointDue, writingFingerprint, parseWriting, writeNote, listNoteVersions, getNoteVersion } from '../src/services/noteVersionService.js';

const body = (title: string, path = 'current.md', bold = false): string => JSON.stringify({
  title, contentType: 'use-case', githubPath: path,
  contentJson: JSON.stringify([{ id: title, type: 'heading', props: { level: 1 },
    content: [{ type: 'text', text: title, styles: { bold } }],
    children: [{ id: `${title}-child`, type: 'paragraph', content: 'nested' }] }]),
});

test('canonical writing and exact interval boundaries', () => {
  const writing = parseWriting(body('A'));
  // Change IDs only, keeping heading text untouched.
  const blocks = JSON.parse(writing.contentJson);
  blocks[0].id = 'new-id'; blocks[0].children[0].id = 'new-child';
  const differentIds = { ...writing, contentJson: JSON.stringify(blocks) };
  assert.equal(writingFingerprint(writing), writingFingerprint(differentIds));
  assert.notEqual(writingFingerprint(writing), writingFingerprint(parseWriting(body('A', 'current.md', true))));
  const withLink = structuredClone(blocks);
  withLink[0].children[0].content = [{ type: 'link', href: 'https://example.test/original', content: [{ type: 'text', text: 'nested', styles: {} }] }];
  assert.notEqual(writingFingerprint(writing), writingFingerprint({ ...writing, contentJson: JSON.stringify(withLink) }));
  assert.equal(writingFingerprint(writing), writingFingerprint(parseWriting(body('A', 'different.md'))));
  const at = new Date('2026-10-08T10:00:00Z');
  assert.equal(automaticCheckpointDue(at, new Date(at.getTime() + 1_799_999)), false);
  assert.equal(automaticCheckpointDue(at, new Date(at.getTime() + 1_800_000)), true);
  assert.equal(automaticCheckpointDue(null, at), true);
  assert.throws(() => parseWriting('{"contentJson":"bad"}'));
  assert.equal(JSON.parse(parseWriting('legacy text').contentJson)[0].content, 'legacy text');
});

test('isolated PostgreSQL migration and full transactional policy', async () => {
  const { PGlite } = await import(process.env['NOTE_HISTORY_DB_MODULE'] ?? '@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`CREATE TABLE notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tags TEXT[] NOT NULL DEFAULT '{}', linked_items UUID[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active', project_id UUID);
  `);
  const migration = await readFile(new URL('../src/db/migrations/060_note_history.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration); // Redeploy-safe.
  await db.exec(await readFile(new URL('../src/db/migrations/061_note_github_publications.sql', import.meta.url), 'utf8'));
  const client = { query: (sql: string, values?: unknown[]) => db.query(sql, values), release() {} };
  const pool = { ...client, connect: async () => client } as unknown as Pool;
  const create = async (content: string) => (await db.query('INSERT INTO notes (content) VALUES ($1) RETURNING id', [content])).rows[0].id as string;
  const id = await create(body('Original'));
  const other = await create(body('Other'));
  const project = '11111111-1111-4111-8111-111111111111';
  await db.query('UPDATE notes SET project_id = $2, linked_items = ARRAY[$3::uuid] WHERE id = $1', [id, project, other]);
  const count = async () => (await listNoteVersions(pool, id)).length;
  let saved = await writeNote(pool, id, { content: body('Original'), expectedRevision: 0 });
  assert.equal(saved.revision, 0);
  assert.equal(await count(), 0);
  saved = await writeNote(pool, id, { content: body('Original', 'new.md'), tags: ['keep'], expectedRevision: 0 });
  assert.equal(await count(), 0, 'metadata does not checkpoint');
  saved = await writeNote(pool, id, { content: body('First edit'), expectedRevision: saved.revision });
  const original = (await listNoteVersions(pool, id))[0]!;
  assert.equal((await getNoteVersion(pool, id, original.id)).writing.title, 'Original');
  for (let i = 0; i < 100; i++) {
    saved = await writeNote(pool, id, { content: body(`Edit ${i}`), expectedRevision: saved.revision });
  }
  assert.equal(await count(), 1, '100 saves in one interval create only one automatic checkpoint');
  await assert.rejects(writeNote(pool, id, { content: body('stale'), expectedRevision: 0 }), /changed elsewhere/);
  await assert.rejects(writeNote(pool, id, { content: body('missing revision') }), /changed elsewhere/);
  assert.equal(await count(), 1);
  await db.exec(`UPDATE notes SET last_history_at = clock_timestamp() - interval '30 minutes' WHERE id = '${id}'`);
  saved = await writeNote(pool, id, { content: body('Interval crossed'), expectedRevision: saved.revision });
  assert.equal(await count(), 2);
  const automaticClock = (await db.query('SELECT last_history_at FROM notes WHERE id = $1', [id])).rows[0].last_history_at;
  saved = await writeNote(pool, id, { content: body('Unsaved live draft', 'keep-current.md', true), protect: true, expectedRevision: saved.revision });
  assert.equal(await count(), 3);
  assert.equal((await getNoteVersion(pool, id, (await listNoteVersions(pool, id))[0]!.id)).writing.title, 'Unsaved live draft');
  saved = await writeNote(pool, id, { content: saved.content, protect: true, expectedRevision: saved.revision });
  assert.equal(await count(), 3, 'dedup consecutive checkpoints');
  await assert.rejects(writeNote(pool, other, { restoreId: original.id, expectedRevision: 0 }), /not found/);
  saved = await writeNote(pool, id, { restoreId: original.id, expectedRevision: saved.revision });
  assert.equal(JSON.parse(saved.content).title, 'Original');
  assert.equal(JSON.parse(saved.content).githubPath, 'keep-current.md');
  assert.deepEqual(saved.tags, ['keep']);
  assert.equal(saved.projectId, project);
  assert.deepEqual(saved.linkedItems, [other]);
  assert.equal(await count(), 3, 'restore reuses exact latest protected checkpoint');
  assert.deepEqual((await db.query('SELECT last_history_at FROM notes WHERE id = $1', [id])).rows[0].last_history_at, automaticClock);
  const noOp = await writeNote(pool, id, { restoreId: original.id, expectedRevision: saved.revision });
  assert.equal(noOp.revision, saved.revision);
  saved = await writeNote(pool, id, { appendBlocks: [{ type: 'paragraph', content: 'appended' }] });
  assert.equal(JSON.parse(JSON.parse(saved.content).contentJson).length, 2);
  for (let i = 0; i < 35; i++) {
    saved = await writeNote(pool, id, { content: body(`Protected ${i}`), protect: true, expectedRevision: saved.revision });
  }
  assert.equal(await count(), 30, 'all reasons share latest-30 cap');
  const latest = (await listNoteVersions(pool, id))[0]!;
  assert.equal((await getNoteVersion(pool, id, latest.id)).writing.title, 'Protected 34');
  const oldestRetained = (await listNoteVersions(pool, id))[29]!;
  const selectedBeforePruning = await getNoteVersion(pool, id, oldestRetained.id);
  saved = await writeNote(pool, id, { restoreId: oldestRetained.id, expectedRevision: saved.revision, content: body('Exact unsaved restore draft') });
  assert.equal(JSON.parse(saved.content).title, selectedBeforePruning.writing.title);
  assert.equal(JSON.parse(saved.content).contentJson, selectedBeforePruning.writing.contentJson, 'full rich body restored without truncation');
  const restoredCheckpoint = (await listNoteVersions(pool, id))[0]!;
  assert.equal((await getNoteVersion(pool, id, restoredCheckpoint.id)).writing.title, 'Exact unsaved restore draft');
  assert.equal(restoredCheckpoint.reason, 'before_restore');
  assert.equal(await count(), 30, 'oldest selected version can be restored before pruning');
  await assert.rejects(getNoteVersion(pool, id, original.id), /not found/, 'oldest checkpoint pruned');
  const beforeFailure = saved.content;
  await db.exec(`CREATE FUNCTION fail_note_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END; $$;
    CREATE TRIGGER fail_update BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION fail_note_update();`);
  await assert.rejects(writeNote(pool, id, { content: body('Must roll back'), protect: true, expectedRevision: saved.revision }), /forced rollback/);
  assert.equal((await db.query('SELECT content FROM notes WHERE id = $1', [id])).rows[0].content, beforeFailure);
  assert.equal(await count(), 30);
  assert.equal((await listNoteVersions(pool, id))[0]!.id, restoredCheckpoint.id, 'insertion and pruning rolled back');
  await db.exec('DROP TRIGGER fail_update ON notes');
  await db.query("UPDATE notes SET status = 'archived' WHERE id = $1", [id]);
  await assert.rejects(listNoteVersions(pool, id), /archived/);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM note_versions WHERE note_id = $1', [id])).rows[0].count, 30);
  await db.query('DELETE FROM notes WHERE id = $1', [id]);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM note_versions WHERE note_id = $1', [id])).rows[0].count, 0);
  await db.close();
});
