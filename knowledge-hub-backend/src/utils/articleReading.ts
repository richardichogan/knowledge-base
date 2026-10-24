import { decodeEntities, fetchPublic } from '../integrations/discovery/feedReader.js';

const MAX_PAGE_BYTES = 2_000_000;
const PAGE_TIMEOUT_MS = 10_000;
const MAX_READING_CHARS = 60_000;
const EXCERPT_PARTS = 3;
const HALF = 0.5;
const MIN_REGION_CHARS = 800;
const ARTICLE_BODY_CAPTURE_GROUP = 2;

/** Strip navigation before extracting prose; never mistake metadata for the article. */
export function articleProse(html: string, url?: string): string {
  if (url && new URL(url).hostname === 'techcommunity.microsoft.com') {
    const pageData = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!pageData) throw new Error('Tech Community page does not contain __NEXT_DATA__ article data');
    const data: unknown = JSON.parse(pageData[1]!);
    const object = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const state = object(object(object(object(data).props).pageProps).apolloState);
    const id = /\/(\d+)\/?$/.exec(new URL(url).pathname)?.[1];
    if (!id) throw new Error('Tech Community URL does not contain an article ID');
    const article = object(state[`BlogTopicMessage:message:${id}`]);
    if (typeof article.body !== 'string' || !article.body.trim()) {
      throw new Error('Tech Community page data does not contain the requested article body');
    }
    return articleProse(article.body);
  }
  const cleaned = html.replace(/<(script|style|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const prose = (fragment: string): string => decodeEntities(fragment.replace(/<\/(?:p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  // Pages often contain several <article>/<main> elements (headers, bylines, cards); use the longest body.
  const regions = [...cleaned.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => prose(m[ARTICLE_BODY_CAPTURE_GROUP] ?? ''));
  const best = regions.reduce((a, b) => (b.length > a.length ? b : a), '');
  return best.length >= MIN_REGION_CHARS ? best : prose(cleaned);
}

/** Include the middle and conclusion of long writing, not just its opening. */
export function readingExcerpt(text: string, maxChars = MAX_READING_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const part = Math.floor(maxChars / EXCERPT_PARTS);
  const middle = Math.floor(text.length * HALF);
  return {
    text: `${text.slice(0, part)}\n[Excerpt boundary]\n${text.slice(middle - Math.floor(part * HALF), middle + Math.floor(part * HALF))}\n[Excerpt boundary]\n${text.slice(-part)}`,
    truncated: true,
  };
}

/** Shared public-page read for article Sparks and chat; redirects and byte buffering are bounded. */
export async function readPublicPage(url: string): Promise<{ title: string; text: string; finalUrl?: string }> {
  const response = await fetchPublic(url, {
    headers: { 'User-Agent': 'AthenaArticleReader/1.0', Accept: 'text/html, text/plain, application/json, application/xml, text/xml' }, timeoutMs: PAGE_TIMEOUT_MS,
  });
  if (!response.ok || !response.body) throw new Error(`Page returned HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/(?:html|plain|xml)|application\/(?:json|xml)/i.test(type)) throw new Error('Page is not readable text');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PAGE_BYTES) throw new Error('Page exceeds the safe reading size');
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally { await reader.cancel(); }
  const html = /text\/html/i.test(type);
  return { title: html ? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1] ?? new URL(url).hostname) : new URL(url).hostname,
    text: html ? articleProse(raw, response.url || url) : raw.trim(), finalUrl: response.url || url };
}
