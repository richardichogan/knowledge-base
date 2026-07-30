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
import { syncAllNodes } from '../services/nodeService.js';
import { populateExplicitEdges } from '../jobs/explicitEdgePopulator.js';

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
 * Re-entrancy guard. A full Tier 1 sync is a long-running job (tens of minutes
 * on the Burstable DB). It can be triggered from three places — the startup
 * initial sync, the 5-minute scheduler, and the manual POST /api/sources/sync
 * endpoint — none of which previously coordinated. Overlapping runs stacked up,
 * each holding pg pool connections, eventually starving the pool so the API
 * could no longer acquire a client ("timeout exceeded when trying to connect")
 * and the UI lost all data until the container was restarted — which then fired
 * a fresh initial sync, repeating the cycle. This module-level lock guarantees
 * only one sync ever runs at a time (single replica), so the pool always has
 * headroom for live API traffic.
 */
let syncInProgress = false;
let syncStartedAt: number | null = null;

/** True while a Tier 1 sync is actively running. */
export function isSyncInProgress(): boolean {
  return syncInProgress;
}

const EMPTY_RESULT: OrchestratorResult = {
  results: [],
  totalIndexed: 0,
  totalErrors: 0,
  totalDurationMs: 0,
};

/**
 * Runs all Tier 1 source syncs sequentially.
 * Running in parallel exhausted the pg connection pool (max 10) causing
 * API requests to hang waiting for a connection. Sequential execution
 * keeps pool usage low so the API stays responsive during sync.
 * Sources that fail are logged but do not block other sources.
 *
 * Guarded against concurrent invocation — if a sync is already running, the
 * call is skipped (see the re-entrancy guard note above).
 */
export async function runTier1Sync(db: Pool): Promise<OrchestratorResult> {
  if (syncInProgress) {
    const runningForSec = syncStartedAt ? Math.round((Date.now() - syncStartedAt) / 1000) : 0;
    console.warn(`[Sync] Skipped — a sync is already in progress (running for ${runningForSec}s). Refusing to start an overlapping run.`);
    return EMPTY_RESULT;
  }

  syncInProgress = true;
  syncStartedAt = Date.now();
  try {
    return await runTier1SyncInner(db);
  } finally {
    syncInProgress = false;
    syncStartedAt = null;
  }
}

async function runTier1SyncInner(db: Pool): Promise<OrchestratorResult> {
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

  // Sync all nodes from content tables, then rebuild explicit edges.
  // Errors are logged but do not fail the overall sync result.
  try {
    await syncAllNodes(db);
    console.warn('[Sync] syncAllNodes complete');
  } catch (err) {
    console.error('[Sync] syncAllNodes failed:', err instanceof Error ? err.message : String(err));
  }

  try {
    await populateExplicitEdges(db);
    console.warn('[Sync] populateExplicitEdges complete');
  } catch (err) {
    console.error('[Sync] populateExplicitEdges failed:', err instanceof Error ? err.message : String(err));
  }

  return { results, totalIndexed, totalErrors, totalDurationMs };
}
