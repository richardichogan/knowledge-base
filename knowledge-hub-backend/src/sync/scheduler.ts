import { SYNC_CADENCE_MINUTES, DEFAULT_SYNC_CADENCE_MINUTES, MS_PER_MINUTE, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { runTier1Sync } from './syncOrchestrator.js';
import { archiveCompletedTasks } from '../services/taskArchiveService.js';
import { runTaxonomyHealthReport } from '../jobs/taxonomyHealthReport.js';
import { runInferredEdgeJob } from '../jobs/inferredEdgeJob.js';
import { syncAllNodes } from '../services/nodeService.js';
import { populateExplicitEdges } from '../jobs/explicitEdgePopulator.js';

/**
 * Simple interval-based scheduler for sync jobs.
 * One timer per source group — cadence defined in constants.ts.
 * Call start() once on server startup.
 */

const MS_PER_HOUR  = 60 * MS_PER_MINUTE;
const MS_PER_DAY   = 24 * MS_PER_HOUR;
const DAYS_PER_WEEK = 7;
const MS_PER_WEEK  = DAYS_PER_WEEK * MS_PER_DAY;

const timers: ReturnType<typeof setInterval>[] = [];

export function startSyncScheduler(): void {
  console.warn('[Scheduler] Starting sync scheduler...');

  const db = getDb();
  const cadenceMinutes = SYNC_CADENCE_MINUTES['cms'] ?? DEFAULT_SYNC_CADENCE_MINUTES;
  const interval = cadenceMinutes * MS_PER_MINUTE;

  // Delay the initial sync by 30 s so the server is fully ready and
  // the first page load isn't competing with outbound sync HTTP calls
  setTimeout(() => {
    console.warn('[Scheduler] Running initial sync on startup...');
    runTier1Sync(db).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Scheduler] Initial sync failed:', message);
    });
  }, INITIAL_SYNC_DELAY_MS);

  // Then repeat on the cadence
  timers.push(
    setInterval(() => {
      runTier1Sync(db).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Scheduler] Tier 1 sync failed:', message);
      });
    }, interval),
  );

  console.warn(`[Scheduler] Tier 1 sync scheduled every ${cadenceMinutes} minutes`);

  // Archive completed tasks nightly (runs once per day)
  timers.push(
    setInterval(() => {
      archiveCompletedTasks(db).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Scheduler] Task archive job failed:', message);
      });
    }, MS_PER_DAY),
  );
  console.warn('[Scheduler] Task archive job scheduled daily');

  // Weekly taxonomy health report
  timers.push(
    setInterval(() => {
      runTaxonomyHealthReport(db).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Scheduler] Taxonomy health report failed:', message);
      });
    }, MS_PER_WEEK),
  );
  console.warn('[Scheduler] Taxonomy health report scheduled weekly');

  // Nightly inferred edge job — post-sync node + explicit edges + AI inference
  timers.push(
    setInterval(() => {
      const db2 = getDb();
      syncAllNodes(db2)
        .then(() => populateExplicitEdges(db2))
        .then(() => runInferredEdgeJob(db2))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[Scheduler] Graph sync failed:', message);
        });
    }, MS_PER_DAY),
  );
  console.warn('[Scheduler] Graph node/edge sync scheduled daily');
}

/** Clears all scheduled timers. Call on graceful shutdown. */
export function stopSyncScheduler(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.length = 0;
  console.warn('[Scheduler] Sync scheduler stopped.');
}
