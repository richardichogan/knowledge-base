import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { parseBrainstormSettings } from '../src/services/canvasService.js';

const defaults = { grid: true, snapToGrid: true, snapToShapes: true, gridSize: 10 };

test('brainstorm settings reject incomplete, unsupported and malformed values', () => {
  assert.deepEqual(parseBrainstormSettings(defaults), defaults);
  for (const value of [null, [], {}, { ...defaults, gridSize: 15 }, { ...defaults, grid: 'true' }, { ...defaults, extra: true }]) {
    assert.throws(() => parseBrainstormSettings(value));
  }
});

test('migration persists independent settings for each canvas without changing metadata', async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE canvases (id text PRIMARY KEY, title text); INSERT INTO canvases VALUES ('one', 'First'), ('two', 'Second')");
    await db.exec(await readFile(new URL('../src/db/migrations/116_brainstorm_settings.sql', import.meta.url), 'utf8'));
    const changed = { grid: false, snapToGrid: false, snapToShapes: true, gridSize: 20 };
    await db.query('UPDATE canvases SET brainstorm_settings = $1 WHERE id = $2', [JSON.stringify(changed), 'one']);
    await db.query('UPDATE canvases SET title = $1 WHERE id = $2', ['Renamed', 'one']);
    const result = await db.query<{ id: string; title: string; brainstorm_settings: unknown }>('SELECT * FROM canvases ORDER BY id');
    assert.deepEqual(result.rows.map(row => [row.id, row.title, row.brainstorm_settings]), [
      ['one', 'Renamed', changed], ['two', 'Second', defaults],
    ]);
  } finally { await db.close(); }
});
