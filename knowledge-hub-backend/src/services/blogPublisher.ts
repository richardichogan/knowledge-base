/**
 * services/blogPublisher.ts
 * Shared validation and delivery for posts sent to The Microsoft Cloud Blog (Discover articles and Spark themes).
 */
import { HTTP_STATUS } from '../config/constants.js';
import { env } from '../config/env.js';
import { ValidationError } from '../types/errors.js';
import { POST_TYPES, type PostType } from '../ai/blogDraft.js';
import { BLOG_CATEGORIES, resolveBlogCategory } from '../ai/blogHouseStyle.js';
import { findTropes, fixDashes } from '../ai/styleCheck.js';

export interface BlogPublishBody { slug?: string; sourceUrl?: string; excerpt: string; status: 'draft' | 'published'; postType: PostType; title: string; content: string; summary: string; keyTakeaways: string[]; categories: string[]; tags: string[] }

export interface BlogSendResult {
  httpStatus: number;
  payload: { success: true; data: { editUrl: string | null; url: string | null; status: 'draft' | 'published' } }
    | { success: false; error: { code: string; message: string } };
}

const MAX_EXCERPT = 300;
const MAX_TITLE = 200;
const MAX_SUMMARY = 1000;
const MAX_TAKEAWAYS = 10;
const MAX_TAKEAWAY_CHARS = 300;
const BLOG_POST_TIMEOUT_MS = 30_000;
const QUICK_MAX_WORDS = 600;
const QUICK_MAX_TITLE = 60;
const QUICK_MAX_TAKEAWAYS = 2;

export function parsePublishBody(body: unknown): BlogPublishBody {
  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [];
  const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
  const postType = POST_TYPES.find(t => t === o['postType']) ?? 'article';
  const status: BlogPublishBody['status'] = o['status'] === 'published' ? 'published' : 'draft';
  const parsed = { excerpt: text(o['excerpt']).slice(0, MAX_EXCERPT), status, postType, title: text(o['title']), content: text(o['content']), summary: text(o['summary']),
    keyTakeaways: list(o['keyTakeaways']), categories: list(o['categories']), tags: list(o['tags']) };
  if (parsed.title.length > MAX_TITLE || parsed.summary.length > MAX_SUMMARY || parsed.keyTakeaways.length > MAX_TAKEAWAYS || parsed.keyTakeaways.some(t => t.length > MAX_TAKEAWAY_CHARS)) {
    throw new ValidationError('Title (200), summary (1,000) and takeaways (10 max, 300 characters each) exceed the blog limits.');
  }
  if (!parsed.title || !parsed.content || !parsed.summary) throw new ValidationError('Title, summary and content are required to publish.');
  const slug = text(o['slug']);
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ValidationError('Slug must use lowercase letters, numbers and single hyphens.');
  const sourceUrl = text(o['sourceUrl']);
  if (sourceUrl) {
    let url: URL;
    try { url = new URL(sourceUrl); } catch { throw new ValidationError('Source URL must be a valid public article URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ValidationError('Source URL must be an HTTP or HTTPS article URL without credentials.');
  }
  if (postType === 'quick') {
    const words = parsed.content.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
    if (words > QUICK_MAX_WORDS || parsed.title.length > QUICK_MAX_TITLE || parsed.keyTakeaways.length > QUICK_MAX_TAKEAWAYS || /<(?:h[1-6]|ul|ol)\b/i.test(parsed.content)) {
      throw new ValidationError('Quick takes allow at most 600 words, a 60-character title and two takeaways, with paragraphs rather than headings or lists.');
    }
  }
  const unknown = parsed.categories.filter(category => resolveBlogCategory(category) === undefined);
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown blog categories: ${unknown.join(', ')}. Use any of: ${BLOG_CATEGORIES.join(', ')}. Other topics such as Dynamics 365 belong in tags. Quick take is a post type, not a category.`);
  }
  parsed.categories = [...new Set(parsed.categories.map(category => resolveBlogCategory(category)!))];
  parsed.title = fixDashes(parsed.title); parsed.excerpt = fixDashes(parsed.excerpt); parsed.summary = fixDashes(parsed.summary);
  parsed.content = fixDashes(parsed.content); parsed.keyTakeaways = parsed.keyTakeaways.map(fixDashes);
  const ownContent = parsed.content.replace(/<hr>\s*<p><em>Source:[\s\S]*?<\/em><\/p>\s*$/i, '');
  const tropes = findTropes(parsed.title, parsed.excerpt, parsed.summary, ownContent, ...parsed.keyTakeaways);
  if (tropes.length > 0) throw new ValidationError(`Not sent: the post still contains banned AI writing patterns. Edit these out first: ${tropes.join('; ')}.`);
  return { ...parsed, ...(slug ? { slug } : {}), ...(sourceUrl ? { sourceUrl } : {}) };
}

/** Sends a post to the blog API and returns the HTTP status + JSON payload to relay to the client. */
export async function sendToBlog(post: BlogPublishBody): Promise<BlogSendResult> {
  const key = env.BLOG_POSTS_API_KEY;
  if (!key) {
    return { httpStatus: HTTP_STATUS.SERVICE_UNAVAILABLE, payload: { success: false, error: { code: 'NOT_CONFIGURED', message: 'Blog publishing is not configured (BLOG_POSTS_API_KEY).' } } };
  }
  const response = await fetch(env.BLOG_POSTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...post, excerpt: post.excerpt || undefined }),
    signal: AbortSignal.timeout(BLOG_POST_TIMEOUT_MS),
  });
  const result = await response.json().catch(() => ({})) as { error?: string; details?: string[]; editUrl?: string; url?: string };
  if (response.status === HTTP_STATUS.CONFLICT) {
    return { httpStatus: HTTP_STATUS.CONFLICT, payload: { success: false, error: { code: 'BLOG_DUPLICATE', message: 'A post with this title already exists on the blog this month. It may already have been created: check the blog admin, or change the title.' } } };
  }
  if (!response.ok) {
    return { httpStatus: response.status === HTTP_STATUS.FORBIDDEN ? HTTP_STATUS.FORBIDDEN : HTTP_STATUS.BAD_GATEWAY, payload: { success: false, error: { code: 'BLOG_REJECTED',
      message: `The blog rejected the post: ${response.status} ${result.error ?? ''} ${(result.details ?? []).join('; ')}`.trim() } } };
  }
  return { httpStatus: HTTP_STATUS.OK, payload: { success: true, data: { editUrl: result.editUrl ?? null, url: result.url ?? null, status: post.status } } };
}
