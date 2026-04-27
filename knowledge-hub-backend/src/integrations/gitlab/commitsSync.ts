import type { Pool } from 'pg';
import { GitLabClient } from './gitlabClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK } from '../../config/constants.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  created_at: string;
  web_url: string;
  project_id: number;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
}

/**
 * Syncs recent commits from all accessible GitLab projects into the index.
 * Uses the last sync timestamp as the `since` filter so only new commits are fetched.
 * Falls back to DAYS_INITIAL_SYNC_LOOKBACK days on first run.
 */
export async function syncGitLabCommits(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = new GitLabClient();
  let indexed = 0;
  let errors = 0;

  // Determine the earliest date to fetch — use last sync time so we only pull new commits.
  // Fall back to DAYS_INITIAL_SYNC_LOOKBACK days ago on first run.
  const syncState = await getSyncState(db, 'gitlab-commit');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);
  const since = sinceDate.toISOString();

  // Fetch projects for the configured user
  const projects: GitLabProject[] = [];
  for await (const page of client.paginate<GitLabProject>(
    `/users/${env.GITLAB_USER_ID}/projects`,
    { per_page: '100' },
  )) {
    projects.push(...page);
  }

  // Also fetch group projects if GITLAB_GROUP is configured
  if (env.GITLAB_GROUP) {
    for await (const page of client.paginate<GitLabProject>(
      `/groups/${env.GITLAB_GROUP}/projects`,
      { per_page: '100', include_subgroups: 'true' },
    )) {
      projects.push(...page);
    }
  }

  // Deduplicate by project id
  const seen = new Set<number>();
  const uniqueProjects = projects.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  for (const project of uniqueProjects) {
    try {
      for await (const commits of client.paginate<GitLabCommit>(
        `/projects/${project.id}/repository/commits`,
        { since, all: 'true' },
      )) {
        for (const commit of commits) {
          const item = commitToContentItem(commit, project);
          await upsertContentItem(db, item);
          indexed++;
        }
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitLab commits] Failed for project ${project.path_with_namespace}: ${message}`);
    }
  }

  await upsertSyncState(db, 'gitlab-commit', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
  });

  return { indexed, errors };
}

function commitToContentItem(
  commit: GitLabCommit,
  project: GitLabProject,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  return {
    source: 'gitlab-commit',
    sourceId: commit.id,
    title: commit.title,
    summary: `${project.path_with_namespace} — ${commit.short_id}: ${commit.title}`,
    body: commit.message,
    publishedAt: new Date(commit.created_at).toISOString(),
    url: commit.web_url,
    projectContext: 'personal',
    metadata: {
      projectId: commit.project_id,
      projectPath: project.path_with_namespace,
      authorName: commit.author_name,
      shortId: commit.short_id,
    },
    tags: [],
  };
}
