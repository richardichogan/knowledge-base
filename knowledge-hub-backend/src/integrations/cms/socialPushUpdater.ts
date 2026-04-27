import { env } from '../../config/env.js';
import { downloadBlobAsText, uploadBlobAsText } from './blobClient.js';
import { BlobStorageError, ValidationError } from '../../types/errors.js';
import type { CmsPost, SocialPush } from '../../types/cmsPost.js';

/**
 * Updates the socialPush flag for a specific platform on a CMS post.
 * Reads the post JSON, updates the field, and writes it back to blob storage.
 * The write is to the individual post file — never to index.json.
 */
export async function markSocialPushSent(
  postId: string,
  platform: keyof SocialPush,
): Promise<void> {
  const blobPath = `${env.CMS_POSTS_PREFIX}${postId}.json`;

  const raw = await downloadBlobAsText(env.CMS_BLOB_CONTAINER, blobPath);

  let post: CmsPost;
  try {
    post = JSON.parse(raw) as CmsPost;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BlobStorageError('parse', `${blobPath}: ${message}`);
  }

  if (!post.socialPush) {
    post.socialPush = {
      linkedin: { pushed: false, pushedAt: null },
      x: { pushed: false, pushedAt: null },
      bluesky: { pushed: false, pushedAt: null },
    };
  }

  post.socialPush[platform] = {
    pushed: true,
    pushedAt: new Date().toISOString(),
  };

  await uploadBlobAsText(
    env.CMS_BLOB_CONTAINER,
    blobPath,
    JSON.stringify(post, null, 2),
  );
}

/**
 * Validates that a platform string is a valid socialPush key.
 */
export function assertValidPlatform(platform: string): asserts platform is keyof SocialPush {
  const valid: Array<keyof SocialPush> = ['linkedin', 'x', 'bluesky'];
  if (!valid.includes(platform as keyof SocialPush)) {
    throw new ValidationError(`Invalid social platform: ${platform}`, {
      platform: `Must be one of: ${valid.join(', ')}`,
    });
  }
}
