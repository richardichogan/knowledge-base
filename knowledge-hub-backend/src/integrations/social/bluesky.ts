/**
 * Posts to Bluesky through the AT Protocol with an app password (never the account password).
 */
import { AtpAgent, RichText, type AppBskyEmbedExternal, type BlobRef } from '@atproto/api';
import { env } from '../../config/env.js';
import { IntegrationError, ValidationError } from '../../types/errors.js';
import { fetchPublic } from '../discovery/feedReader.js';

export const BLUESKY_POST_LIMIT = 300;
const CARD_TITLE_CHARS = 300;
const CARD_DESCRIPTION_CHARS = 300;
const PAGE_TIMEOUT_MS = 8_000;
const PAGE_READ_CHARS = 300_000;
const THUMB_MAX_BYTES = 976_560;
const USER_AGENT = 'Mozilla/5.0 (compatible; AthenaKnowledgeHub/1.0)';

export interface BlueskyLink { url: string; title: string; description: string }
export interface BlueskyPostResult { uri: string; url: string }

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
export function graphemeLength(text: string): number {
  return [...segmenter.segment(text)].length;
}

export function blueskyConfigured(): boolean {
  return Boolean(env.BLUESKY_IDENTIFIER && env.BLUESKY_APP_PASSWORD);
}

/** Composes the visible post text: the copy, a blank line, then the link (as on "Copy post + link"). */
export function composeBlueskyText(copy: string, url: string | null): string {
  if (!copy.trim()) throw new ValidationError('Write the post before sending it to Bluesky.');
  const text = [copy.trim(), url].filter(Boolean).join('\n\n');
  if (graphemeLength(text) > BLUESKY_POST_LIMIT) {
    throw new ValidationError(`The post and link are ${graphemeLength(text).toString()} characters; Bluesky allows ${BLUESKY_POST_LIMIT.toString()}.`);
  }
  return text;
}

function metaContent(html: string, key: string): string {
  const tag = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i').exec(html)?.[0] ?? '';
  return (/content=["']([^"']*)["']/i.exec(tag)?.[1] ?? '').replace(/&amp;/g, '&').trim();
}

/** Best effort: the article's og:image, uploaded as the link card thumbnail. Any failure just omits the image. */
async function uploadThumbnail(agent: AtpAgent, pageUrl: string): Promise<BlobRef | undefined> {
  try {
    const page = await fetchPublic(pageUrl, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, timeoutMs: PAGE_TIMEOUT_MS });
    if (!page.ok) return undefined;
    const html = (await page.text()).slice(0, PAGE_READ_CHARS);
    const imageAddress = metaContent(html, 'og:image') || metaContent(html, 'twitter:image');
    if (!imageAddress) return undefined;
    const image = await fetchPublic(new URL(imageAddress, page.url || pageUrl).toString(), { headers: { 'User-Agent': USER_AGENT }, timeoutMs: PAGE_TIMEOUT_MS });
    const type = image.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!image.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return undefined;
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > THUMB_MAX_BYTES) return undefined;
    return (await agent.uploadBlob(bytes, { encoding: type })).data.blob;
  } catch {
    return undefined;
  }
}

/** Publishes a post with clickable links and, when a link is given, a link card. Returns the public post URL. */
export async function postToBluesky(copy: string, link: BlueskyLink | null): Promise<BlueskyPostResult> {
  const identifier = env.BLUESKY_IDENTIFIER;
  const password = env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) throw new IntegrationError('bluesky', 'Bluesky posting is not configured (BLUESKY_APP_PASSWORD).');
  const text = composeBlueskyText(copy, link?.url ?? null);

  const agent = new AtpAgent({ service: env.BLUESKY_SERVICE });
  try {
    await agent.login({ identifier, password });
  } catch (err) {
    throw new IntegrationError('bluesky', `Sign-in failed. Check the app password is still valid. ${err instanceof Error ? err.message : ''}`.trim());
  }

  const rich = new RichText({ text });
  await rich.detectFacets(agent);
  let embed: AppBskyEmbedExternal.Main | undefined;
  if (link) {
    const thumb = await uploadThumbnail(agent, link.url);
    embed = {
      $type: 'app.bsky.embed.external',
      external: {
        uri: link.url,
        title: link.title.slice(0, CARD_TITLE_CHARS),
        description: link.description.slice(0, CARD_DESCRIPTION_CHARS),
        ...(thumb ? { thumb } : {}),
      },
    };
  }

  try {
    const created = await agent.post({ text: rich.text, ...(rich.facets ? { facets: rich.facets } : {}), ...(embed ? { embed } : {}), langs: ['en-GB'], createdAt: new Date().toISOString() });
    const rkey = created.uri.split('/').pop() ?? '';
    return { uri: created.uri, url: `https://bsky.app/profile/${agent.session?.handle ?? identifier}/post/${rkey}` };
  } catch (err) {
    throw new IntegrationError('bluesky', `Bluesky rejected the post. ${err instanceof Error ? err.message : ''}`.trim());
  }
}
