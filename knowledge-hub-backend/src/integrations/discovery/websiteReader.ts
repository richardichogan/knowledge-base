import { parseDocument, DomUtils } from 'htmlparser2';
import { cleanUrl, fetchPublic, toPlainSummary, type FeedArticle } from './feedReader.js';
import { rethrowAssignmentControl } from '../../agents/workforce/modelBudget.js';

type HtmlNode = ReturnType<typeof parseDocument>['children'][number];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; AthenaFeedReader/1.0; +https://athena.themicrosoftcloudblog.com)', Accept: 'text/html, application/rss+xml, application/atom+xml, application/xml' };
const MAX_SOURCE_BYTES = 6_000_000;
const SOURCE_TIMEOUT_MS = 25_000;
const MAX_WEBSITE_ARTICLES = 30;
const ARTICLE_CONCURRENCY = 5;
const ARTICLE_TIMEOUT_MS = 5_000;
const MAX_MARKUP_DEPTH = 200;
const EXCLUDED = new Set(['nav', 'header', 'footer', 'aside', 'script', 'style', 'template']);
const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'TechArticle']);

export interface SourcePage { text: string; url: string }
export interface WebsiteRead { articles: FeedArticle[]; warning: string | null }

/** Reuses the feed reader's public-address and redirect checks; bounds streamed bytes. */
export async function readSourcePage(url: string, timeoutMs = SOURCE_TIMEOUT_MS): Promise<SourcePage> {
  const response = await fetchPublic(url, { headers: HEADERS, timeoutMs });
  if (!response.ok || !response.body) throw new Error(`Source returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) throw new Error('Source page is too large to read safely.');
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), url: response.url || url };
  } finally { await reader.cancel(); }
}

function documentOf(html: string): ReturnType<typeof parseDocument> {
  const doc = parseDocument(html);
  const queue: Array<{ node: HtmlNode; depth: number }> = doc.children.map(node => ({ node, depth: 0 }));
  while (queue.length) {
    const entry = queue.pop()!;
    if (entry.depth > MAX_MARKUP_DEPTH) throw new Error('Source markup is too deeply nested.');
    if ('children' in entry.node) {
      for (const node of entry.node.children) queue.push({ node, depth: entry.depth + 1 });
    }
  }
  return doc;
}

function publicLink(value: string, base: string): string | null {
  let url: URL;
  try { url = new URL(value.trim(), base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (/\.(?:png|jpe?g|gif|svg|webp|pdf|zip|mp4)$/i.test(url.pathname)) return null;
  return cleanUrl(url.toString());
}

function identity(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

function meta(doc: ReturnType<typeof parseDocument>, key: string): string {
  return DomUtils.findAll(element => element.name === 'meta'
    && (element.attribs['property'] ?? element.attribs['name'] ?? element.attribs['itemprop'])?.toLowerCase() === key.toLowerCase(), doc.children)[0]?.attribs['content'] ?? '';
}

function records(doc: ReturnType<typeof parseDocument>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const script of DomUtils.findAll(element => element.name === 'script' && element.attribs['type'] === 'application/ld+json', doc.children)) {
    let data: unknown;
    try { data = JSON.parse(DomUtils.textContent(script)); }
    catch { continue; } // Malformed optional structured data must not hide valid HTML articles.
    const queue: unknown[] = [data];
    while (queue.length) {
      const value = queue.pop();
      if (Array.isArray(value)) { for (const child of value) queue.push(child); }
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        result.push(record);
        for (const child of Object.values(record)) if (child && typeof child === 'object') queue.push(child);
      }
    }
  }
  return result;
}

function isArticle(record: Record<string, unknown>): boolean {
  const types = record['@type'];
  return (Array.isArray(types) ? types : [types]).some(type => typeof type === 'string' && ARTICLE_TYPES.has(type.replace(/^https?:\/\/schema.org\//, '')));
}

function publicationDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/\b\d{4}\b/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Only article-specific publication evidence is accepted, never dateModified or page retrieval time. */
export function websiteArticle(html: string, url: string, fallbackTitle: string): FeedArticle | null {
  const doc = documentOf(html);
  const isArticlePage = meta(doc, 'og:type') === 'article';
  const structuredArticles = records(doc).filter(record => {
    const ownUrl = record['url'] ?? record['@id'];
    const resolved = typeof ownUrl === 'string' ? publicLink(ownUrl, url) : null;
    const matchesPage = resolved !== null && identity(resolved) === identity(url);
    // Yoast can describe an actual article as WebPage; require both article OG
    // metadata and an exact page identity before using its publication date.
    const articlePage = record['@type'] === 'WebPage' && isArticlePage && matchesPage;
    return (isArticle(record) || articlePage) && (ownUrl === undefined || matchesPage);
  });
  const times = DomUtils.findAll(element => element.name === 'time'
    && (element.attribs['itemprop'] === 'datePublished' || 'pubdate' in element.attribs), doc.children);
  if (!times.length) {
    for (const article of DomUtils.findAll(element => element.name === 'article', doc.children)) {
      const candidates = DomUtils.findAll(element => element.name === 'time' && Boolean(element.attribs['datetime'])
        && !/modified|updated/i.test(`${element.attribs['itemprop'] ?? ''} ${element.attribs['class'] ?? ''}`), article.children);
      if (candidates.length === 1) times.push(candidates[0]!);
    }
  }
  const time = times.length === 1 ? times[0] : undefined;
  const publishedAt = publicationDate(meta(doc, 'article:published_time'))
    ?? publicationDate(meta(doc, 'datePublished'))
    ?? structuredArticles.map(record => publicationDate(record['datePublished'])).find(date => date !== null)
    ?? publicationDate(time?.attribs['datetime'] ?? (time ? DomUtils.textContent(time) : ''));
  if (!publishedAt) return null;
  const h1 = DomUtils.findAll(element => element.name === 'h1', doc.children)[0];
  const title = toPlainSummary(meta(doc, 'og:title') || (h1 ? DomUtils.textContent(h1) : '') || fallbackTitle);
  if (!title) return null;
  const canonical = DomUtils.findAll(element => element.name === 'link' && element.attribs['rel']?.toLowerCase() === 'canonical', doc.children)[0]?.attribs['href'];
  const canonicalUrl = canonical ? publicLink(canonical, url) : null;
  return {
    title, url: canonicalUrl && new URL(canonicalUrl).origin === new URL(url).origin ? canonicalUrl : cleanUrl(url),
    publishedAt, summary: toPlainSummary(meta(doc, 'og:description') || meta(doc, 'description')
      || (typeof structuredArticles[0]?.['description'] === 'string' ? structuredArticles[0]['description'] : '')),
  };
}

export function websiteCandidates(html: string, url: string): { articles: Array<{ title: string; url: string }>; truncated: boolean } {
  const doc = documentOf(html);
  const mains = DomUtils.findAll(element => element.name === 'main' || element.attribs['role'] === 'main', doc.children);
  const roots = mains.length ? mains : doc.children;
  const found = new Map<string, { title: string; url: string }>();
  const add = (href: string, title: string): void => {
    const link = publicLink(href, url);
    if (!link || identity(link) === identity(url) || !title.trim()) return;
    found.set(identity(link), { title: toPlainSummary(title), url: link });
  };
  for (const heading of DomUtils.findAll(element => /^h[23]$/.test(element.name), roots)) {
    let parent: HtmlNode | null = heading;
    let excluded = false;
    while (parent) {
      if ('name' in parent && EXCLUDED.has(parent.name)) { excluded = true; break; }
      parent = parent.parent;
    }
    if (excluded) continue;
    const link = DomUtils.findAll(element => element.name === 'a' && Boolean(element.attribs['href']), heading.children)[0];
    if (link) add(link.attribs['href']!, DomUtils.textContent(heading));
    else {
      let ancestor = heading.parent;
      while (ancestor && 'name' in ancestor && !['a', 'article', 'main', 'body'].includes(ancestor.name)) ancestor = ancestor.parent;
      if (ancestor && 'name' in ancestor && ancestor.name === 'a') add(ancestor.attribs['href'] ?? '', DomUtils.textContent(heading));
    }
  }
  for (const record of records(doc).filter(isArticle)) {
    if (typeof record['url'] === 'string' && typeof record['headline'] === 'string') add(record['url'], record['headline']);
  }
  if (!found.size) throw new Error('No readable article listing found. Use a public blog listing with linked article headings; JavaScript-only pages and login-protected sites are not supported.');
  return { articles: [...found.values()].slice(0, MAX_WEBSITE_ARTICLES), truncated: found.size > MAX_WEBSITE_ARTICLES };
}

export async function readWebsite(page: SourcePage, reader = readSourcePage): Promise<WebsiteRead> {
  const listing = websiteCandidates(page.text, page.url);
  const articles: FeedArticle[] = [];
  let cursor = 0, undated = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(ARTICLE_CONCURRENCY, listing.articles.length) }, async () => {
    while (cursor < listing.articles.length) {
      const candidate = listing.articles[cursor++]!;
      try {
        const detail = await reader(candidate.url, ARTICLE_TIMEOUT_MS);
        const article = websiteArticle(detail.text, detail.url, candidate.title);
        if (article) articles.push(article);
        else undated++;
      } catch (error) {
        rethrowAssignmentControl(error);
        failed++;
        console.warn(`[Discovery] Website article ${candidate.url} could not be read:`, error instanceof Error ? error.message : error);
      }
    }
  }));
  if (failed === listing.articles.length) throw new Error('None of the listed articles could be read. Check the website status and try again.');
  const warnings = [
    undated ? `${undated} article(s) skipped: no verified publication date.` : '',
    failed ? `${failed} article page(s) could not be read; they will be retried on the next check.` : '',
    listing.truncated ? `Only the first ${MAX_WEBSITE_ARTICLES} unique article links were checked.` : '',
  ].filter(Boolean);
  const unique = new Map(articles.sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime()).map(article => [identity(article.url), article]));
  return { articles: [...unique.values()], warning: warnings.join(' ') || null };
}
