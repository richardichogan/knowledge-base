import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const { digestWeekKey, digestDueAt, gatherDigestArticles, formatDigestFacts, postToSlack } = await import('../src/ai/weeklyMicrosoftDigest.js');

test('week key is the UK Monday of the week', () => {
  assert.equal(digestWeekKey(new Date('2025-06-09T07:30:00Z')), '2025-06-09'); // Monday 08:30 BST
  assert.equal(digestWeekKey(new Date('2025-06-15T22:00:00Z')), '2025-06-09'); // Sunday 23:00 BST
  assert.equal(digestWeekKey(new Date('2025-06-15T23:30:00Z')), '2025-06-16'); // Monday 00:30 BST
});

test('due only on Monday 08:00–18:00 UK, once per week', () => {
  const mon0830 = new Date('2025-06-09T07:30:00Z');
  assert.equal(digestDueAt(null, mon0830), true);
  assert.equal(digestDueAt('2025-06-02', mon0830), true);
  assert.equal(digestDueAt('2025-06-09', mon0830), false);
  assert.equal(digestDueAt(null, new Date('2025-06-09T06:30:00Z')), false); // 07:30 BST
  assert.equal(digestDueAt(null, new Date('2025-06-09T17:30:00Z')), false); // 18:30 BST
  assert.equal(digestDueAt(null, new Date('2025-06-10T07:30:00Z')), false); // Tuesday
});

test('gathers every Microsoft/GitHub article from the last week, shelved included, best first', async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE content_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text, title text, url text,
    summary text, metadata jsonb, published_at timestamptz, indexed_at timestamptz DEFAULT now())`);
  const now = new Date('2025-06-09T07:30:00Z');
  const rows: [string, string, string, number, string, boolean][] = [
    ['Azure thing', 'Microsoft', 'Microsoft Azure Blog', 0.6, '2025-06-05', false],
    ['Copilot thing', 'Microsoft', 'Microsoft 365 Blog', 0.9, '2025-06-06', true],
    ['GitHub thing', 'GitHub', 'The GitHub Blog', 0.7, '2025-06-04', false],
    ['AWS thing', 'AWS', 'AWS News Blog', 0.95, '2025-06-06', false],
    ['Old Azure thing', 'Microsoft', 'Microsoft Azure Blog', 0.99, '2025-05-20', false],
  ];
  for (const [title, group, sourceTitle, score, date, shelved] of rows) {
    await pg.query(`INSERT INTO content_items (source, title, url, summary, metadata, published_at) VALUES ('discovered-article', $1, $2, $3, $4, $5)`,
      [title, `https://x.test/${title.replace(/ /g, '-')}`, `${title} summary`,
        JSON.stringify({ sourceGroup: group, sourceTitle, compositeScore: score, ...(shelved ? { shelvedAt: date } : {}) }), date]);
  }
  const db = { query: (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
  const articles = await gatherDigestArticles(db, now);
  assert.deepEqual(articles.map((a) => a.title), ['Copilot thing', 'GitHub thing', 'Azure thing']);
  assert.equal(articles[0]?.shelved, true);
  assert.equal(articles[0]?.source, 'Microsoft 365 Blog');

  const facts = formatDigestFacts(articles);
  assert.match(facts, /^3 Microsoft and GitHub updates/);
  assert.match(facts, /## Microsoft 365 Blog \(1\)/);
  assert.match(facts, /2025-06-06 Copilot thing \[score 0\.9\] — https:\/\/x\.test\/Copilot-thing\n {2}Copilot thing summary/);
  await pg.close();
});

test('Slack is skipped without a webhook', async () => {
  assert.equal(await postToSlack('hi', undefined), false);
  assert.equal(await postToSlack('hi', ''), false);
});
