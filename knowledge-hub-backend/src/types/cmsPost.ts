/**
 * CMS post schema — as stored in Azure Blob Storage at posts/<id>.json.
 * Spec: v4. Fields socialPush, podcastEpisode, sessionSummary added.
 * Content type is derived from categories — no separate type field.
 */

export type CmsPostStatus = 'published' | 'draft';

/** Per-platform social distribution record. */
export interface SocialPlatformPush {
  /** Whether the post has been pushed to this platform. */
  pushed: boolean;
  /** ISO 8601 timestamp of when it was pushed, or null if not yet pushed. */
  pushedAt: string | null;
}

/** Social push tracking for a post. Updated by the AI write layer. */
export interface SocialPush {
  linkedin: SocialPlatformPush;
  x: SocialPlatformPush;
  bluesky: SocialPlatformPush;
}

/**
 * Full CMS post as stored in blob storage.
 * `date` is ISO 8601 without timezone — treat as UTC.
 * Post URL: /YYYY/MM/slug/ — derive year/month from `date` at render time.
 * Categories are case-sensitive in storage; compare with .toLowerCase().
 */
export interface CmsPost {
  id: string;
  title: string;
  slug: string;
  /** ISO 8601, no timezone — treat as UTC. */
  date: string;
  excerpt: string | undefined;
  /** Full HTML content. */
  content: string;
  featuredImage: string | undefined;
  /** Case-sensitive in storage. Compare with .toLowerCase(). */
  categories: string[];
  tags: string[];
  status: CmsPostStatus;
  /** Social distribution tracking. Defaults to all false/null on creation. */
  socialPush: SocialPush;
  /**
   * Optional — present only on posts with category "Podcast".
   * References the RSS <guid> of the corresponding episode.
   */
  podcastEpisode?: string;
  /**
   * True only on markdown files exported from Claude Projects sessions.
   * Allows the knowledge hub to distinguish session exports from CMS content.
   */
  sessionSummary?: boolean;
}

/** Default socialPush value for new posts. */
export const DEFAULT_SOCIAL_PUSH: SocialPush = {
  linkedin: { pushed: false, pushedAt: null },
  x: { pushed: false, pushedAt: null },
  bluesky: { pushed: false, pushedAt: null },
};

/**
 * Content type as classified by the knowledge hub.
 * Determined from categories — never from a type field.
 */
export type CmsContentType = 'blog-post' | 'newsletter' | 'podcast-show-notes' | 'session-summary';

/**
 * Derives the content type from a post's categories array.
 * Category comparison is case-insensitive per spec.
 */
export function resolveCmsContentType(post: Pick<CmsPost, 'categories' | 'sessionSummary'>): CmsContentType {
  if (post.sessionSummary === true) {
    return 'session-summary';
  }
  const lower = post.categories.map((c) => c.toLowerCase());
  if (lower.includes('reaching for the cloud')) {
    return 'newsletter';
  }
  if (lower.includes('podcast')) {
    return 'podcast-show-notes';
  }
  return 'blog-post';
}

/**
 * Derives the public URL path for a post: /YYYY/MM/slug/
 * Year and month are derived from `date`, never hardcoded.
 */
export function resolvePostUrl(post: Pick<CmsPost, 'date' | 'slug'>): string {
  const d = new Date(post.date);
  const year = d.getUTCFullYear().toString();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `/${year}/${month}/${post.slug}/`;
}
