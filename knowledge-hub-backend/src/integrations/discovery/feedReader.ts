/**
 * integrations/discovery/feedReader.ts — reads an RSS or Atom feed into plain
 * articles (title, link, short text summary, published date).
 */
import { XMLParser } from 'fast-xml-parser';
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

export interface FeedArticle {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date | null;
}

const FEED_TIMEOUT_MS = 25_000;
const MAX_FEED_BYTES = 6_000_000;
const SUMMARY_MAX_CHARS = 700;
const USER_AGENT = 'Mozilla/5.0 (compatible; AthenaFeedReader/1.0; +https://athena.themicrosoftcloudblog.com)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Entities are decoded by decodeEntities() below; the parser's own expansion has a
  // low limit that rejects feeds full of HTML entities (AWS, Google Cloud, Tech Community).
  processEntities: false,
});

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML (or entity-encoded HTML) → short plain text, cut at a sentence or word boundary. */
export function toPlainSummary(raw: string): string {
  const text = decodeEntities(decodeEntities(raw))
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const cut = text.slice(0, SUMMARY_MAX_CHARS);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > 200) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${space > 200 ? cut.slice(0, space) : cut}…`;
}

function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    return textOf(o['#text'] ?? o['__cdata']);
  }
  return '';
}

/** Removes tracking parameters so the same article isn't seen twice under different links. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|ref_$|cmpid|cmp$|trk$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function linkOf(item: Record<string, unknown>): string {
  const link = item['link'];
  if (typeof link === 'string' && link.trim() !== '') return link;
  if (Array.isArray(link)) {
    const alt = (link as Array<Record<string, unknown>>).find((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate');
    const href = (alt ?? (link as Array<Record<string, unknown>>)[0])?.['@_href'];
    if (typeof href === 'string') return href;
  }
  if (link !== null && typeof link === 'object') {
    const o = link as Record<string, unknown>;
    if (typeof o['@_href'] === 'string') return o['@_href'];
    const t = textOf(o);
    if (t !== '') return t;
  }
  const guid = item['guid'] ?? item['id'];
  const g = textOf(guid);
  return /^https?:\/\//i.test(g) ? g : '';
}

function parseDate(...candidates: unknown[]): Date | null {
  for (const c of candidates) {
    const t = textOf(c);
    if (t === '') continue;
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

// ── Only public addresses: feed addresses can be typed in, so a server-side fetch must not reach internal ones ──

function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIPv6(address)) {
    const v = address.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return true;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('not a valid address'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https addresses are allowed');
  if (url.username !== '' || url.password !== '') throw new Error('addresses with a login are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIPv4(host) || isIPv6(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new Error('could not find that host'); })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error('that address is not on the public internet');
  return url;
}

const MAX_REDIRECTS = 5;

/** fetch that follows redirects itself, checking every hop is a public address. */
async function fetchPublic(raw: string, init: { headers: Record<string, string>; timeoutMs: number }): Promise<Response> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, { headers: init.headers, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs) });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    return response;
  }
  throw new Error('too many redirects');
}

export async function readFeed(feedUrl: string): Promise<FeedArticle[]> {
  const response = await fetchPublic(feedUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    timeoutMs: FEED_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status.toString()}`);
  const xml = await response.text();
  if (xml.length > MAX_FEED_BYTES) throw new Error('feed is too large');
  if (!/<(rss|feed|rdf:RDF)\b/i.test(xml.slice(0, 2_000))) throw new Error('not an RSS or Atom feed');

  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc['rss'] as Record<string, unknown> | undefined;
  const channel = rss?.['channel'] as Record<string, unknown> | undefined;
  const atom = doc['feed'] as Record<string, unknown> | undefined;
  const rdf = doc['rdf:RDF'] as Record<string, unknown> | undefined;
  const rawItems = channel?.['item'] ?? atom?.['entry'] ?? rdf?.['item'] ?? [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]) as Array<Record<string, unknown>>;

  const articles: FeedArticle[] = [];
  for (const item of items) {
    const url = cleanUrl(linkOf(item));
    const title = decodeEntities(textOf(item['title'])).replace(/\s+/g, ' ').trim();
    if (url === '' || !/^https?:\/\//i.test(url) || title === '') continue;
    const body = textOf(item['description']) || textOf(item['summary']) || textOf(item['content:encoded']) || textOf(item['content']);
    articles.push({
      title,
      url,
      summary: toPlainSummary(body),
      publishedAt: parseDate(item['pubDate'], item['dc:date'], item['published'], item['updated'], item['date']),
    });
  }
  return articles;
}

const PAGE_TIMEOUT_MS = 10_000;
const PAGE_READ_BYTES = 300_000;

function metaContent(html: string, key: string): string {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0] ?? '';
  return /content=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
}

/** For feeds that publish titles only: the page's own summary line (og:description / meta description). */
export async function fetchPageDescription(url: string): Promise<string> {
  try {
    const response = await fetchPublic(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, timeoutMs: PAGE_TIMEOUT_MS });
    if (!response.ok || response.body === null) return '';
    const reader = response.body.getReader();
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < PAGE_READ_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    void reader.cancel().catch(() => undefined);
    const description = metaContent(html, 'og:description') || metaContent(html, 'description') || metaContent(html, 'twitter:description');
    return toPlainSummary(description);
  } catch {
    return '';
  }
}
