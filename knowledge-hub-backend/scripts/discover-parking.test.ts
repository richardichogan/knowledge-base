import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { getDb } from '../src/db/db.js';
import { discoverRouter, type DiscoverItem } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { getDiscoverParking, saveDiscoverParking, removeDiscoverParking, parseParkingSelection } from '../src/services/discoverParking.js';

const id = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const newsletter = { newsletter: true, podcast: false };
const both = { newsletter: true, podcast: true };
async function fixture(): Promise<{ pg: PGlite; db: Pool }> {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE content_items (
    id UUID PRIMARY KEY, source TEXT, source_id TEXT, title TEXT, url TEXT, body TEXT,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), indexed_at TIMESTAMPTZ DEFAULT NOW(), metadata JSONB DEFAULT '{}',
    workflow_state TEXT DEFAULT 'saved', relevance_score REAL, relevance_explanation TEXT);
    CREATE TABLE discover_item_tags(discover_item_id UUID,tag_id UUID);
    CREATE TABLE discover_interest_weights(kind TEXT,term TEXT,weight REAL);
    INSERT INTO content_items(id,source,source_id,title,url,body,metadata,workflow_state)
      SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'discovered-article',n::text,
        'Article ' || n,'https://example.com/' || n,'Original source excerpt',
        '{"sourceTitle":"Fixture feed","publishedUrl":"https://my.example/post"}',
        CASE WHEN n%2=0 THEN 'published' ELSE 'saved' END FROM generate_series(1,27) n;
    INSERT INTO content_items(id,source,title) VALUES ('${id(99)}','note','Not a Discover article');`);
  const migration = await readFile(new URL('../src/db/migrations/087_discover_parking.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
  return { pg, db: pg as unknown as Pool };
}

test('parking requires an explicit supported destination, not truthy strings or an empty selection', () => {
  assert.deepEqual(parseParkingSelection(newsletter), newsletter);
  assert.deepEqual(parseParkingSelection(both), both);
  assert.deepEqual(parseParkingSelection({ newsletter: false, podcast: true }), { newsletter: false, podcast: true });
  for (const value of [null, [], {}, { newsletter: false, podcast: false }, { newsletter: 'true', podcast: false },
    { newsletter: true }, { ...both, state: 'published' }]) {
    assert.throws(() => parseParkingSelection(value));
  }
});

test('parking survives reload and source refresh without changing article workflow; both destinations remain one entry', async () => {
  const { pg, db } = await fixture();
  try {
    assert.equal(await getDiscoverParking(db, id(1)), null);
    const original = (await pg.query('SELECT * FROM content_items WHERE id=$1', [id(1)])).rows[0];
    const saved = await saveDiscoverParking(db, id(1), newsletter);
    assert.deepEqual(await getDiscoverParking(db, id(1)), saved);
    const updated = await saveDiscoverParking(db, id(1), both);
    assert.equal(updated.parkedAt, saved.parkedAt, 'Changing destinations retains original parking order');
    assert.equal((await pg.query('SELECT * FROM discover_parking')).rows.length, 1);
    assert.deepEqual((await pg.query('SELECT * FROM content_items WHERE id=$1', [id(1)])).rows[0], original);
    await pg.query(`UPDATE content_items SET title='Refreshed title',body='Refreshed excerpt',metadata='{}',workflow_state='archived' WHERE id=$1`, [id(1)]);
    assert.deepEqual(await getDiscoverParking(db, id(1)), updated);
    await removeDiscoverParking(db, id(1));
    await removeDiscoverParking(db, id(1));
    assert.equal(await getDiscoverParking(db, id(1)), null);
    assert.equal((await pg.query<{ workflow_state: string }>('SELECT workflow_state FROM content_items WHERE id=$1', [id(1)])).rows[0]?.workflow_state, 'archived');
    await assert.rejects(saveDiscoverParking(db, id(99), both), /not found/i);
    await assert.rejects(saveDiscoverParking(db, id(100), both), /not found/i);
    await assert.rejects(getDiscoverParking(db, 'invalid'), /Invalid/);
    await assert.rejects(pg.query('INSERT INTO discover_parking(article_id,newsletter,podcast) VALUES($1,false,false)', [id(1)]), /check constraint/i);
    await saveDiscoverParking(db, id(1), both);
    await pg.query('DELETE FROM content_items WHERE id=$1', [id(1)]);
    assert.equal((await pg.query('SELECT * FROM discover_parking')).rows.length, 0, 'No orphan parking records');
  } finally { await pg.close(); }
});

test('parking API lists all parked workflow states with stable pages, editing/removal and explicit failures', async () => {
  const { pg } = await fixture();
  let unavailable = false;
  const query = mock.method(getDb(), 'query', (sql: string, values?: unknown[]) => {
    if (unavailable) return Promise.reject(new Error('Fixture storage unavailable'));
    return pg.query(sql, values);
  });
  const app = express();
  app.use(express.json());
  app.use('/api/discover', discoverRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/discover`;
  const write = (index: number, selection: unknown, method = 'PUT') => fetch(`${base}/${id(index)}/parking`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify(selection) } : {}),
  });
  const read = async (path: string) => {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 200);
    return (await response.json() as { data: { items: DiscoverItem[]; total: number } }).data;
  };
  try {
    assert.equal((await read('parking-lot')).total, 0);
    for (let n = 1; n <= 27; n++) assert.equal((await write(n, both)).status, 200);
    await pg.exec(`UPDATE discover_parking SET parked_at='2026-10-19T12:00:00Z';
      INSERT INTO discover_interest_weights VALUES ('source','fixture feed',0);`);
    const first = await read('parking-lot?pageSize=25');
    const second = await read('parking-lot?pageSize=25&page=2');
    assert.equal(first.total, 27);
    assert.equal(first.items.length, 25);
    assert.equal(second.items.length, 2);
    assert.deepEqual([...first.items, ...second.items].map(item => item.id), Array.from({ length: 27 }, (_, n) => id(n + 1)));
    assert.deepEqual((await read('parking-lot?pageSize=25')).items.map(item => item.id), first.items.map(item => item.id));
    assert.equal(new Set(first.items.map(item => item.workflowState)).size, 2, 'Saved and Published articles share the pool');
    assert.equal(first.items[0]?.parking?.newsletter, true);
    assert.equal(first.items[0]?.parking?.podcast, true);
    assert.equal(first.items[0]?.description, 'Original source excerpt');
    assert.equal(first.items[0]?.url, 'https://example.com/1');
    assert.equal((await read('?state=saved')).total, 14, 'Parking did not change Saved');
    assert.equal((await read('?state=published')).total, 13, 'Parking did not change Published');
    assert.equal((await read('?state=saved')).items[0]?.parking?.podcast, true, 'Ordinary feed restores parking labels without opening each editor');
    assert.equal((await write(1, newsletter)).status, 200);
    const restored = await fetch(`${base}/${id(1)}/parking`);
    assert.equal((await restored.json() as { data: { podcast: boolean } }).data.podcast, false);
    assert.equal((await read('parking-lot')).total, 27, 'Repeat save cannot duplicate');
    assert.equal((await write(1, null, 'DELETE')).status, 200);
    assert.equal((await read('parking-lot')).total, 26);
    for (const selection of [{ newsletter: false, podcast: false }, { newsletter: 'true', podcast: true }]) {
      assert.equal((await write(2, selection)).status, 422);
    }
    assert.equal((await write(99, both)).status, 404);
    assert.equal((await write(100, both)).status, 404);
    assert.equal((await fetch(`${base}/invalid/parking`)).status, 422);
    for (const params of ['page=NaN', 'pageSize=0', 'page=9007199254740991', 'filtered=true']) {
      assert.equal((await fetch(`${base}/parking-lot?${params}`)).status, 422);
    }
    unavailable = true;
    const failed = await write(2, newsletter);
    assert.equal(failed.status, 500);
    assert.equal((await failed.json() as { success: boolean }).success, false);
    unavailable = false;
    assert.equal((await read('parking-lot')).items.find(item => item.id === id(2))?.parking?.podcast, true, 'Failure retains last saved choices');
  } finally {
    query.mock.restore();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pg.close();
  }
});
