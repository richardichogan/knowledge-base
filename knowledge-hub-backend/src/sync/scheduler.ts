import { MS_PER_MINUTE, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { runTier1Sync } from './syncOrchestrator.js';
import { runInferredEdgeJob } from '../jobs/inferredEdgeJob.js';

/**
 * Scheduler for sync jobs.
 *
 * Runs content discovery every 6 hours during working hours only (08:00–20:00).
 * Schedule: 08:00, 14:00, 20:00 — no overnight runs.
 *
 * In development mode, AI-backed jobs (inferred edges, article scoring) are
 * skipped to avoid burning Foundry credits locally.
 */

const SYNC_HOURS = [8, 14, 20]; // Run at these hours only
const SYNC_CHECK_INTERVAL = 5 * MS_PER_MINUTE; // Check every 5 min if it's time to run
const EDGE_JOB_HOUR = 8; // Run inferred edges at 08:00 daily

const timers: ReturnType<typeof setInterval>[] = [];
let lastSyncHour = -1; // Track the last hour we ran sync to avoid double-runs
let lastEdgeDay = -1;  // Track the last day we ran inferred edges

function isWithinWorkingHours(): boolean {
  const hour = new Date().getHours();
  return hour >= 8 && hour <= 20;
}

function shouldRunSync(): boolean {
  const now = new Date();
  const currentHour = now.getHours();
  if (!SYNC_HOURS.includes(currentHour)) return false;
  if (lastSyncHour === currentHour) return false;
  return true;
}

function shouldRunEdgeJob(): boolean {
  const now = new Date();
  if (now.getHours() !== EDGE_JOB_HOUR) return false;
  if (lastEdgeDay === now.getDate()) return false;
  return true;
}

export function startSyncScheduler(): void {
  console.warn('[Scheduler] Starting sync scheduler (08:00, 14:00, 20:00 — no overnight)...');

  const db = getDb();

  // Initial sync on startup (if within working hours)
  setTimeout(() => {
    if (isWithinWorkingHours()) {
      console.warn('[Scheduler] Running initial sync on startup...');
      lastSyncHour = new Date().getHours();
      runTier1Sync(db).catch((err: unknown) => {
        console.error('[Scheduler] Initial sync failed:', err instanceof Error ? err.message : String(err));
      });
    } else {
      console.warn('[Scheduler] Outside working hours (08:00–20:00) — skipping initial sync.');
    }
  }, INITIAL_SYNC_DELAY_MS);

  // Check every 5 minutes if it's time to run the scheduled sync
  timers.push(
    setInterval(() => {
      if (shouldRunSync()) {
        const hour = new Date().getHours();
        lastSyncHour = hour;
        console.warn(`[Scheduler] Running scheduled sync (${hour}:00)...`);
        runTier1Sync(db).catch((err: unknown) => {
          console.error('[Scheduler] Tier 1 sync failed:', err instanceof Error ? err.message : String(err));
        });
      }

      // Inferred edge job — production only, runs at 08:00 daily
      if (!env.isDevelopment && shouldRunEdgeJob()) {
        lastEdgeDay = new Date().getDate();
        console.warn('[Scheduler] Running daily inferred edge job...');
        void runInferredEdgeJob(db).catch((err: unknown) => {
          console.error('[Scheduler] Inferred edge job failed:', err instanceof Error ? err.message : String(err));
        });
      }
    }, SYNC_CHECK_INTERVAL),
  );

  if (env.isDevelopment) {
    console.warn('[Scheduler] Development mode — inferred edge job DISABLED.');
  } else {
    console.warn('[Scheduler] Inferred edge job scheduled daily at 08:00.');
  }
}

/** Clears all scheduled timers. Call on graceful shutdown. */
export function stopSyncScheduler(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  console.warn('[Scheduler] Sync scheduler stopped.');
}
