import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK } from '../../config/constants.js';
import { loadProjectContextCache, resolveProjectContext } from './projectContext.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitHubRepo {
  name: string;
  full_name: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  html_url: string;
}

export async function syncGitHubCommits(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  await loadProjectContextCache(db);

  // Only fetch commits since last sync — prevents re-indexing all history on every run
  const syncState = await getSyncState(db, 'github-commit');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);
  const since = sinceDate.toISOString();

  const repos: GitHubRepo[] = [];
  for await (const page of client.paginate<GitHubRepo>(`/user/repos`, {
    type: 'all',
  })) {
    repos.push(...page);
  }

  for (const repo of repos) {
    try {
      const commitParams: Record<string, string> = { per_page: '100', since };
      for await (const commits of client.paginate<GitHubCommit>(
        `/repos/${repo.full_name}/commits`,
        commitParams,
      )) {
        for (const commit of commits) {
          const item = commitToContentItem(commit, repo);
          await upsertContentItem(db, item);
          indexed++;
        }
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitHub commits] Failed for ${repo.full_name}: ${message}`);
    }
  }

  await upsertSyncState(db, 'github-commit', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
  });

  return { indexed, errors };
}

const SHORT_SHA_LENGTH = 7;

function commitToContentItem(
  commit: GitHubCommit,
  repo: GitHubRepo,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const firstLine = commit.commit.message.split('\n')[0] ?? commit.commit.message;
  const shortSha = commit.sha.substring(0, SHORT_SHA_LENGTH);
  return {
    source: 'github-commit',
    sourceId: commit.sha,
    title: firstLine,
    summary: `${repo.full_name} — ${shortSha}: ${firstLine}`,
    body: commit.commit.message,
    publishedAt: new Date(commit.commit.author.date).toISOString(),
    url: commit.html_url,
    projectContext: resolveProjectContext(repo.full_name),
    metadata: {
      repo: repo.full_name,
      authorName: commit.commit.author.name,
      shortSha,
    },
    tags: [],
  };
}
