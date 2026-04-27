import { SYNC_CADENCE_MINUTES, DEFAULT_SYNC_CADENCE_MINUTES, MS_PER_MINUTE, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { runTier1Sync } from './syncOrchestrator.js';

/**
 * Simple interval-based scheduler for sync jobs.
 * One timer per source group — cadence defined in constants.ts.
 * Call start() once on server startup.
 */

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
}

/** Clears all scheduled timers. Call on graceful shutdown. */
export function stopSyncScheduler(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.length = 0;
  console.warn('[Scheduler] Sync scheduler stopped.');
}
