/**
 * discoveredArticlesSync.ts
 *
 * Fetches newly discovered articles from The Microsoft Cloud Blog's
 * internal admin API and indexes them as source='discovered-article'.
 *
 * These are articles found by the blog's RSS-monitoring cron job that
 * Richard may decide to write about. They update several times a day.
 *
 * API: GET https://www.themicrosoftcloudblog.com/api/admin/discovered-articles
 * Auth: x-admin-auth header (ADMIN_PASSWORD env var)
 */

import type { Pool } from 'pg';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { FoundryClient } from '../../ai/foundryClient.js';
import type { ContentItem } from '../../types/contentItem.js';

const API_BASE = 'https://themicrosoftcloudblog.com';
const SYNC_STATE_KEY = 'discovered-articles';
const FETCH_LIMIT = 100;

interface DiscoveredArticle {
  id: string;
  title: string;
  url: string;
  description: string | null;
  publishedAt: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceId: string;
  discoveredAt: string;
  status: 'new' | 'reviewed' | 'dismissed' | 'published';
  newsWorthiness: number | null;
}

export async function syncDiscoveredArticles(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    console.warn('[DiscoveredArticles] ADMIN_PASSWORD not set — skipping sync');
    return { indexed: 0, errors: 0 };
  }

  let indexed = 0;
  let errors = 0;

  try {
    // Fetch all statuses so we get the full picture (new + reviewed etc.)
    // Filter by date client-side to avoid missing anything that was recently reviewed
    const url = `${API_BASE}/api/admin/discovered-articles/?limit=${FETCH_LIMIT}`;
    const response = await fetch(url, {
      headers: { 'x-admin-auth': password },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from discovered-articles API`);
    }

    const articles = (await response.json()) as DiscoveredArticle[];

    for (const article of articles) {
      // Don't index dismissed articles
      if (article.status === 'dismissed') continue;

      try {
        await upsertContentItem(db, articleToContentItem(article));
        indexed++;
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[DiscoveredArticles] Upsert failed for ${article.id}: ${message}`);
      }
    }

    // Score any items that don't yet have a relevance explanation
    await scoreUnscored(db);

    await upsertSyncState(db, SYNC_STATE_KEY, {
      lastSyncAt: new Date(),
      itemCount: indexed,
      lastError: errors > 0 ? `${errors} upsert errors` : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DiscoveredArticles] Sync failed: ${message}`);
    errors++;
    await upsertSyncState(db, SYNC_STATE_KEY, {
      lastSyncAt: new Date(),
      itemCount: 0,
      lastError: message,
    });
  }

  return { indexed, errors };
}

function articleToContentItem(
  article: DiscoveredArticle,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const DATE_PREFIX_LEN = 10;
  return {
    source: 'discovered-article',
    sourceId: article.id,
    title: article.title,
    summary: `via ${article.sourceTitle} · discovered ${article.discoveredAt.slice(0, DATE_PREFIX_LEN)}`,
    body: article.description ?? '',
    publishedAt: article.publishedAt,  // use original article publish time
    url: article.url,
    projectContext: 'msft-blog',
    metadata: {
      originalPublishedAt: article.publishedAt,
      discoveredAt: article.discoveredAt,
      sourceTitle: article.sourceTitle,
      sourceUrl: article.sourceUrl,
      sourceId: article.sourceId,
      status: article.status,
      newsWorthiness: article.newsWorthiness,
    },
    tags: [article.sourceTitle],  // source name only — status is noise
  };
}

// ── Relevance scoring ─────────────────────────────────────────────────────────

const SCORE_BATCH_SIZE = 10;
const RELEVANCE_MAX_TOKENS = 200;

const RELEVANCE_SYSTEM_PROMPT = `You are an editorial scoring assistant for Richard Hogan, who writes a Microsoft Azure and cloud technology blog called The Microsoft Cloud Blog.

Score each article 0.0–1.0 based on the following strict priority order:

TOPIC PRIORITY (most important factor):
1. Azure (Azure services, Azure AI, Azure infrastructure, Azure DevOps) → score starts at 0.7–1.0
2. GitHub & GitHub Copilot (GitHub features, Copilot coding assistant, Actions, repos) → score starts at 0.6–0.9
3. Microsoft 365 & M365 Copilot (Teams, Outlook, Word, Excel, SharePoint, M365 Copilot) → score starts at 0.5–0.8
4. Microsoft Research (research papers, AI research, labs announcements) → score starts at 0.4–0.7
5. Everything else Microsoft/MSFT → score starts at 0.3–0.6
6. Non-Microsoft content → score 0.0–0.3 (only relevant if directly about Azure/GitHub/M365 ecosystem)

SOURCE AUTHORITY (second factor — adjust score up or down within the band above):
- Official Microsoft sources (blog.microsoft.com, techcommunity.microsoft.com, azure.microsoft.com, devblogs.microsoft.com, github.blog, learn.microsoft.com) → boost +0.1
- Major tech press (TechCrunch, The Verge, ZDNet, InfoQ, Ars Technica, Wired) → neutral
- Community blogs, personal blogs, individual Microsoft MVPs/community members, forums, Reddit → reduce -0.3 AND cap score at 0.35 regardless of topic (community content is derivative — always lower value than official Microsoft sources, Microsoft Research, or press coverage)

ARTICLE TYPE (third factor — minor adjustment):
- Thought leadership / opinion / strategy / future vision → boost +0.05
- Product announcement / new feature / GA / preview → boost +0.05
- Case study / customer story → neutral
- General update / release notes / how-to → reduce -0.05

Classify the article type as exactly one of:
"thought-leadership" | "product-announcement" | "case-study" | "general-update"

Respond with ONLY valid JSON in this exact shape:
{"score": <0.0–1.0>, "explanation": "<1–2 sentences>", "articleType": "<one of the four types above>"}`;


export async function scoreUnscored(db: Pool): Promise<void> {
  const unscored = await db.query<{ id: string; title: string; body: string; metadata: Record<string, unknown> }>(
    `SELECT id, title, body, metadata FROM content_items
     WHERE source = 'discovered-article' AND relevance_explanation IS NULL
     LIMIT $1`,
    [SCORE_BATCH_SIZE],
  );

  if (unscored.rows.length === 0) return;

  const client = new FoundryClient();

  for (const row of unscored.rows) {
    try {
      const sourceTitle = (row.metadata['sourceTitle'] as string) || '';
      const prompt = `Title: ${row.title}\nSource: ${sourceTitle}\nDescription: ${row.body || '(none)'}`;

      const raw = await client.chat(
        'gpt-4o-mini',
        [
          { role: 'system', content: RELEVANCE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        RELEVANCE_MAX_TOKENS,
      );

      // Strip markdown fences if model wrapped JSON
      const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(cleaned) as { score: number; explanation: string; articleType?: string };

      await db.query(
        `UPDATE content_items
         SET relevance_score = $1, relevance_explanation = $2,
             metadata = metadata || jsonb_build_object('articleType', $3::text)
         WHERE id = $4`,
        [parsed.score, parsed.explanation, parsed.articleType ?? null, row.id],
      );
      console.warn(`[DiscoveredArticles] Scored ${row.id}: ${parsed.score}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[DiscoveredArticles] Scoring failed for ${row.id}: ${message}`);
    }
  }
}
