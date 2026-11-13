import type { Pool } from 'pg';
import { parseNoteContent } from '../utils/noteContent.js';

/**
 * Audience engagement section of the knowledge health report.
 *
 * Shows every sent Bluesky post published inside the selected window with the
 * latest collected engagement snapshot. A post without a snapshot has not been
 * collected yet — that is reported as such, never as zero engagement.
 */

const ENGAGEMENT_POST_LIMIT = 50;

export interface EngagementMetrics { likes: number | null; reposts: number | null; replies: number | null; quotes: number | null }
export interface EngagementPost {
  deliveryId: string;
  url: string | null;
  publishedAt: string;
  source: string;
  metrics: EngagementMetrics | null;
  unavailable: boolean;
  capturedAt: string | null;
  capturedEnvironment: string | null;
}
export interface EngagementSection { posts: EngagementPost[]; postsTruncated: boolean; note: string }

interface EngagementRow {
  id: string;
  identity: string;
  published_at: string;
  url: string | null;
  topic_title: string | null;
  note_content: string | null;
  metrics: Record<string, unknown> | null;
  captured_at: string | null;
  captured_environment: string | null;
}

const noteTitle = (contentJson: string): string | null => {
  try {
    return parseNoteContent(contentJson).title;
  } catch {
    return null;
  }
};

const sourceLabel = (row: EngagementRow): string => {
  if (row.topic_title !== null) return row.topic_title;
  if (row.identity.startsWith('podcast:')) return (row.note_content !== null && noteTitle(row.note_content)) || 'Podcast episode post';
  return 'Unknown source';
};

const metricCount = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export async function engagementSection(db: Pool, start: string, end: string): Promise<EngagementSection> {
  const { rows } = await db.query<EngagementRow>(
    `SELECT d.id, d.identity, d.published_at, d.receipt->>'url' AS url,
            t.title AS topic_title, n.content AS note_content,
            s.metrics, s.captured_at, s.environment AS captured_environment
       FROM publishing_deliveries d
       LEFT JOIN publishing_topics t ON t.id = d.topic_id
       LEFT JOIN notes n ON d.identity LIKE 'podcast:%' AND n.id::text = split_part(d.identity, ':', 2)
       LEFT JOIN LATERAL (
         SELECT metrics, captured_at, environment FROM content_performance
          WHERE delivery_id = d.id ORDER BY captured_at DESC LIMIT 1
       ) s ON TRUE
      WHERE d.destination = 'bluesky' AND d.status = 'sent'
        AND d.published_at >= $1 AND d.published_at < $2
      ORDER BY d.published_at DESC
      LIMIT $3`,
    [start, end, ENGAGEMENT_POST_LIMIT + 1],
  );
  const posts = rows.slice(0, ENGAGEMENT_POST_LIMIT).map((row): EngagementPost => {
    const unavailable = row.metrics?.unavailable === true;
    const metrics: EngagementMetrics | null = row.metrics === null || unavailable ? null : {
      likes: metricCount(row.metrics.likes), reposts: metricCount(row.metrics.reposts),
      replies: metricCount(row.metrics.replies), quotes: metricCount(row.metrics.quotes),
    };
    return {
      deliveryId: row.id, url: row.url, publishedAt: new Date(row.published_at).toISOString(),
      source: sourceLabel(row), metrics, unavailable,
      capturedAt: row.captured_at === null ? null : new Date(row.captured_at).toISOString(),
      capturedEnvironment: row.captured_environment,
    };
  });
  return {
    posts,
    postsTruncated: rows.length > ENGAGEMENT_POST_LIMIT,
    note: 'Counts are Bluesky public totals at the latest daily capture. A post without a snapshot has not been collected yet — that is not zero engagement. The date window filters by publish date; the environment tag shows which runtime collected the snapshot.',
  };
}
