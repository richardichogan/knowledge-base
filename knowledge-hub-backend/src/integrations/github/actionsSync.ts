/**
 * actionsSync.ts
 *
 * Syncs GitHub Actions workflow runs for all user repos.
 * Each run is stored as a content_item with source 'github-action'.
 *
 * API used: GET /repos/{owner}/{repo}/actions/runs
 * Docs: https://docs.github.com/en/rest/actions/workflow-runs
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

interface WorkflowRun {
  id: number;
  name: string | null;
  head_branch: string;
  head_sha: string;
  status: string;        // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | skipped | ...
  created_at: string;
  updated_at: string;
  html_url: string;
  run_number: number;
  workflow_id: number;
  repository: { full_name: string };
  triggering_actor: { login: string } | null;
}

interface WorkflowRunsPage {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

const SHORT_SHA_LENGTH = 7;

export async function syncGitHubActions(db: Pool): Promise<{ indexed: number; errors: number }> {
  const client = new GitHubClient();
  let indexed = 0;
  let errors = 0;

  await loadProjectContextCache(db);

  const syncState = await getSyncState(db, 'github-action');
  const sinceDate = syncState?.lastSyncAt
    ? syncState.lastSyncAt
    : new Date(Date.now() - DAYS_INITIAL_SYNC_LOOKBACK * MS_PER_DAY);

  // Fetch all repos the user has access to
  const repos: GitHubRepo[] = [];
  for await (const page of client.paginate<GitHubRepo>(`/user/repos`, { type: 'all' })) {
    repos.push(...page);
  }

  for (const repo of repos) {
    if (GITHUB_REPO_SKIP_LIST.has(repo.full_name)) continue;
    try {
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const data = await client.get<WorkflowRunsPage>(
          `/repos/${repo.full_name}/actions/runs`,
          { per_page: String(MAX_PAGE_SIZE), page: String(page) },
        );

        if (data.workflow_runs.length === 0) break;

        for (const run of data.workflow_runs) {
          // Runs are returned newest-first. Stop as soon as we pass sinceDate.
          if (new Date(run.created_at) < sinceDate) {
            hasMore = false;
            break;
          }
          const item = runToContentItem(run);
          await upsertContentItem(db, item);
          indexed++;
        }

        if (data.workflow_runs.length < MAX_PAGE_SIZE) hasMore = false;
        page++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 403/404 = org-restricted or Actions disabled — skip silently
      if (!message.includes('403') && !message.includes('404')) {
        errors++;
        console.error(`[GitHub actions] Failed for ${repo.full_name}: ${message}`);
      }
    }
  }

  await upsertSyncState(db, 'github-action', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} repos with errors` : null,
  });

  return { indexed, errors };
}

function runToContentItem(run: WorkflowRun): Omit<ContentItem, 'id' | 'indexedAt'> {
  const repoFullName = run.repository.full_name;
  const shortSha = run.head_sha.substring(0, SHORT_SHA_LENGTH);
  const workflowName = run.name ?? 'Workflow';
  const conclusionLabel = run.conclusion ?? run.status;
  const title = `${workflowName} #${run.run_number} — ${conclusionLabel}`;
  const summary =
    `${repoFullName}: ${workflowName} run #${run.run_number} on ${run.head_branch} — ${conclusionLabel}`;

  return {
    source: 'github-action',
    sourceId: String(run.id),
    title,
    summary,
    body: [
      `**Workflow:** ${workflowName}`,
      `**Branch:** ${run.head_branch}`,
      `**Commit:** ${shortSha}`,
      `**Status:** ${run.status}`,
      `**Conclusion:** ${run.conclusion ?? 'n/a'}`,
      `**Run:** #${run.run_number}`,
      run.triggering_actor ? `**Triggered by:** ${run.triggering_actor.login}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    publishedAt: new Date(run.created_at).toISOString(),
    url: run.html_url,
    projectContext: resolveProjectContext(repoFullName),
    metadata: {
      repo: repoFullName,
      branch: run.head_branch,
      shortSha,
      status: run.status,
      conclusion: run.conclusion,
      runNumber: run.run_number,
      workflowId: run.workflow_id,
      triggeredBy: run.triggering_actor?.login ?? null,
    },
    tags: [conclusionLabel],
  };
}
