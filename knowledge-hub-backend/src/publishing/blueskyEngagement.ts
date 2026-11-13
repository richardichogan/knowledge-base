import type { Pool } from 'pg';
import { fetchPublic } from '../integrations/discovery/feedReader.js';
import {
  BLUESKY_ENGAGEMENT_LOOKBACK_DAYS,
  BLUESKY_ENGAGEMENT_TIMEOUT_MS,
  BLUESKY_GET_POSTS_BATCH,
  BLUESKY_PUBLIC_API_URL,
} from '../config/constants.js';
import { env } from '../config/env.js';

/**
 * Daily Bluesky engagement collector.
 *
 * Reads public like/repost/reply/quote counts for every Bluesky post this app
 * sent in the last BLUESKY_ENGAGEMENT_LOOKBACK_DAYS days and appends one
 * snapshot row per post to content_performance. Posts the public API no longer
 * returns (deleted or hidden) are recorded explicitly as unavailable, never
 * silently skipped. No auth and no AI calls are involved.
 */

const USER_AGENT = 'KnowledgeHubEngagement/1.0';

interface TrackedDelivery { id: string; uri: string }

interface PublicPostView {
  uri?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
}

export interface EngagementCollectionResult { tracked: number; recorded: number; unavailable: number; failedBatches: number }

/** A count Bluesky did not report is stored as null — unknown, not zero. */
const count = (value: number | undefined): number | null => (typeof value === 'number' ? value : null);

async function fetchBatch(uris: string[]): Promise<Map<string, PublicPostView>> {
  const query = uris.map(uri => `uris=${encodeURIComponent(uri)}`).join('&');
  const response = await fetchPublic(`${BLUESKY_PUBLIC_API_URL}/xrpc/app.bsky.feed.getPosts?${query}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeoutMs: BLUESKY_ENGAGEMENT_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`getPosts responded ${response.status}`);
  const body = await response.json() as { posts?: PublicPostView[] };
  const byUri = new Map<string, PublicPostView>();
  for (const post of body.posts ?? []) {
    if (typeof post.uri === 'string') byUri.set(post.uri, post);
  }
  return byUri;
}

async function recordSnapshot(db: Pool, deliveryId: string, uri: string, metrics: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO content_performance (delivery_id, platform, external_id, environment, metrics)
     VALUES ($1, 'bluesky', $2, $3, $4)`,
    [deliveryId, uri, env.isDevelopment ? 'dev' : 'prod', JSON.stringify(metrics)],
  );
}

/** Collects one engagement snapshot per tracked Bluesky post. Safe to re-run; each run appends. */
export async function collectBlueskyEngagement(db: Pool): Promise<EngagementCollectionResult> {
  const { rows } = await db.query<TrackedDelivery>(
    `SELECT id, receipt->>'uri' AS uri
       FROM publishing_deliveries
      WHERE destination = 'bluesky' AND status = 'sent'
        AND receipt->>'uri' LIKE 'at://%'
        AND published_at >= NOW() - ($1 || ' days')::interval
      ORDER BY published_at DESC`,
    [BLUESKY_ENGAGEMENT_LOOKBACK_DAYS],
  );
  const result: EngagementCollectionResult = { tracked: rows.length, recorded: 0, unavailable: 0, failedBatches: 0 };
  for (let start = 0; start < rows.length; start += BLUESKY_GET_POSTS_BATCH) {
    const batch = rows.slice(start, start + BLUESKY_GET_POSTS_BATCH);
    let posts: Map<string, PublicPostView>;
    try {
      posts = await fetchBatch(batch.map(row => row.uri));
    } catch (err) {
      // A failed batch means those posts were not measured today — no snapshot is written for them.
      result.failedBatches += 1;
      console.error('[BlueskyEngagement] Batch failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const row of batch) {
      const post = posts.get(row.uri);
      if (post === undefined) {
        await recordSnapshot(db, row.id, row.uri, { unavailable: true });
        result.unavailable += 1;
      } else {
        await recordSnapshot(db, row.id, row.uri, {
          likes: count(post.likeCount), reposts: count(post.repostCount),
          replies: count(post.replyCount), quotes: count(post.quoteCount),
        });
        result.recorded += 1;
      }
    }
  }
  return result;
}
