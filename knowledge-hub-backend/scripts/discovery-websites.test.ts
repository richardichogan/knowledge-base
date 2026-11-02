import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { websiteArticle, websiteCandidates, readWebsite, readSourcePage } from '../src/integrations/discovery/websiteReader.js';
import { readDiscoverySource } from '../src/integrations/discovery/sourceReader.js';
import { addDiscoverySource, recentDiscoveryArticles } from '../src/integrations/discovery/feedSync.js';
import { getDiscoverSources, inspectDiscoverFeed } from '../src/ai/discoveryContext.js';

const listingUrl = 'https://microsoft.ai/blog/';
// Microsoft AI uses /news/ article URLs, not children of /blog/.
const listing = `<html><body><header><h2><a href="/models/not-a-post">Model navigation</a></h2></header>
  <main><h2><a href="/news/medical/">Medical research</a></h2>
  <h2><a href="/news/medical/?utm_source=duplicate#title">Medical research</a></h2>
  <h2><a href="/news/image/">Image model</a></h2>
  <nav><h2><a href="/login">Sign in</a></h2></nav></main></body></html>`;
const articleHtml = (date = '2026-10-29T10:00:00Z') => `<html><head>
  <meta property="article:published_time" content="${date}">
  <meta property="og:title" content="Medical &amp; AI">
  <meta property="og:description" content="A publisher-authored summary.">
  <link rel="canonical" href="/news/medical/"></head><body><h1>Medical research</h1></body></html>`;

test('listing extraction is reusable, resolves links and ignores navigation and duplicate tracking URLs', () => {
  const found = websiteCandidates(listing, listingUrl);
  assert.deepEqual(found.articles.map(article => article.url), ['https://microsoft.ai/news/medical/', 'https://microsoft.ai/news/image/']);
  const other = websiteCandidates('<html><body><main><a href="/posts/hello"><h3>Hello</h3></a></main></body></html>', 'https://other.example/blog');
  assert.equal(other.articles[0]?.url, 'https://other.example/posts/hello');
  assert.throws(() => websiteCandidates('<html><body><div id="app"></div></body></html>', listingUrl), /No readable article listing/);
  assert.throws(() => websiteCandidates('<html><main><h2><a href="javascript:alert(1)">Unsafe</a></h2></main></html>', listingUrl), /No readable/);
});

test('publication metadata is article-specific, never a modified, unrelated or retrieved date', () => {
  const article = websiteArticle(articleHtml(), 'https://microsoft.ai/news/medical/?utm_source=x', 'Fallback');
  assert.equal(article?.publishedAt?.toISOString(), '2026-10-29T10:00:00.000Z');
  assert.equal(article?.title, 'Medical & AI');
  assert.equal(article?.url, 'https://microsoft.ai/news/medical/');
  assert.equal(article?.summary, 'A publisher-authored summary.');
  const schema = (value: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(value)}</script></head></html>`;
  assert.equal(websiteArticle(schema({ '@type': 'WebPage', datePublished: '2026-10-29' }), listingUrl, 'Page'), null);
  const yoast = schema({ '@type': 'WebPage', url: 'https://microsoft.ai/news/model/', datePublished: '2026-10-27T15:10:00+00:00', dateModified: '2026-10-28' })
    .replace('<head>', '<head><meta property="og:type" content="article">');
  assert.equal(websiteArticle(yoast, 'https://microsoft.ai/news/model/', 'Model')?.publishedAt?.toISOString(), '2026-10-27T15:10:00.000Z');
  assert.equal(websiteArticle(yoast, listingUrl, 'Listing'), null, 'A different page cannot lend its date');
  assert.equal(websiteArticle('<html><meta property="article:modified_time" content="2026-10-29"></html>', listingUrl, 'Page'), null);
  assert.equal(websiteArticle(schema({ '@type': 'BlogPosting', url: '/different', datePublished: '2026-10-29' }), listingUrl, 'Page'), null);
  assert.equal(websiteArticle(schema({ '@type': 'BlogPosting', dateModified: '2026-10-29' }), listingUrl, 'Page'), null);
  assert.equal(websiteArticle(schema({ '@graph': [{ '@type': 'BlogPosting', datePublished: '2026-10-28' }] }), listingUrl, 'Page')?.publishedAt?.toISOString(), '2026-10-28T00:00:00.000Z');
});

test('website checks return dated articles and visible undated, partial failure and bounded-coverage warnings', async () => {
  const result = await readWebsite({ text: listing, url: listingUrl }, async url => ({
    url, text: url.includes('/medical/') ? articleHtml() : '<html><h1>Undated</h1></html>',
  }));
  assert.equal(result.articles.length, 1);
  assert.match(result.warning!, /1 article\(s\) skipped/);
  const links = Array.from({ length: 35 }, (_, i) => `<h2><a href="/news/${i}">Article ${i}</a></h2>`).join('');
  let reads = 0;
  const bounded = await readWebsite({ text: `<html><main>${links}</main></html>`, url: listingUrl }, async url => {
    reads++;
    if (url.endsWith('/0')) throw new Error('HTTP 503');
    return { url, text: articleHtml() };
  });
  assert.equal(reads, 30);
  assert.match(bounded.warning!, /Only the first 30/);
  assert.match(bounded.warning!, /1 article page/);
  assert.equal(bounded.articles.length, 1, 'Canonical aliases collapse to one article');
  await assert.rejects(readWebsite({ text: listing, url: listingUrl }, async () => { throw new Error('HTTP 503'); }), /None of the listed articles/);
});

test('automatic source detection preserves RSS and YouTube and does not fall back after an RSS failure', async () => {
  const rss = '<rss><channel><item><title>Feed article</title><link>https://example.org/post</link><pubDate>Thu, 29 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  const feed = await readDiscoverySource('https://example.org/feed', async url => ({ url, text: rss }));
  assert.equal(feed.sourceKind, 'feed');
  assert.equal(feed.articles[0]?.title, 'Feed article');
  const youtube = await readDiscoverySource('https://youtube.com/channel/UC0m-80FnNY2Qb7obvTL_2fA', async url => ({ url, text: rss }));
  assert.equal(youtube.feedUrl, 'https://www.youtube.com/feeds/videos.xml?channel_id=UC0m-80FnNY2Qb7obvTL_2fA');
  const site = await readDiscoverySource(listingUrl, async url => ({ url, text: url === listingUrl ? listing : articleHtml() }));
  assert.equal(site.sourceKind, 'website');
  assert.equal(site.articles.length, 1);
  await assert.rejects(readDiscoverySource(listingUrl, async () => { throw new Error('HTTP 403'); }), /HTTP 403/);
  await assert.rejects(readDiscoverySource(listingUrl, async url => ({ url, text: 'Not a listing' })), /Not an RSS/);
});

test('website sources cannot make old or undated pages look new and use exactly the existing 14-day window', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const article = { title: 'Post', url: 'https://example.org/post', summary: '' };
  const articles = [null, new Date('2026-10-19T11:59:59Z'), new Date('2026-10-19T12:00:00Z'), new Date('2026-11-05')].map(publishedAt => ({ ...article, publishedAt }));
  const recent = recentDiscoveryArticles(articles, 'website', now);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.publishedAt.toISOString(), '2026-10-19T12:00:00.000Z');
  assert.equal(recent[0]?.publicationDateKnown, true);
  assert.equal(recentDiscoveryArticles([{ ...article, publishedAt: null }], 'feed', now)[0]?.publicationDateKnown, false, 'Existing feed date fallback is unchanged');
});

test('public fetch rejects private addresses before a network request', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  try {
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/']) await assert.rejects(readSourcePage(url), /not on the public internet/);
    assert.equal(fetch.mock.callCount(), 0);
  } finally { fetch.mock.restore(); }
});

test('additive migration is idempotent and shared source management exposes website warnings to Athena', async () => {
  const pg = new PGlite();
  const db = new Pool();
  const query = mock.method(db, 'query', async (sql: string, values?: unknown[]) => pg.query(sql, values));
  try {
    await pg.exec(`CREATE TABLE discovery_sources (
      id text PRIMARY KEY DEFAULT 'website-source', title text NOT NULL, feed_url text UNIQUE NOT NULL, group_name text,
      is_active boolean DEFAULT true, last_checked_at timestamptz, last_success_at timestamptz, last_error text,
      last_new_count integer DEFAULT 0, articles_found integer DEFAULT 0);
      INSERT INTO discovery_sources (id,title,feed_url,group_name,is_active) VALUES ('old','Old feed','https://old.example/rss','Other',false)`);
    const migration = readFileSync(new URL('../src/db/migrations/138_discovery_websites.sql', import.meta.url), 'utf8');
    await pg.exec(migration); await pg.exec(migration);
    const reader = async (feedUrl: string) => ({ feedUrl, sourceKind: 'website' as const, warning: '1 article skipped: no date.', articles: [] });
    const saved = await addDiscoverySource(db, 'Microsoft AI', listingUrl, 'Microsoft', reader);
    assert.equal(saved.sourceKind, 'website');
    assert.match(saved.lastWarning!, /no date/);
    await addDiscoverySource(db, 'Microsoft AI renamed', listingUrl, 'Microsoft', reader);
    const sources = await getDiscoverSources(db);
    assert.equal(sources.sources.length, 2, 'Adding twice updates the subscription, not another source');
    assert.equal(sources.sources.find(source => source.id === 'old')?.active, false);
    assert.equal(sources.sources.find(source => source.id === saved.id)?.lastWarning, saved.lastWarning);
    const inspection = await inspectDiscoverFeed(db, 'https://other.example/blog', reader);
    assert.ok('sourceKind' in inspection && inspection.sourceKind === 'website');
    assert.ok('warning' in inspection && inspection.warning?.includes('no date'));
  } finally { query.mock.restore(); await db.end(); await pg.close(); }
});
