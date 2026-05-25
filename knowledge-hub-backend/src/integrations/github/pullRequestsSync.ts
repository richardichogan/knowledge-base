import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK, GITHUB_REPO_SKIP_LIST } from '../../config/constants.js';
import { loadProjectContextCache, resolveProjectContext } from './projectContext.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitHubRepo {
  full_name: string;
}

interface GitHubPR {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  base: { repo: { full_name: string } };
}

export async function syncGitHubPullRequests(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  await loadProjectContextCache(db);

  // Only fetch PRs updated since last sync
  const syncState = await getSyncState(db, 'github-pr');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);

  const repos: GitHubRepo[] = [];
  for await (const page of client.paginate<GitHubRepo>(`/user/repos`, {
    type: 'all',
  })) {
    repos.push(...page);
  }

  for (const repo of repos) {
    if (GITHUB_REPO_SKIP_LIST.has(repo.full_name)) continue;
    try {
      for await (const prs of client.paginate<GitHubPR>(
        `/repos/${repo.full_name}/pulls`,
        { state: 'all', per_page: '100', sort: 'updated', direction: 'desc' },
      )) {
        // Stop paginating once we pass the since date
        const newPrs = prs.filter((pr) => new Date(pr.updated_at) >= sinceDate);
        for (const pr of newPrs) {
          const item = prToContentItem(pr);
          await upsertContentItem(db, item);
          indexed++;
        }
        if (newPrs.length < prs.length) break; // rest are older, stop
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('403') && !message.includes('404')) {
        errors++;
        console.error(`[GitHub PRs] Failed for ${repo.full_name}: ${message}`);
      }
    }
  }

  await upsertSyncState(db, 'github-pr', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
  });

  return { indexed, errors };
}

function prToContentItem(pr: GitHubPR): Omit<ContentItem, 'id' | 'indexedAt'> {
  return {
    source: 'github-pr',
    sourceId: String(pr.id),
    title: pr.title,
    summary: `PR #${pr.number} in ${pr.base.repo.full_name} (${pr.state}): ${pr.title}`,
    body: pr.body ?? '',
    publishedAt: new Date(pr.created_at).toISOString(),
    url: pr.html_url,
    projectContext: resolveProjectContext(pr.base.repo.full_name),
    metadata: {
      number: pr.number,
      state: pr.state,
      repo: pr.base.repo.full_name,
      authorLogin: pr.user.login,
      updatedAt: pr.updated_at,
    },
    tags: pr.labels.map((l) => l.name),
  };
}
