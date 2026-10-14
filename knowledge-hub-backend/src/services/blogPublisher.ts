/**
 * services/blogPublisher.ts
 * Shared validation and delivery for posts sent to The Microsoft Cloud Blog (Discover articles and Spark themes).
 */
import { HTTP_STATUS } from '../config/constants.js';
import { env } from '../config/env.js';
import { ValidationError } from '../types/errors.js';
import { POST_TYPES, type PostType } from '../ai/blogDraft.js';

export interface BlogPublishBody { excerpt: string; status: 'draft' | 'published'; postType: PostType; title: string; content: string; summary: string; keyTakeaways: string[]; categories: string[]; tags: string[] }

export interface BlogSendResult {
  httpStatus: number;
  payload: { success: true; data: { editUrl: string | null; url: string | null; status: 'draft' | 'published' } }
    | { success: false; error: { code: string; message: string } };
}

export function parsePublishBody(body: unknown): BlogPublishBody {
  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [];
  const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
  const postType = POST_TYPES.find(t => t === o['postType']) ?? 'article';
  const status: BlogPublishBody['status'] = o['status'] === 'published' ? 'published' : 'draft';
  const parsed = { excerpt: text(o['excerpt']).slice(0, 300), status, postType, title: text(o['title']), content: text(o['content']), summary: text(o['summary']),
    keyTakeaways: list(o['keyTakeaways']), categories: list(o['categories']), tags: list(o['tags']) };
  if (parsed.title.length > 200 || parsed.summary.length > 1000 || parsed.keyTakeaways.length > 10 || parsed.keyTakeaways.some(t => t.length > 300)) {
    throw new ValidationError('Title (200), summary (1,000) and takeaways (10 max, 300 characters each) exceed the blog limits.');
  }
  if (!parsed.title || !parsed.content || !parsed.summary) throw new ValidationError('Title, summary and content are required to publish.');
  return parsed;
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
