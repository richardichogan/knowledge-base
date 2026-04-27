import { env } from '../../config/env.js';
import { downloadBlobAsText } from './blobClient.js';
import { BlobStorageError, ValidationError } from '../../types/errors.js';
import type { CmsPost } from '../../types/cmsPost.js';

/** Lightweight post metadata as stored in posts/index.json. */
export interface CmsPostMeta {
  id: string;
  title: string;
  slug: string;
  date: string;
  excerpt?: string;
  categories?: string[];
  tags?: string[];
  status?: string;
  featuredImage?: string;
}

/**
 * Reads posts/index.json and returns an array of post metadata.
 * This is the authoritative list of all posts — no blob listing needed.
 */
export async function readPostIndex(): Promise<CmsPostMeta[]> {
  const indexPath = `${env.CMS_POSTS_PREFIX}index.json`;
  const raw = await downloadBlobAsText(env.CMS_BLOB_CONTAINER, indexPath);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new BlobStorageError('parse', `${indexPath}: expected an array`);
    }
    return parsed as CmsPostMeta[];
  } catch (err) {
    if (err instanceof BlobStorageError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BlobStorageError('parse', `${indexPath}: ${message}`);
  }
}

/**
 * Returns blob paths for all posts derived from posts/index.json.
 * Only includes entries whose id matches the "wp-<number>" format
 * (i.e. has a corresponding individual blob). Entries from the index
 * with non-wp IDs are skipped — they have no individual blob to read.
 * Paths are of the form "posts/wp-<number>.json".
 */
export async function listPostPaths(): Promise<string[]> {
  const index = await readPostIndex();
  return index
    .filter((entry) => /^wp-\d+$/.test(entry.id))
    .map((entry) => `${env.CMS_POSTS_PREFIX}${entry.id}.json`);
}

/**
 * Reads and parses a single CMS post from blob storage.
 * @param postId The post ID, e.g. "wp-1234"
 */
export async function readPost(postId: string): Promise<CmsPost> {
  const blobPath = `${env.CMS_POSTS_PREFIX}${postId}.json`;

  const raw = await downloadBlobAsText(env.CMS_BLOB_CONTAINER, blobPath);

  try {
    const parsed: unknown = JSON.parse(raw);
    return validatePost(parsed);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BlobStorageError('parse', `${blobPath}: ${message}`);
  }
}

/**
 * Extracts a post ID from a blob path.
 * "posts/wp-1234.json" → "wp-1234"
 */
export function extractPostIdFromPath(blobPath: string): string {
  const filename = blobPath.split('/').pop() ?? '';
  return filename.replace(/\.json$/, '');
}

/**
 * Minimal runtime validation of a parsed CMS post object.
 * Throws ValidationError if required fields are missing.
 */
function validatePost(raw: unknown): CmsPost {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('CMS post is not an object');
  }

  const obj = raw as Record<string, unknown>;
  const required = ['id', 'title', 'slug', 'date', 'content', 'categories', 'status'];

  const missingFields: Record<string, string> = {};
  for (const field of required) {
    if (obj[field] === undefined || obj[field] === null) {
      missingFields[field] = 'required';
    }
  }

  if (Object.keys(missingFields).length > 0) {
    throw new ValidationError('CMS post missing required fields', missingFields);
  }

  // Apply defaults for new optional fields if absent
  const post = obj as unknown as CmsPost;

  if (!post.socialPush) {
    post.socialPush = {
      linkedin: { pushed: false, pushedAt: null },
      x: { pushed: false, pushedAt: null },
      bluesky: { pushed: false, pushedAt: null },
    };
  }

  return post;
}
