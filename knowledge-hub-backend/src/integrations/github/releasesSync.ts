/**
 * releasesSync.ts
 *
 * Syncs GitHub Releases for all user repos.
 * A release represents a shipped version — much higher signal than a commit.
 *
 * API: GET /repos/{owner}/{repo}/releases
 */

import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK, MAX_PAGE_SIZE } from '../../config/constants.js';
import { loadProjectContextCache, resolveProjectContext } from './projectContext.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitHubRepo {
  full_name: string;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  html_url: string;
  author: { login: string };
  assets: Array<{ name: string }>;
  target_commitish: string;
}

export async function syncGitHubReleases(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  await loadProjectContextCache(db);

  const syncState = await getSyncState(db, 'github-release');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);

  const repos: GitHubRepo[] = [];
  for await (const page of client.paginate<GitHubRepo>(`/user/repos`, { type: 'all' })) {
    repos.push(...page);
  }

  for (const repo of repos) {
    try {
      for await (const releases of client.paginate<GitHubRelease>(
        `/repos/${repo.full_name}/releases`,
        { per_page: String(MAX_PAGE_SIZE) },
      )) {
        let reachedOld = false;
        for (const release of releases) {
          if (release.draft) continue;
          const publishedAt = release.published_at ?? release.created_at;
          if (new Date(publishedAt) < sinceDate) { reachedOld = true; break; }
          await upsertContentItem(db, releaseToContentItem(release, repo.full_name));
          indexed++;
        }
        if (reachedOld) break;
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('404')) {
        console.error(`[GitHub releases] Failed for ${repo.full_name}: ${message}`);
      }
    }
  }

  await upsertSyncState(db, 'github-release', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} repos with errors` : null,
  });

  return { indexed, errors };
}

function releaseToContentItem(
  release: GitHubRelease,
  repoFullName: string,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const name = release.name ?? release.tag_name;
  const publishedAt = release.published_at ?? release.created_at;
  const label = release.prerelease ? 'pre-release' : 'release';

  return {
    source: 'github-release',
    sourceId: String(release.id),
    title: `${repoFullName} — ${name}`,
    summary: `${label} ${release.tag_name} published for ${repoFullName}`,
    body: release.body ?? '',
    publishedAt: new Date(publishedAt).toISOString(),
    url: release.html_url,
    projectContext: resolveProjectContext(repoFullName),
    metadata: {
      repo: repoFullName,
      tagName: release.tag_name,
      name,
      prerelease: release.prerelease,
      branch: release.target_commitish,
      authorLogin: release.author.login,
      assetCount: release.assets.length,
    },
    tags: release.prerelease ? ['pre-release'] : ['release'],
  };
}
