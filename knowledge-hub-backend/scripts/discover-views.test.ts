import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { discoverRouter, type DiscoverItem } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

test('Discovery sorts are stable across filtered pages, factors explain the SQL rank, and feedback is retry-safe without workflow/scoring writes', async () => {
  const db = new PGlite();
  const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  await db.exec(`CREATE TABLE content_items (
    id UUID PRIMARY KEY, source TEXT, source_id TEXT, title TEXT, url TEXT, body TEXT,
    published_at TIMESTAMPTZ NOT NULL, indexed_at TIMESTAMPTZ DEFAULT NOW(), metadata JSONB DEFAULT '{}',
    workflow_state TEXT DEFAULT 'to-review', relevance_score REAL, relevance_explanation TEXT);
    CREATE TABLE discover_item_tags (discover_item_id UUID, tag_id UUID);`);
  const migration = await readFile(new URL('../src/db/migrations/066_discover_feedback.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  for (let index = 0; index < 107; index++) {
    await db.query(`INSERT INTO content_items (id,source,source_id,title,body,published_at,relevance_score,metadata)
      VALUES ($1,'discovered-article',$2,$3,'Article body',date_trunc('hour',NOW()) - $4::integer * INTERVAL '1 day',$5,$6)`,
    [id(index), String(index), index === 104 ? '50%_literal' : index === 105 ? '50XXliteral' : `Article ${index}`,
      index === 1 ? 365 : index === 2 ? -1 : 0, index === 0 ? 0.9 : index === 1 ? 0.99 : index === 106 ? null : 0.5,
      JSON.stringify({ sourceTitle: index === 106 ? 'Other' : 'Fixture', ...(index === 0 ? {
        sourceAuthorityTier: 'Microsoft/GitHub Official', articleType: 'Security Disclosure', projectBoost: 0.5,
      } : {}) })]);
  }
  const query = mock.method(getDb(), 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  const app = express();
  app.use(express.json());
  app.use('/api/discover', discoverRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/discover`;
  const read = async (params: string) => {
    const response = await fetch(`${base}?${params}`);
    assert.equal(response.status, 200);
    const result = await response.json() as { success: boolean; data: { items: DiscoverItem[]; total: number } };
    assert.equal(result.success, true);
    return result.data;
  };
  const feedback = async (item: string, body: unknown) => {
    const response = await fetch(`${base}/${item}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, result: await response.json() as { success: boolean } };
  };
  try {
    for (const sort of ['weighted', 'editorial', 'latest']) {
      const first = await read(`sort=${sort}&pageSize=50&source=Fixture`);
      const second = await read(`sort=${sort}&pageSize=50&page=2&source=Fixture`);
      const third = await read(`sort=${sort}&pageSize=50&page=3&source=Fixture`);
      const all = [...first.items, ...second.items, ...third.items];
      assert.equal(first.total, 106);
      assert.equal(all.length, 106);
      assert.equal(new Set(all.map(item => item.id)).size, 106);
      assert.deepEqual((await read(`sort=${sort}&pageSize=50&source=Fixture`)).items.map(item => item.id), first.items.map(item => item.id));
      assert.equal(first.items[0]?.id, id(sort === 'editorial' ? 1 : sort === 'latest' ? 2 : 0));
      for (const item of all) {
        const f = item.rankFactors;
        const recomputed = (f.editorial ?? 0) * (f.recency ?? 0) * f.authority * f.articleType * f.project;
        assert.ok(Math.abs(Number(item.rankScore) * 100 - recomputed * 100) < 0.0001,
          `SQL factors agree well within the displayed 0.1-point rounding for ${item.id}: ${JSON.stringify({ rank: item.rankScore, recomputed, factors: f })}`);
        assert.ok(Number.isFinite(Date.parse(f.computedAt)));
      }
      const ties = all.filter(item => ![id(0), id(1), id(2)].includes(item.id));
      assert.deepEqual(ties.map(item => item.id), [...ties.map(item => item.id)].sort());
    }
    assert.ok(Number((await read('')).items[0]!.rankScore) > 1, 'Boosted ranks are not clamped');
    assert.equal((await read('title=50%25_literal')).items[0]?.id, id(104), 'Title wildcards are literal');
    assert.equal((await read('title=50%25_literal')).total, 1);
    assert.equal((await read('title=%27%20OR%201%3D1%20--')).total, 0);
    assert.equal((await read('state=saved')).total, 0);
    for (const params of ['sort=constructor', 'sort=invalid', 'sort=latest&sort=editorial', 'state=all', 'state=a&state=b',
      'source=a&source=b', 'title=a&title=b', 'page=NaN', 'page=9007199254740991', 'pageSize=0',
      `title=${'a'.repeat(257)}`]) {
      const response = await fetch(`${base}?${params}`);
      assert.ok(response.status >= 400 && response.status < 500, params);
      assert.equal((await response.json() as { success: boolean }).success, false);
    }
    const requestId = '11111111-1111-4111-8111-111111111111';
    const payload = { requestId, reason: 'too-high', explanation: 'Useful source, but too broad for this project.' };
    const concurrent = await Promise.all([feedback(id(0), payload), feedback(id(0), payload)]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 201]);
    assert.equal((await feedback(id(0), payload)).status, 200);
    assert.equal((await db.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM discover_feedback')).rows[0]?.count, 1);
    assert.equal((await feedback(id(0), { ...payload, reason: 'too-low' })).status, 409);
    assert.equal((await feedback(id(1), payload)).status, 409);
    assert.equal((await feedback(id(0), { ...payload, requestId: id(10), reason: 'invented' })).status, 422);
    assert.equal((await feedback(id(0), { ...payload, explanation: 'x'.repeat(2001) })).status, 422);
    assert.equal((await feedback(id(0), { ...payload, requestId: 'invalid' })).status, 422);
    assert.equal((await feedback(id(900), payload)).status, 404);
    const unchanged = await db.query<{ workflow_state: string; relevance_score: number }>(
      'SELECT workflow_state,relevance_score FROM content_items WHERE id=$1', [id(0)],
    );
    assert.equal(unchanged.rows[0]?.workflow_state, 'to-review');
    assert.ok(Math.abs(unchanged.rows[0]!.relevance_score - 0.9) < 0.000001);
    assert.equal((await db.query<{ reason: string }>('SELECT reason FROM discover_feedback')).rows[0]?.reason, 'too-high');
  } finally {
    query.mock.restore();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  }
});

test('Microsoft product-group blogs are official sources; Tech Community forum threads stay Community', async () => {
  const { classifySourceAuthority, classifySourceByUrl } = await import('../src/integrations/cms/articleScoringPrompt.js');
  const foundry = 'https://techcommunity.microsoft.com/t5/microsoft-foundry-blog/introducing-microsoft-decision-1-in-microsoft-foundry-for/ba-p/4562742';
  const studio = 'https://www.microsoft.com/en-us/copilot/blog/copilot-studio/build-where-you-want-run-with-confidence-now-microsoft-hosts-and-manages-the-code-created-by-copilot/';
  const forum = 'https://techcommunity.microsoft.com/t5/microsoft-365-copilot/how-do-i-reset-copilot/m-p/4562000';
  assert.equal(classifySourceAuthority(foundry, null), 'Microsoft/GitHub Official');
  assert.equal(classifySourceByUrl(foundry, 'Microsoft Foundry Blog'), 'Formal');
  assert.equal(classifySourceAuthority(studio, null), 'Microsoft/GitHub Official');
  assert.equal(classifySourceAuthority('https://github.blog/changelog/2026-10-07-local-sandboxing-for-github-copilot-now-generally-available', null), 'Microsoft/GitHub Official');
  assert.equal(classifySourceAuthority(forum, null), 'Community');
  assert.equal(classifySourceByUrl(forum, 'Tech Community'), 'Community');
});
