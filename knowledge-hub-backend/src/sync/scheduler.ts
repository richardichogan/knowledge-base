import { MS_PER_MINUTE, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { runTier1Sync, isSyncInProgress } from './syncOrchestrator.js';
import { runInferredEdgeJob } from '../jobs/inferredEdgeJob.js';
import { runFoundryIqBackfillJob } from '../jobs/foundryIqBackfillJob.js';
import { runNoteReindexJob } from '../jobs/noteReindexJob.js';

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
const FOUNDRY_BACKFILL_INTERVAL_MS = 60 * MS_PER_MINUTE; // Sweep for un-indexed content_items hourly

const timers: ReturnType<typeof setInterval>[] = [];
let lastSyncHour = -1; // Track the last hour we ran sync to avoid double-runs
let lastEdgeDay = -1;  // Track the last day we ran inferred edges
let lastFoundryBackfillAt = 0; // Track the last time we ran the Foundry IQ backfill sweep

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
  if (now.getHours() < EDGE_JOB_HOUR) return false;
  if (lastEdgeDay === now.getDate()) return false;
  return true;
}

function shouldRunFoundryBackfill(): boolean {
  return Date.now() - lastFoundryBackfillAt >= FOUNDRY_BACKFILL_INTERVAL_MS;
}

export function startSyncScheduler(): void {
  console.warn('[Scheduler] Starting sync scheduler (08:00, 14:00, 20:00 — no overnight)...');

  const db = getDb();

  // Rebuild any note bodies still stored as raw BlockNote JSON in
  // content_items. Idempotent and a no-op once every note is plain text, so
  // it's safe to run on every boot. Must run before the hourly Foundry IQ
  // sweep gets a chance to re-embed, and deliberately runs independently of
  // working hours because a note indexed as raw JSON is effectively invisible
  // to search until it's fixed.
  void runNoteReindexJob(db).catch((err: unknown) => {
    console.error('[Scheduler] Note re-index job failed:', err instanceof Error ? err.message : String(err));
  });

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

      // Inferred edge job — production only, runs at 08:00 daily. Must NOT run
      // concurrently with a sync: both fan out DB work and together they starve
      // the pool, 500ing every live route. Defer until the sync has finished.
      if (!env.isDevelopment && shouldRunEdgeJob() && !isSyncInProgress()) {
        lastEdgeDay = new Date().getDate();
        console.warn('[Scheduler] Running daily inferred edge job...');
        void runInferredEdgeJob(db).catch((err: unknown) => {
          console.error('[Scheduler] Inferred edge job failed:', err instanceof Error ? err.message : String(err));
        });
      }

      // Foundry IQ backfill — production only, sweeps content_items for rows
      // never pushed (or since edited) into the semantic search index, so
      // every source type (commits, PRs, issues, emails, calendar, GitLab
      // items, etc.) is eventually queryable via search_knowledge_base, not
      // just documents/notes which are indexed live on write. Runs hourly,
      // bounded per run, deferred while a sync is in progress for the same
      // pool-contention reason as the edge job.
      if (!env.isDevelopment && shouldRunFoundryBackfill() && !isSyncInProgress()) {
        lastFoundryBackfillAt = Date.now();
        console.warn('[Scheduler] Running Foundry IQ backfill sweep...');
        void runFoundryIqBackfillJob(db).catch((err: unknown) => {
          console.error('[Scheduler] Foundry IQ backfill job failed:', err instanceof Error ? err.message : String(err));
        });
      }
    }, SYNC_CHECK_INTERVAL),
  );

  if (env.isDevelopment) {
    console.warn('[Scheduler] Development mode — inferred edge job and Foundry IQ backfill DISABLED.');
  } else {
    console.warn('[Scheduler] Inferred edge job scheduled daily at 08:00; Foundry IQ backfill sweep scheduled hourly.');
  }
}

/** Clears all scheduled timers. Call on graceful shutdown. */
export function stopSyncScheduler(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  console.warn('[Scheduler] Sync scheduler stopped.');
}
