import type { Pool } from 'pg';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { listBlobNames, downloadBlobAsText } from './blobClient.js';
import { env } from '../../config/env.js';
import type { ContentItem } from '../../types/contentItem.js';
import type { CmsPost } from '../../types/cmsPost.js';
import { resolveCmsContentType, resolvePostUrl } from '../../types/cmsPost.js';
import { IntegrationError, ValidationError, BlobStorageError } from '../../types/errors.js';
import { upsertTags } from '../../db/tagHelpers.js';

const SOURCE_NAME = 'cms';

/**
 * Lists every post blob — both posts/wp-<number>.json and posts/post-<timestamp>.json.
 */
async function listPostBlobs(): Promise<string[]> {
  const all = await listBlobNames(env.CMS_BLOB_CONTAINER, env.CMS_POSTS_PREFIX);
  return all.filter((p) => /\/post-\d+\.json$/.test(p));
}

/**
 * Downloads and parses a single post blob. Returns null if validation fails.
 */
async function readPostBlob(blobPath: string): Promise<CmsPost | null> {
  try {
    const raw = await downloadBlobAsText(env.CMS_BLOB_CONTAINER, blobPath);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const required = ['id', 'title', 'slug', 'date', 'content', 'categories', 'status'];
    for (const field of required) {
      if (parsed[field] == null) throw new ValidationError(`Missing field: ${field}`);
    }
    const post = parsed as unknown as CmsPost;
    if (!post.socialPush) {
      post.socialPush = {
        linkedin: { pushed: false, pushedAt: null },
        x: { pushed: false, pushedAt: null },
        bluesky: { pushed: false, pushedAt: null },
      };
    }
    return post;
  } catch (err) {
    if (err instanceof BlobStorageError) throw err;
    console.error(`[CMS indexer] Failed to parse ${blobPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function postToContentItem(post: CmsPost): Omit<ContentItem, 'id' | 'indexedAt'> {
  const contentType = resolveCmsContentType(post);
  const url = resolvePostUrl(post);

  const sourceMap = {
    'blog-post': 'cms-blog',
    'newsletter': 'cms-newsletter',
    'podcast-show-notes': 'cms-podcast-show-notes',
    'session-summary': 'cms-session-summary',
  } as const;

  return {
    source: sourceMap[contentType],
    sourceId: post.id,
    title: post.title,
    summary: post.excerpt ?? '',
    body: post.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    publishedAt: new Date(post.date.endsWith('Z') ? post.date : post.date + 'Z').toISOString(),
    url: `https://themicrosoftcloudblog.com${url}`,
    projectContext: 'ibm-thought-leadership',
    metadata: {
      categories: post.categories,
      socialPush: post.socialPush,
      podcastEpisode: post.podcastEpisode,
      featuredImage: post.featuredImage,
    },
    tags: post.tags,
  };
}

/**
 * Indexes all published CMS posts by listing posts/wp-*.json blobs directly.
 */
export async function indexAllPosts(db: Pool): Promise<{ indexed: number; errors: number }> {
  let indexed = 0;
  let errors = 0;

  const paths = await listPostBlobs();

  for (const path of paths) {
    try {
      const post = await readPostBlob(path);
      if (post === null) { errors++; continue; }
      if (post.status !== 'published') continue;
      await upsertContentItem(db, postToContentItem(post));
      // Keep global_tags in sync with every post's tags
      if (post.tags.length > 0) {
        await upsertTags(db, post.tags);
      }
      indexed++;
    } catch (err) {
      errors++;
      console.error(`[CMS indexer] Failed to index ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await upsertSyncState(db, SOURCE_NAME, {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} posts failed to index` : null,
  });

  return { indexed, errors };
}

/** Re-indexes a single post by ID. */
export async function reindexPost(db: Pool, postId: string): Promise<void> {
  const blobPath = `${env.CMS_POSTS_PREFIX}${postId}.json`;
  const post = await readPostBlob(blobPath);
  if (post === null) throw new IntegrationError('cms', `Failed to parse post ${postId}`);
  if (post.status !== 'published') return;
  await upsertContentItem(db, postToContentItem(post));
  if (post.tags.length > 0) {
    await upsertTags(db, post.tags);
  }
}

