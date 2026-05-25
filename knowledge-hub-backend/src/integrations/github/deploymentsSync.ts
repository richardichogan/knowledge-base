/**
 * deploymentsSync.ts
 *
 * Syncs GitHub Deployments for all user repos.
 * Shows when code went live to which environment (production, staging, etc.).
 *
 * API: GET /repos/{owner}/{repo}/deployments
 */

import type { Pool } from 'pg';
import { GitHubClient } from './githubClient.js';
import { upsertContentItem, upsertSyncState, getSyncState } from '../../db/queries.js';
import { MS_PER_DAY, DAYS_INITIAL_SYNC_LOOKBACK, MAX_PAGE_SIZE, GITHUB_REPO_SKIP_LIST } from '../../config/constants.js';
import { loadProjectContextCache, resolveProjectContext } from './projectContext.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitHubRepo {
  full_name: string;
}

interface GitHubDeployment {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  creator: { login: string } | null;
  statuses_url: string;
}

interface GitHubDeploymentStatus {
  state: string; // success | failure | pending | in_progress | queued | inactive
  created_at: string;
  description: string | null;
  environment_url: string | null;
  log_url: string | null;
}

const SHORT_SHA_LENGTH = 7;

export async function syncGitHubDeployments(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  await loadProjectContextCache(db);

  const syncState = await getSyncState(db, 'github-deployment');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);

  const repos: GitHubRepo[] = [];
  for await (const page of client.paginate<GitHubRepo>(`/user/repos`, { type: 'all' })) {
    repos.push(...page);
  }

  for (const repo of repos) {
    if (GITHUB_REPO_SKIP_LIST.has(repo.full_name)) continue;
    try {
      for await (const deployments of client.paginate<GitHubDeployment>(
        `/repos/${repo.full_name}/deployments`,
        { per_page: String(MAX_PAGE_SIZE) },
      )) {
        let reachedOld = false;
        for (const deployment of deployments) {
          if (new Date(deployment.created_at) < sinceDate) { reachedOld = true; break; }

          // Fetch the latest status for this deployment
          let latestStatus: GitHubDeploymentStatus | null = null;
          try {
            const statuses = await client.get<GitHubDeploymentStatus[]>(
              `/repos/${repo.full_name}/deployments/${deployment.id}/statuses`,
              { per_page: '1' },
            );
            latestStatus = statuses[0] ?? null;
          } catch {
            // Status fetch failing is non-fatal
          }

          await upsertContentItem(
            db,
            deploymentToContentItem(deployment, repo.full_name, latestStatus),
          );
          indexed++;
        }
        if (reachedOld) break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('403') && !message.includes('404')) {
        errors++;
        console.error(`[GitHub deployments] Failed for ${repo.full_name}: ${message}`);
      }
    }
  }

  await upsertSyncState(db, 'github-deployment', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} repos with errors` : null,
  });

  return { indexed, errors };
}

function deploymentToContentItem(
  deployment: GitHubDeployment,
  repoFullName: string,
  status: GitHubDeploymentStatus | null,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const shortSha = deployment.sha.substring(0, SHORT_SHA_LENGTH);
  const state = status?.state ?? 'pending';
  const env = deployment.environment;
  const title = `Deploy to ${env} — ${repoFullName} (${state})`;
  const summary = `${repoFullName}: deployed ${shortSha} to ${env} — ${state}`;
  const url = status?.environment_url ?? status?.log_url ?? null;

  return {
    source: 'github-deployment',
    sourceId: String(deployment.id),
    title,
    summary,
    body: [
      `**Repo:** ${repoFullName}`,
      `**Environment:** ${env}`,
      `**Ref:** ${deployment.ref}`,
      `**Commit:** ${shortSha}`,
      `**State:** ${state}`,
      deployment.description ? `**Description:** ${deployment.description}` : '',
      deployment.creator ? `**Deployed by:** ${deployment.creator.login}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    publishedAt: new Date(deployment.created_at).toISOString(),
    ...(url !== null && { url }),
    projectContext: resolveProjectContext(repoFullName),
    metadata: {
      repo: repoFullName,
      environment: env,
      ref: deployment.ref,
      shortSha,
      state,
      deployedBy: deployment.creator?.login ?? null,
    },
    tags: [env, state],
  };
}
