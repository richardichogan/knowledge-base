import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { textToBlocks } from '../src/ai/markdownToNoteBlocks.js';

test('Prep conversion retains document structure and reference links', () => {
  const blocks = textToBlocks('# Prep\n\n## AI models\n\nA useful development.\n\n- Discuss availability\n\n[Source](https://learn.microsoft.com/azure/)');
  assert.equal(blocks[0]!.type, 'heading');
  assert.ok(blocks.some(block => block.type === 'bulletListItem'));
  assert.match(JSON.stringify(blocks), /https:\/\/learn.microsoft.com\/azure\//);
  assert.ok(!JSON.stringify(blocks).includes('assistant:'));
});

test('Prep body edits invalidate episode work and initialization survives clearing the document', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE notes(id text PRIMARY KEY,content text);
      CREATE TABLE podcast_episodes(note_id text PRIMARY KEY,revision int DEFAULT 1,updated_at timestamptz DEFAULT NOW());
      INSERT INTO notes VALUES('episode','original'),('other','unrelated');
      INSERT INTO podcast_episodes(note_id) VALUES('episode');`);
    await pg.exec(readFileSync(new URL('../src/db/migrations/127_podcast_prep_document.sql', import.meta.url), 'utf8'));
    await pg.exec(`UPDATE podcast_episodes SET prep_document_initialized=TRUE WHERE note_id='episode';
      UPDATE notes SET content='edited prep' WHERE id='episode';
      UPDATE notes SET content='edited prep' WHERE id='episode';`);
    assert.equal((await pg.query<{ revision: number }>('SELECT revision FROM podcast_episodes')).rows[0]!.revision, 2);
    await pg.exec("UPDATE notes SET content='[]' WHERE id='episode'");
    const row = (await pg.query<{ revision: number; prep_document_initialized: boolean }>('SELECT revision,prep_document_initialized FROM podcast_episodes')).rows[0]!;
    assert.equal(row.revision, 3);
    assert.equal(row.prep_document_initialized, true);
  } finally { await pg.close(); }
});
