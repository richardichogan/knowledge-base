/**
 * deploymentsSync.ts (GitLab)
 *
 * Syncs GitLab Deployments for all accessible projects.
 * API: GET /projects/{id}/deployments
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

interface GitLabDeployment {
  id: number;
  iid: number;
  ref: string;
  sha: string;
  created_at: string;
  updated_at: string;
  status: string;
  environment: { name: string };
  deployable: { web_url: string } | null;
  user: { username: string } | null;
}

export async function syncGitLabDeployments(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = new GitLabClient();
  let indexed = 0;
  let errors = 0;

  const syncState = await getSyncState(db, 'gitlab-deployment');
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
      for await (const deployments of client.paginate<GitLabDeployment>(
        `/projects/${project.id}/deployments`,
        { per_page: '20', order_by: 'created_at', sort: 'desc' },
      )) {
        let reachedOld = false;
        for (const deployment of deployments) {
          if (new Date(deployment.created_at) < sinceDate) { reachedOld = true; break; }
          await upsertContentItem(
            db,
            deploymentToContentItem(deployment, project.path_with_namespace),
          );
          indexed++;
        }
        if (reachedOld) break;
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('404')) {
        console.error(`[GitLab deployments] Failed for ${project.path_with_namespace}: ${message}`);
      }
    }
  }

  await upsertSyncState(db, 'gitlab-deployment', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} projects with errors` : null,
  });

  return { indexed, errors };
}

const STATUS_EMOJI: Record<string, string> = {
  success: '✅',
  failed: '❌',
  running: '🔄',
  canceled: '⛔',
  created: '🆕',
  blocked: '🚫',
};

function deploymentToContentItem(
  deployment: GitLabDeployment,
  projectPath: string,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const emoji = STATUS_EMOJI[deployment.status] ?? '📦';
  const env_ = deployment.environment.name;

  return {
    source: 'gitlab-deployment',
    sourceId: String(deployment.id),
    title: `${emoji} Deploy #${deployment.iid} → ${env_} — ${projectPath} (${deployment.ref})`,
    summary: `${projectPath} deployed to ${env_} from ${deployment.ref}: ${deployment.status}`,
    body: '',
    publishedAt: new Date(deployment.created_at).toISOString(),
    url: deployment.deployable?.web_url ?? '',
    projectContext: projectPath.split('/').pop() ?? 'personal',
    metadata: {
      iid: deployment.iid,
      ref: deployment.ref,
      sha: deployment.sha,
      status: deployment.status,
      environment: env_,
      projectPath,
      username: deployment.user?.username ?? null,
      updatedAt: deployment.updated_at,
    },
    tags: [env_, deployment.status],
  };
}
