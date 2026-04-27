import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { loadProjectContextCache, resolveProjectContext } from './projectContext.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitHubIssue {
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
  pull_request?: unknown; // present on PRs — skip these
  repository_url: string;
}

export async function syncGitHubIssues(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  await loadProjectContextCache(db);

  // Only fetch issues updated since last sync
  const syncState = await getSyncState(db, 'github-issue');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);
  const since = sinceDate.toISOString();

  try {
    for await (const issues of client.paginate<GitHubIssue>(
      `/user/issues`,
      { filter: 'created', state: 'all', per_page: '100', since },
    )) {
      for (const issue of issues) {
        // Skip pull requests — they have pull_request field
        if (issue.pull_request !== undefined) continue;

        const item = issueToContentItem(issue);
        await upsertContentItem(db, item);
        indexed++;
      }
    }
  } catch (err) {
    errors++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[GitHub issues] Failed: ${message}`);
  }

  await upsertSyncState(db, 'github-issue', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
  });

  return { indexed, errors };
}

/** Creates a GitHub issue — used by the AI write action layer. */
export async function createGitHubIssue(
  repo: string,
  title: string,
  body?: string,
  labels?: string[],
): Promise<string> {
  const client = new GitHubClient();
  const result = await client.post<{ html_url: string }>(`/repos/${repo}/issues`, {
    title,
    body,
    labels,
  });
  return result.html_url;
}

function issueToContentItem(issue: GitHubIssue): Omit<ContentItem, 'id' | 'indexedAt'> {
  const repoPath = issue.repository_url.replace('https://api.github.com/repos/', '');
  return {
    source: 'github-issue',
    sourceId: String(issue.id),
    title: issue.title,
    summary: `Issue #${issue.number} in ${repoPath} (${issue.state}): ${issue.title}`,
    body: issue.body ?? '',
    publishedAt: new Date(issue.created_at).toISOString(),
    url: issue.html_url,
    projectContext: resolveProjectContext(repoPath),
    metadata: {
      number: issue.number,
      state: issue.state,
      repo: repoPath,
      authorLogin: issue.user.login,
      updatedAt: issue.updated_at,
    },
    tags: issue.labels.map((l) => l.name),
  };
}

// Suppress env unused warning
void env;
