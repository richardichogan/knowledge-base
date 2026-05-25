import { SYNC_CADENCE_MINUTES, DEFAULT_SYNC_CADENCE_MINUTES, MS_PER_MINUTE, MS_PER_DAY, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { runTier1Sync } from './syncOrchestrator.js';
import { runInferredEdgeJob } from '../jobs/inferredEdgeJob.js';

/**
 * Simple interval-based scheduler for sync jobs.
 * One timer per source group — cadence defined in constants.ts.
 * Call start() once on server startup.
 *
 * NOTE: Auto-tagging of new items is handled inline in upsertContentItem (queries.ts)
 * so there is no need for a separate tagging pass here. Scoring of new discovered
 * articles is handled inside syncDiscoveredArticles via scoreUnscored(), which
 * only calls the AI for items that have no relevance_explanation yet.
 */

const NIGHTLY_HOUR = 2; // 02:00 local server time

const timers: ReturnType<typeof setInterval>[] = [];

/**
 * Returns milliseconds until the next 02:00 local time.
 * If 02:00 has already passed today, returns delay to tomorrow's 02:00.
 */
function msUntilNightly(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startSyncScheduler(): void {
  console.warn('[Scheduler] Starting sync scheduler...');

  const db = getDb();
  const cadenceMinutes = SYNC_CADENCE_MINUTES['cms'] ?? DEFAULT_SYNC_CADENCE_MINUTES;
  const interval = cadenceMinutes * MS_PER_MINUTE;

  // Delay the initial sync by 30 s so the server is fully ready and
  // the first page load isn't competing with outbound sync HTTP calls
  setTimeout(() => {
    console.warn('[Scheduler] Running initial sync on startup...');
    runTier1Sync(db)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Scheduler] Initial sync failed:', message);
      });
  }, INITIAL_SYNC_DELAY_MS);

  // Then repeat on the cadence
  timers.push(
    setInterval(() => {
      runTier1Sync(db)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[Scheduler] Tier 1 sync failed:', message);
        });
    }, interval),
  );

  console.warn(`[Scheduler] Tier 1 sync scheduled every ${cadenceMinutes} minutes`);

  // Nightly inferred-edge job — runs at 02:00 local server time.
  const nightlyDelay = msUntilNightly();
  setTimeout(() => {
    void runInferredEdgeJob(db).catch((err: unknown) => {
      console.error('[Scheduler] Inferred edge job failed:', err instanceof Error ? err.message : String(err));
    });
    // Re-schedule every 24 hours after the first run
    timers.push(
      setInterval(() => {
        void runInferredEdgeJob(db).catch((err: unknown) => {
          console.error('[Scheduler] Inferred edge job failed:', err instanceof Error ? err.message : String(err));
        });
      }, MS_PER_DAY),
    );
  }, nightlyDelay);
  console.warn(`[Scheduler] Inferred edge job scheduled nightly at 02:00 (in ${Math.round(nightlyDelay / MS_PER_MINUTE)} min)`);
}

/** Clears all scheduled timers. Call on graceful shutdown. */
export function stopSyncScheduler(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.length = 0;
  console.warn('[Scheduler] Sync scheduler stopped.');
}
