/**
 * prReviewsSync.ts
 *
 * Syncs GitHub Pull Request reviews for all user repos.
 * Shows review activity — approvals, change requests, comments submitted.
 *
 * API: GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
 */

import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK, MAX_PAGE_SIZE } from '../../config/constants.js';
import { loadProjectContextCache, resolveProjectContext } from './projectContext.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitHubRepo {
  full_name: string;
}

interface GitHubPR {
  number: number;
  title: string;
  updated_at: string;
  base: { repo: { full_name: string } };
}

interface GitHubReview {
  id: number;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  body: string;
  submitted_at: string | null;
  html_url: string;
  user: { login: string } | null;
  commit_id: string;
}

const SHORT_SHA_LENGTH = 7;

export async function syncGitHubPRReviews(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  await loadProjectContextCache(db);

  const syncState = await getSyncState(db, 'github-pr-review');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);

  const repos: GitHubRepo[] = [];
  for await (const page of client.paginate<GitHubRepo>(`/user/repos`, { type: 'all' })) {
    repos.push(...page);
  }

  for (const repo of repos) {
    try {
      // Fetch PRs updated since sinceDate
      for await (const prs of client.paginate<GitHubPR>(
        `/repos/${repo.full_name}/pulls`,
        { state: 'all', per_page: String(MAX_PAGE_SIZE), sort: 'updated', direction: 'desc' },
      )) {
        const recentPrs = prs.filter((pr) => new Date(pr.updated_at) >= sinceDate);

        for (const pr of recentPrs) {
          try {
            for await (const reviews of client.paginate<GitHubReview>(
              `/repos/${repo.full_name}/pulls/${pr.number}/reviews`,
              { per_page: String(MAX_PAGE_SIZE) },
            )) {
              for (const review of reviews) {
                if (!review.submitted_at) continue;
                if (new Date(review.submitted_at) < sinceDate) continue;
                // Only index substantive reviews — skip COMMENTED with no body
                if (review.state === 'COMMENTED' && review.body.trim() === '') continue;
                // Only index reviews by the authenticated user or on their PRs
                const reviewer = review.user?.login ?? '';
                const isMyReview = env.GITHUB_USERNAME
                  ? reviewer === env.GITHUB_USERNAME
                  : true;
                if (!isMyReview) continue;

                await upsertContentItem(
                  db,
                  reviewToContentItem(review, pr, repo.full_name),
                );
                indexed++;
              }
            }
          } catch {
            // Per-PR review fetch failure is non-fatal
          }
        }

        if (recentPrs.length < prs.length) break;
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('404')) {
        console.error(`[GitHub PR reviews] Failed for ${repo.full_name}: ${message}`);
      }
    }
  }

  await upsertSyncState(db, 'github-pr-review', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} repos with errors` : null,
  });

  return { indexed, errors };
}

const STATE_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  COMMENTED: 'Reviewed',
  DISMISSED: 'Review dismissed',
};

function reviewToContentItem(
  review: GitHubReview,
  pr: GitHubPR,
  repoFullName: string,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const label = STATE_LABEL[review.state] ?? review.state;
  const shortSha = review.commit_id.substring(0, SHORT_SHA_LENGTH);
  const reviewer = review.user?.login ?? 'unknown';

  return {
    source: 'github-pr-review',
    sourceId: String(review.id),
    title: `${label}: PR #${pr.number} — ${pr.title}`,
    summary: `${reviewer} ${label.toLowerCase()} PR #${pr.number} in ${repoFullName}`,
    body: review.body,
    publishedAt: new Date(review.submitted_at ?? Date.now()).toISOString(),
    url: review.html_url,
    projectContext: resolveProjectContext(repoFullName),
    metadata: {
      repo: repoFullName,
      prNumber: pr.number,
      prTitle: pr.title,
      state: review.state,
      reviewer,
      shortSha,
    },
    tags: [review.state.toLowerCase().replace('_', '-')],
  };
}
