import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const { BLOG_PROMPT, digestWeekKey, digestDueAt, digestWindow, windowLabel, webHitsToArticles, gatherDigestArticles, formatDigestFacts, postToSlack } =
  await import('../src/ai/weeklyMicrosoftDigest.js');
const { parseTavilySearch, inWindow, normaliseDigestUrl } = await import('../src/ai/digestWebSearch.js');

test('digest covers the last full Monday–Sunday, UK midnight to UK midnight', () => {
  const w = digestWindow(new Date('2025-06-09T07:30:00Z'));
  assert.equal(w.firstDay, '2025-06-02');
  assert.equal(w.lastDay, '2025-06-08');
  assert.equal(w.start.toISOString(), '2025-06-01T23:00:00.000Z'); // BST
  assert.equal(w.end.toISOString(), '2025-06-08T23:00:00.000Z');
  assert.equal(windowLabel(w), 'Mon 2 Jun to Sun 8 Jun');
  const winter = digestWindow(new Date('2025-01-13T09:00:00Z'));
  assert.equal(winter.start.toISOString(), '2025-01-06T00:00:00.000Z'); // GMT
  assert.equal(winter.end.toISOString(), '2025-01-13T00:00:00.000Z');
  const clocksChange = digestWindow(new Date('2025-04-01T09:00:00Z')); // week of 24–30 Mar, BST starts 30 Mar
  assert.equal(clocksChange.start.toISOString(), '2025-03-24T00:00:00.000Z');
  assert.equal(clocksChange.end.toISOString(), '2025-03-30T23:00:00.000Z');
});

test('reads Tavily search results in JSON or text form, and keeps only the week', () => {
  const json = { result: JSON.stringify({ results: [
    { title: 'Azure news', url: 'https://azure.microsoft.com/blog/x/', content: 'Big   news', published_date: '2025-06-04T10:00:00Z' },
    { title: 'No url', url: '' },
  ] }) };
  const fromJson = parseTavilySearch(json);
  assert.deepEqual(fromJson, [{ title: 'Azure news', url: 'https://azure.microsoft.com/blog/x/', content: 'Big news', publishedAt: '2025-06-04T10:00:00Z' }]);
  const text = 'Detailed Results:\n\nTitle: GitHub thing\nURL: https://github.blog/changelog/y\nPublished Date: 2025-06-10\nContent: Hello\n\nTitle: Undated\nURL: https://example.com/z\nContent: Hi';
  const fromText = parseTavilySearch(text);
  assert.equal(fromText.length, 2);
  assert.equal(fromText[0]?.url, 'https://github.blog/changelog/y');
  const w = digestWindow(new Date('2025-06-09T07:30:00Z'));
  assert.equal(inWindow(fromJson[0]!, w, true), true);
  assert.equal(inWindow(fromText[0]!, w, true), false); // next week
  assert.equal(inWindow(fromText[1]!, w, true), true); // undated official page kept
  assert.equal(inWindow(fromText[1]!, w, false), false); // undated press dropped
  assert.equal(normaliseDigestUrl('https://www.Azure.microsoft.com/blog/x/?utm=1#a'), normaliseDigestUrl('http://azure.microsoft.com/blog/x'));
  const arts = webHitsToArticles([...fromJson, fromText[0]!], w);
  assert.deepEqual(arts.map((a) => [a.source, a.group]), [['Web search', 'Microsoft'], ['Web search', 'GitHub']]);
  const facts = formatDigestFacts(arts, windowLabel(w));
  assert.match(facts, /^2 Microsoft and GitHub updates from Mon 2 Jun to Sun 8 Jun\. 2 of them came from a web search/);
});

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

test('gathers every Microsoft/GitHub article from last Monday–Sunday, shelved included, best first', async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE content_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text, title text, url text,
    summary text, body text, metadata jsonb, published_at timestamptz, indexed_at timestamptz DEFAULT now())`);
  const now = new Date('2025-06-09T07:30:00Z');
  const rows: [string, string, string, number, string, boolean][] = [
    ['Azure thing', 'Microsoft', 'Microsoft Azure Blog', 0.6, '2025-06-05', false],
    ['Copilot thing', 'Microsoft', 'Microsoft 365 Blog', 0.9, '2025-06-06', true],
    ['GitHub thing', 'GitHub', 'The GitHub Blog', 0.7, '2025-06-04', false],
    ['AWS thing', 'AWS', 'AWS News Blog', 0.95, '2025-06-06', false],
    ['Old Azure thing', 'Microsoft', 'Microsoft Azure Blog', 0.99, '2025-05-20', false],
    ['This week Azure thing', 'Microsoft', 'Microsoft Azure Blog', 0.99, '2025-06-09T06:00:00Z', false],
  ];
  for (const [title, group, sourceTitle, score, date, shelved] of rows) {
    await pg.query(`INSERT INTO content_items (source, title, url, summary, metadata, published_at) VALUES ('discovered-article', $1, $2, $3, $4, $5)`,
      [title, `https://x.test/${title.replace(/ /g, '-')}`, `${title} summary`,
        JSON.stringify({ sourceGroup: group, sourceTitle, compositeScore: score, ...(shelved ? { shelvedAt: date } : {}) }), date]);
  }
  await pg.query(`INSERT INTO content_items (source, title, url, summary, body, metadata, published_at) VALUES ('discovered-article', $1, $2, $3, $4, $5, $6)`,
    ['Outlook: Themes retirement (MC1492954)', 'https://admin.microsoft.com/mc/MC1492954', 'via Microsoft 365 Message Center',
      'What and why\nWe are retiring Themes.', JSON.stringify({ sourceGroup: 'Microsoft', sourceTitle: 'Microsoft 365 Message Center', sourceId: 'message-center' }), '2025-06-07']);
  const db = { query: (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
  const articles = await gatherDigestArticles(db, now);
  assert.deepEqual(articles.map((a) => a.title), ['Copilot thing', 'GitHub thing', 'Azure thing', 'Outlook: Themes retirement (MC1492954)']);
  assert.match(articles[3]?.summary ?? '', /^What and why\nWe are retiring Themes\.$/);
  assert.equal(articles[0]?.shelved, true);
  assert.equal(articles[0]?.source, 'Microsoft 365 Blog');

  const facts = formatDigestFacts(articles);
  assert.match(facts, /^4 Microsoft and GitHub updates/);
  assert.match(facts, /## Microsoft 365 Message Center \(1\)\n- 2025-06-07 Outlook: Themes retirement \(MC1492954\)/);
  assert.match(facts, /## Microsoft 365 Blog \(1\)/);
  assert.match(facts, /2025-06-06 Copilot thing \[score 0\.9\] — https:\/\/x\.test\/Copilot-thing\n {2}Copilot thing summary/);
  await pg.close();
});

test('Slack is skipped without a webhook', async () => {
  assert.equal(await postToSlack('hi', undefined), false);
  assert.equal(await postToSlack('hi', ''), false);
});

test('blog prompt asks for the full CMS and social package', () => {
  for (const field of ['Title', 'Slug', 'Featured image URL', 'Image prompt', 'Content', 'Excerpt', 'Summary TL;DR',
    'Key takeaways', 'Categories', 'Tags', 'LinkedIn post', 'Twitter/X post']) {
    assert.ok(BLOG_PROMPT.includes(field), `missing ${field}`);
  }
  assert.match(BLOG_PROMPT, /AI, Copilot, Microsoft Azure, Bicep/);
  assert.match(BLOG_PROMPT, /Please ensure the image is in high resolution/);
});
