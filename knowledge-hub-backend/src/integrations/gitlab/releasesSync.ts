/**
 * releasesSync.ts (GitLab)
 *
 * Syncs GitLab Releases for all accessible projects.
 * API: GET /projects/{id}/releases
 */

import type { Pool } from 'pg';
import { GitLabClient } from './gitlabClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK } from '../../config/constants.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitLabProject {
  id: number;
  path_with_namespace: string;
}

interface GitLabRelease {
  tag_name: string;
  name: string;
  description: string | null;
  created_at: string;
  released_at: string;
  _links: { self: string };
  author: { username: string } | null;
  milestones: Array<{ title: string }> | null;
}

export async function syncGitLabReleases(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = new GitLabClient();
  let indexed = 0;
  let errors = 0;

  const syncState = await getSyncState(db, 'gitlab-release');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);

  // Collect all projects
  const projects: GitLabProject[] = [];
  for await (const page of client.paginate<GitLabProject>(
    `/users/${env.GITLAB_USER_ID}/projects`,
    { per_page: '100' },
  )) {
    projects.push(...page);
  }
  if (env.GITLAB_GROUP) {
    for await (const page of client.paginate<GitLabProject>(
      `/groups/${env.GITLAB_GROUP}/projects`,
      { per_page: '100', include_subgroups: 'true' },
    )) {
      projects.push(...page);
    }
  }

  const seen = new Set<number>();
  const uniqueProjects = projects.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  for (const project of uniqueProjects) {
    try {
      for await (const releases of client.paginate<GitLabRelease>(
        `/projects/${project.id}/releases`,
        { per_page: '20' },
      )) {
        let reachedOld = false;
        for (const release of releases) {
          if (new Date(release.released_at) < sinceDate) { reachedOld = true; break; }
          await upsertContentItem(
            db,
            releaseToContentItem(release, project.path_with_namespace),
          );
          indexed++;
        }
        if (reachedOld) break;
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('404')) {
        console.error(`[GitLab releases] Failed for ${project.path_with_namespace}: ${message}`);
      }
    }
  }

  await upsertSyncState(db, 'gitlab-release', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} projects with errors` : null,
  });

  return { indexed, errors };
}

function releaseToContentItem(
  release: GitLabRelease,
  projectPath: string,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const name = release.name ?? release.tag_name;

  // Resolve project context by matching against PROJECTS gitlabPaths
  // (reuse the same pattern as other GL syncs — projectPath is the key)
  let projectContext = 'personal';
  // Lazy import avoided — projectContext resolved at DB level by sync orchestrator
  // after projects are seeded. Fall back to personal; backfill via re-sync.
  projectContext = projectPath.split('/').pop() ?? 'personal';

  return {
    source: 'gitlab-release',
    sourceId: `${projectPath}@${release.tag_name}`,
    title: `${projectPath} — ${name}`,
    summary: `Release ${release.tag_name} published for ${projectPath}`,
    body: release.description ?? '',
    publishedAt: new Date(release.released_at).toISOString(),
    url: release._links.self,
    projectContext,
    metadata: {
      projectPath,
      tagName: release.tag_name,
      name,
      authorUsername: release.author?.username ?? null,
      milestones: release.milestones?.map((m) => m.title) ?? [],
    },
    tags: ['release'],
  };
}
