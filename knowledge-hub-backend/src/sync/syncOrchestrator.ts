import type { Pool } from 'pg';
import { indexAllPosts } from '../integrations/cms/postIndexer.js';
import { syncDiscoveredArticles } from '../integrations/cms/discoveredArticlesSync.js';
import { syncGitLabCommits } from '../integrations/gitlab/commitsSync.js';
import { syncGitLabMergeRequests } from '../integrations/gitlab/mergeRequestsSync.js';
import { syncGitLabIssues } from '../integrations/gitlab/issuesSync.js';
import { syncGitLabPipelines } from '../integrations/gitlab/pipelineSync.js';
import { syncGitHubCommits } from '../integrations/github/commitsSync.js';
import { syncGitHubPullRequests } from '../integrations/github/pullRequestsSync.js';
import { syncGitHubIssues } from '../integrations/github/issuesSync.js';
import { syncGitHubActions } from '../integrations/github/actionsSync.js';
import { syncGitHubReleases } from '../integrations/github/releasesSync.js';
import { syncGitHubDeployments } from '../integrations/github/deploymentsSync.js';
import { syncGitHubPRReviews } from '../integrations/github/prReviewsSync.js';
import { syncGitLabReleases } from '../integrations/gitlab/releasesSync.js';
import { syncGitLabDeployments } from '../integrations/gitlab/deploymentsSync.js';
import { syncCalendarEvents } from '../integrations/graph/calendarSync.js';
import { syncTodoTasks } from '../integrations/graph/todoSync.js';
import { syncGraphMail } from '../integrations/graph/graphMailSync.js';
import { syncProjectDocs } from '../integrations/github/projectDocsSync.js';
import { syncCfps } from '../services/cfpSyncService.js';

export interface SyncResult {
  source: string;
  indexed: number;
  errors: number;
  durationMs: number;
}

export interface OrchestratorResult {
  results: SyncResult[];
  totalIndexed: number;
  totalErrors: number;
  totalDurationMs: number;
}

/**
 * Runs all Tier 1 source syncs sequentially.
 * Running in parallel exhausted the pg connection pool (max 10) causing
 * API requests to hang waiting for a connection. Sequential execution
 * keeps pool usage low so the API stays responsive during sync.
 * Sources that fail are logged but do not block other sources.
 */
export async function runTier1Sync(db: Pool): Promise<OrchestratorResult> {
  const sources: Array<{ name: string; sync: (db: Pool) => Promise<{ indexed: number; errors: number }> }> = [
    { name: 'cms',              sync: indexAllPosts },
    { name: 'discovered-articles', sync: syncDiscoveredArticles },
    { name: 'gitlab-commits',   sync: syncGitLabCommits },
    { name: 'gitlab-mrs',       sync: syncGitLabMergeRequests },
    { name: 'gitlab-issues',    sync: syncGitLabIssues },
    { name: 'gitlab-pipelines', sync: syncGitLabPipelines },
    { name: 'github-commits',   sync: syncGitHubCommits },
    { name: 'github-prs',       sync: syncGitHubPullRequests },
    { name: 'github-issues',    sync: syncGitHubIssues },
    { name: 'github-actions',      sync: syncGitHubActions },
    { name: 'github-releases',     sync: syncGitHubReleases },
    { name: 'github-deployments',  sync: syncGitHubDeployments },
    { name: 'github-pr-reviews',   sync: syncGitHubPRReviews },
    { name: 'gitlab-releases',     sync: syncGitLabReleases },
    { name: 'gitlab-deployments',  sync: syncGitLabDeployments },
    { name: 'graph-calendar',   sync: syncCalendarEvents },
    { name: 'graph-todo',       sync: syncTodoTasks },
    { name: 'graph-mail',       sync: syncGraphMail },
    { name: 'project-docs',     sync: syncProjectDocs },
    { name: 'cfps',             sync: syncCfps },
  ];

  const results: SyncResult[] = [];

  for (const { name, sync } of sources) {
    const start = Date.now();
    try {
      const { indexed, errors } = await sync(db);
      const durationMs = Date.now() - start;
      console.warn(`[Sync] ${name}: indexed=${indexed}, errors=${errors}, ms=${durationMs}`);
      results.push({ source: name, indexed, errors, durationMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Sync] ${name} failed entirely: ${message}`);
      results.push({ source: name, indexed: 0, errors: 1, durationMs: Date.now() - start });
    }
  }

  const totalIndexed = results.reduce((sum, r) => sum + r.indexed, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  return { results, totalIndexed, totalErrors, totalDurationMs };
}
