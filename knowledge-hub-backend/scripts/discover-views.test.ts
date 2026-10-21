import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { discoverRouter, type DiscoverItem } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { CONTENT_FORMATS, formatFitSql } from '../src/integrations/cms/formatFit.js';
import { isMicrosoftRelevant } from '../src/utils/microsoftRelevance.js';
import { buildRelevanceSystemPrompt, classifySourceAuthority, SOURCE_AUTHORITY_WEIGHTS } from '../src/integrations/cms/articleScoringPrompt.js';

test('editorial brief prioritises Microsoft publishing relevance without blanket vendor scores', () => {
  const prompt = buildRelevanceSystemPrompt([]);
  assert.match(prompt, /Microsoft first, not Microsoft only/);
  assert.match(prompt, /AWS, Google Cloud\/GCP, Cloudflare or OpenAI/);
  assert.match(prompt, /Competitor and wider ecosystem stories can still outrank Microsoft stories/);
  assert.match(prompt, /Do not award automatic high scores, minimum scores/);
  assert.match(prompt, /No Microsoft connection = 0/);
  assert.doesNotMatch(prompt, /the VENDOR does not matter|This vendor-neutral rule/);
  assert.match(prompt, /Apply this equally to articles and videos, including GitHub/);
  assert.match(prompt, /Give them audienceFit 3/);
  assert.ok(SOURCE_AUTHORITY_WEIGHTS['Microsoft/GitHub Official'] >= 1.6 * SOURCE_AUTHORITY_WEIGHTS['Vendor Official']);
  assert.equal(classifySourceAuthority('https://github.blog/news-insights/test', null), 'Microsoft/GitHub Official');
  assert.equal(classifySourceAuthority('https://www.microsoft.com/en-us/research/blog/test', null), 'Microsoft/GitHub Official');
  const feed = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC0m-80FnNY2Qb7obvTL_2fA';
  assert.equal(classifySourceAuthority('https://www.youtube.com/watch?v=example', feed), 'Microsoft/GitHub Official');
  assert.equal(classifySourceAuthority(null, feed.replace('www.youtube.com', 'youtube.com.example.com')), 'Unknown');
});

test('podcast fit requires Microsoft evidence, including stored and legacy recommendations', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE content_items (id INTEGER PRIMARY KEY, title TEXT, url TEXT, body TEXT,
      metadata JSONB, relevance_explanation TEXT);`);
    const cases = [
      { title: 'OpenAI assistant burns tokens', url: 'https://example.com/openai', body: 'An enterprise AI debate.', expected: 0 },
      { title: 'Microsoft changes Copilot licensing', url: 'https://example.com/news', body: 'Enterprise cost implications.', expected: 3 },
      { title: 'AI competition inquiry', url: 'https://example.com/news', body: 'The inquiry concerns Microsoft licensing.', expected: 3 },
      { title: 'Enterprise AI governance', url: 'https://www.microsoft.com/blog/governance', body: 'Enterprise AI adoption.', expected: 3 },
      { title: 'Generic AI debate', url: 'https://microsoft.com.example.com/news?ref=azure.com', body: 'General industry news.', expected: 0 },
    ];
    for (const [index, item] of cases.entries()) {
      assert.equal(isMicrosoftRelevant({ title: item.title, url: item.url, text: item.body }), item.expected > 0);
      for (const stored of [false, true]) {
        await db.query(`INSERT INTO content_items VALUES ($1,$2,$3,$4,$5,'Scored')`,
          [index * 2 + Number(stored), item.title, item.url, item.body,
            JSON.stringify({ platform: 'Podcast Topic', compositeScore: 7,
              ...(stored ? { formatFit: { podcast: 3 } } : {}) })]);
      }
    }
    const fit = formatFitSql('ci', 'podcast');
    const result = await db.query<{ id: number; fit: number }>(`SELECT id, ${fit} AS fit FROM content_items ci ORDER BY id`);
    assert.deepEqual(result.rows.map(r => r.fit), cases.flatMap(c => [c.expected, c.expected]));
    const filtered = await db.query<{ id: number }>(`SELECT id FROM content_items ci WHERE ${fit} >= 1 ORDER BY ${fit} DESC, id`);
    assert.deepEqual(filtered.rows.map(r => r.id), [2, 3, 4, 5, 6, 7]);
    const formats = await db.query<Record<string, number>>(`SELECT ${
      CONTENT_FORMATS.map(f => `${formatFitSql('ci', f)} AS "fit_${f}"`).join(', ')
    } FROM content_items ci WHERE id = 2`);
    for (const format of CONTENT_FORMATS) assert.ok(Number.isFinite(formats.rows[0]?.[`fit_${format}`]));
  } finally { await db.close(); }
});

test('Discovery sorts are stable across filtered pages, factors explain the SQL rank', async () => {
  const db = new PGlite();
  const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  await db.exec(`CREATE TABLE content_items (
    id UUID PRIMARY KEY, source TEXT, source_id TEXT, title TEXT, url TEXT, body TEXT,
    published_at TIMESTAMPTZ NOT NULL, indexed_at TIMESTAMPTZ DEFAULT NOW(), metadata JSONB DEFAULT '{}',
    workflow_state TEXT DEFAULT 'to-review', relevance_score REAL, relevance_explanation TEXT);
    CREATE TABLE discover_item_tags (discover_item_id UUID, tag_id UUID);`);
  await db.exec(await readFile(new URL('../src/db/migrations/087_discover_parking.sql', import.meta.url), 'utf8'));
  await db.exec(`CREATE TABLE discover_interest_weights(kind TEXT,term TEXT,weight REAL);`);
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
    const removed = await fetch(`${base}/${id(0)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(removed.status, 404, 'Discovery feedback endpoint was removed');
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
