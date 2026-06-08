import { SYNC_CADENCE_MINUTES, DEFAULT_SYNC_CADENCE_MINUTES, MS_PER_MINUTE, MS_PER_DAY, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { runTier1Sync } from './syncOrchestrator.js';
import { runInferredEdgeJob } from '../jobs/inferredEdgeJob.js';

/**
 * Simple interval-based scheduler for sync jobs.
 * In development mode, AI-backed jobs (inferred edges, article scoring) are
 * skipped entirely to avoid burning Azure AI Foundry credits locally.
 * Only production runs those jobs.
 */

const NIGHTLY_HOUR = 2; // 02:00 local server time
const timers: ReturnType<typeof setInterval>[] = [];

function msUntilNightly(): number {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(NIGHTLY_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startSyncScheduler(): void {
  console.warn('[Scheduler] Starting sync scheduler...');

  const db             = getDb();
  const cadenceMinutes = SYNC_CADENCE_MINUTES['cms'] ?? DEFAULT_SYNC_CADENCE_MINUTES;
  const interval       = cadenceMinutes * MS_PER_MINUTE;

  // Initial data sync after 30 s — runs in all environments
  setTimeout(() => {
    console.warn('[Scheduler] Running initial sync on startup...');
    runTier1Sync(db).catch((err: unknown) => {
      console.error('[Scheduler] Initial sync failed:', err instanceof Error ? err.message : String(err));
    });
  }, INITIAL_SYNC_DELAY_MS);

  timers.push(
    setInterval(() => {
      runTier1Sync(db).catch((err: unknown) => {
        console.error('[Scheduler] Tier 1 sync failed:', err instanceof Error ? err.message : String(err));
      });
    }, interval),
  );
  console.warn(`[Scheduler] Tier 1 sync scheduled every ${cadenceMinutes} minutes`);

  // AI jobs — production only. Skipped in development to avoid Foundry spend.
  if (env.isDevelopment) {
    console.warn('[Scheduler] Development mode — inferred edge job DISABLED (no Foundry calls).');
    return;
  }

  const nightlyDelay = msUntilNightly();
  setTimeout(() => {
    void runInferredEdgeJob(db).catch((err: unknown) => {
      console.error('[Scheduler] Inferred edge job failed:', err instanceof Error ? err.message : String(err));
    });
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
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  console.warn('[Scheduler] Sync scheduler stopped.');
}
