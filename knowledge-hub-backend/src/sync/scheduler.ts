import { runWeeklyMemoryReview } from '../ai/memorySuggestions.js';
import { runDueWatchlists } from '../services/discoverWatchlists.js';
import { MS_PER_MINUTE, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { runTier1Sync, isSyncInProgress } from './syncOrchestrator.js';
import { runInferredEdgeJob } from '../jobs/inferredEdgeJob.js';
import { runFoundryIqBackfillJob } from '../jobs/foundryIqBackfillJob.js';
import { runTaggingSweepJob } from '../jobs/taggingSweepJob.js';
import { runKnowledgeNightlyReviewJob } from '../jobs/knowledgeNightlyReviewJob.js';
import { runNoteReindexJob } from '../jobs/noteReindexJob.js';
import { briefingDue, generateMorningBriefing, workHour } from '../ai/morningBriefing.js';
import { weeklyDigestDue, generateWeeklyMicrosoftDigest } from '../ai/weeklyMicrosoftDigest.js';
import { tickBuildRunner } from '../build/buildRunner.js';
import { archiveCompletedTasks } from '../services/taskArchiveService.js';
import { isConnectionCheckInProgress } from './connectionWork.js';
import { runClaimedJob } from './runStore.js';
import { ukClock } from './ukClock.js';
import { generatePodcastPrep, PODCAST_PREP_END_UTC_HOUR, PODCAST_PREP_START_UTC_HOUR } from '../ai/podcastPrep.js';

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
const MEMORY_REVIEW_HOUR = 8;
const SYNC_CHECK_INTERVAL = 5 * MS_PER_MINUTE; // Check every 5 min if it's time to run
const CONNECTION_CHECK_MINUTES = 15;
export const CONNECTION_CHECK_INTERVAL_MS = CONNECTION_CHECK_MINUTES * MS_PER_MINUTE;
const FOUNDRY_BACKFILL_INTERVAL_MS = 60 * MS_PER_MINUTE; // Sweep for un-indexed content_items hourly
const BUILD_RUNNER_INTERVAL_MS = 2 * MS_PER_MINUTE; // Poll cloud-agent PRs for running build specs

const timers: ReturnType<typeof setInterval>[] = [];
let initialTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let lastSyncHour = -1; // Track the last hour we ran sync to avoid double-runs
let lastConnectionCheckAt = Date.now();
let lastArchiveDay = ''; // Date string of the last completed-task archive sweep
let lastMemoryReviewWeek = ''; // Week key of the last weekly memory review
let briefingRunning = false;
let weeklyDigestRunning = false;
let podcastPrepRunning = false;
let watchlistsRunning = false;
/** No briefing after this UK hour (e.g. a late restart) — it would no longer be a morning briefing. */
const BRIEFING_LATEST_HOUR = 18;
let lastFoundryBackfillAt = 0; // Track the last time we ran the Foundry IQ backfill sweep
const TAGGING_SWEEP_INTERVAL_MS = 60 * MS_PER_MINUTE; // Tag never-attempted items and retry failures hourly
let lastTaggingSweepAt = 0;
const KNOWLEDGE_REVIEW_UTC_HOUR = 2;
const ISO_DATE_LENGTH = 10;
let lastKnowledgeReviewDay = ''; // UTC date of the last nightly knowledge review attempt

function isWithinWorkingHours(): boolean {
  const hour = ukClock().hour;
  return hour >= 8 && hour <= 20;
}

function shouldRunSync(): boolean {
  const currentHour = ukClock().hour;
  if (!SYNC_HOURS.includes(currentHour)) return false;
  if (lastSyncHour === currentHour) return false;
  return true;
}

export function connectionCheckDue(now: number, lastRun: number): boolean {
  return now - lastRun >= CONNECTION_CHECK_INTERVAL_MS;
}

function shouldRunFoundryBackfill(): boolean {
  return Date.now() - lastFoundryBackfillAt >= FOUNDRY_BACKFILL_INTERVAL_MS;
}

export function startSyncScheduler(): void {
  if (started) return;
  if (env.NODE_ENV !== 'production') throw new Error('Scheduled jobs require production mode.');
  started = true;
  console.warn('[Scheduler] Starting sync scheduler (08:00, 14:00, 20:00 — no overnight)...');

  const db = getDb();
  function preparePodcastIfDue(): void {
    const clock = ukClock();
    if (clock.weekday !== 'Thu' || clock.hour < PODCAST_PREP_START_UTC_HOUR
      || clock.hour >= PODCAST_PREP_END_UTC_HOUR || podcastPrepRunning) return;
    podcastPrepRunning = true;
    void generatePodcastPrep(db).catch((error: unknown) => {
      console.error('[Scheduler] Podcast preparation failed:', error);
    }).finally(() => { podcastPrepRunning = false; });
  }

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
  initialTimer = setTimeout(() => {
    initialTimer = undefined;
    if (!started) return;
    preparePodcastIfDue();
    if (isWithinWorkingHours()) {
      console.warn('[Scheduler] Running initial sync on startup...');
      const clock = ukClock();
      lastSyncHour = clock.hour;
      runTier1Sync(db, `sync:${clock.day}:${clock.hour}`).catch((err: unknown) => {
        console.error('[Scheduler] Initial sync failed:', err instanceof Error ? err.message : String(err));
      });
    } else {
      console.warn('[Scheduler] Outside working hours (08:00–20:00) — skipping initial sync.');
    }
  }, INITIAL_SYNC_DELAY_MS);

  // Check every 5 minutes if it's time to run the scheduled sync
  timers.push(
    setInterval(() => {
      if (!started) return;
      preparePodcastIfDue();
      if (shouldRunSync() && !isConnectionCheckInProgress()) {
        const clock = ukClock();
        const hour = clock.hour;
        lastSyncHour = hour;
        console.warn(`[Scheduler] Running scheduled sync (${hour}:00)...`);
        runTier1Sync(db, `sync:${clock.day}:${hour}`).catch((err: unknown) => {
          console.error('[Scheduler] Tier 1 sync failed:', err instanceof Error ? err.message : String(err));
        });
      }
      if (!watchlistsRunning && !isSyncInProgress() && !isConnectionCheckInProgress() && !env.isDevelopment) {
        watchlistsRunning = true;
        void runDueWatchlists(db)
          .catch(() => { console.warn('[Scheduler] Watchlist monitoring unavailable.'); })
          .finally(() => { watchlistsRunning = false; });
      }

      // Archive completed tasks older than 14 days — production only (the dev
      // .env points at the production DB), once per day. Cheap single UPDATE,
      // so it doesn't need to wait for a sync to finish.
      const archiveDay = ukClock().day;
      if (!env.isDevelopment && lastArchiveDay !== archiveDay) {
        lastArchiveDay = archiveDay;
        void runClaimedJob(db, 'archive-tasks', archiveDay, () => archiveCompletedTasks(db)).catch((err: unknown) => {
          console.error('[Scheduler] Task archive failed:', err instanceof Error ? err.message : String(err));
        });
      }

      // Weekly memory review — production only, Mondays 08:00. Suggests
      // standing instructions from preferences the user kept repeating;
      // suggestions only, never applied until approved on the Memory page.
      const nowForReview = ukClock();
      const reviewWeek = nowForReview.week;
      if (!env.isDevelopment && nowForReview.weekday === 'Mon' && nowForReview.hour === MEMORY_REVIEW_HOUR && lastMemoryReviewWeek !== reviewWeek && !isSyncInProgress()) {
        lastMemoryReviewWeek = reviewWeek;
        void runClaimedJob(db, 'memory-review', reviewWeek, () => runWeeklyMemoryReview(db))
          .then((ran) => { console.warn(`[Scheduler] Weekly memory review claimed: ${ran.toString()}`); })
          .catch((err: unknown) => { console.error('[Scheduler] Weekly memory review failed:', err instanceof Error ? err.message : String(err)); });
      }

      // Connection-only pass: never starts source sync or search indexing.
      if (!env.isDevelopment && connectionCheckDue(Date.now(), lastConnectionCheckAt) && !isSyncInProgress() && !isConnectionCheckInProgress()) {
        lastConnectionCheckAt = Date.now();
        console.warn('[Scheduler] Checking new/updated connections (15-minute interval)...');
        void runClaimedJob(db, 'connections', String(Math.floor(Date.now() / CONNECTION_CHECK_INTERVAL_MS)), () => runInferredEdgeJob(db)).catch((err: unknown) => {
          console.error('[Scheduler] Inferred edge job failed:', err instanceof Error ? err.message : String(err));
        });
      }

      // Weekly Microsoft digest — production only, Mondays from 08:00 UK,
      // once per week (persisted), after any running sync has finished.
      if (!env.isDevelopment && !weeklyDigestRunning && !isSyncInProgress()) {
        void weeklyDigestDue(db).then((due) => {
          if (!started || !due || weeklyDigestRunning) return;
          weeklyDigestRunning = true;
          console.warn('[Scheduler] Generating weekly Microsoft digest...');
          return runClaimedJob(db, 'weekly-digest', ukClock().week, () => generateWeeklyMicrosoftDigest(db))
            .then((ran) => { console.warn(`[Scheduler] Weekly Microsoft digest claimed: ${ran.toString()}`); })
            .finally(() => { weeklyDigestRunning = false; });
        }).catch((err: unknown) => {
          console.error('[Scheduler] Weekly Microsoft digest failed:', err instanceof Error ? err.message : String(err));
        });
      }

      // Morning briefing — production only, from 09:00 UK time once the
      // morning sync has finished (so overnight GitHub activity is in).
      if (!env.isDevelopment && !briefingRunning && !isSyncInProgress() && workHour() < BRIEFING_LATEST_HOUR) {
        void briefingDue(db).then((due) => {
          if (!started || !due || briefingRunning) return;
          briefingRunning = true;
          console.warn('[Scheduler] Generating morning briefing...');
          return runClaimedJob(db, 'morning-briefing', ukClock().day, () => generateMorningBriefing(db))
            .then(() => { console.warn('[Scheduler] Morning briefing ready.'); })
            .finally(() => { briefingRunning = false; });
        }).catch((err: unknown) => {
          console.error('[Scheduler] Morning briefing failed:', err instanceof Error ? err.message : String(err));
        });
      }

      // Foundry IQ backfill — production only, sweeps content_items for rows
      // never pushed (or since edited) into the semantic search index, so
      // every source type (commits, PRs, issues, emails, calendar, GitLab
      // items, etc.) is eventually queryable via search_knowledge_base, not
      // just documents/notes which are indexed live on write. Runs hourly,
      // bounded per run, deferred while a sync is in progress for the same
      // pool-contention reason as the edge job.
      if (!env.isDevelopment && shouldRunFoundryBackfill() && !isSyncInProgress() && !isConnectionCheckInProgress()) {
        lastFoundryBackfillAt = Date.now();
        console.warn('[Scheduler] Running Foundry IQ backfill sweep...');
        void runClaimedJob(db, 'foundry-backfill', String(Math.floor(Date.now() / FOUNDRY_BACKFILL_INTERVAL_MS)), () => runFoundryIqBackfillJob(db)).catch((err: unknown) => {
          console.error('[Scheduler] Foundry IQ backfill job failed:', err instanceof Error ? err.message : String(err));
        });
      }
      // Tagging sweep — production only, hourly, bounded batch: tags items whose insert-time
      // tagging never ran and retries failed attempts. Deferred while a sync is running.
      if (!env.isDevelopment && Date.now() - lastTaggingSweepAt >= TAGGING_SWEEP_INTERVAL_MS && !isSyncInProgress()) {
        lastTaggingSweepAt = Date.now();
        void runClaimedJob(db, 'tagging-sweep', String(Math.floor(Date.now() / TAGGING_SWEEP_INTERVAL_MS)), () => runTaggingSweepJob(db)).catch((err: unknown) => {
          console.error('[Scheduler] Tagging sweep failed:', err instanceof Error ? err.message : String(err));
        });
      }
      // Nightly knowledge-turn review — production only, from 02:00 UTC, once per day (claimed). Model-free aggregation.
      const reviewNow = new Date();
      const reviewDay = reviewNow.toISOString().slice(0, ISO_DATE_LENGTH);
      if (!env.isDevelopment && reviewNow.getUTCHours() >= KNOWLEDGE_REVIEW_UTC_HOUR && lastKnowledgeReviewDay !== reviewDay) {
        lastKnowledgeReviewDay = reviewDay;
        void runClaimedJob(db, 'knowledge-nightly-review', reviewDay, () => runKnowledgeNightlyReviewJob(db, reviewNow)).catch((err: unknown) => {
          console.error('[Scheduler] Knowledge nightly review failed:', err instanceof Error ? err.message : String(err));
        });
      }
    }, SYNC_CHECK_INTERVAL),
  );

  if (env.isDevelopment) {
    console.warn('[Scheduler] Development mode — inferred edge job and Foundry IQ backfill DISABLED.');
  } else {
    console.warn('[Scheduler] Incremental connections checked every 15 minutes; independent Foundry IQ backfill sweep scheduled hourly.');
  }

  // Build pipeline runner — follows cloud-agent PRs for running build specs.
  // Cheap no-op (one indexed query) when nothing is running.
  timers.push(
    setInterval(() => {
      if (!started) return;
      void tickBuildRunner().catch((err: unknown) => {
        console.error('[Scheduler] Build runner tick failed:', err instanceof Error ? err.message : String(err));
      });
    }, BUILD_RUNNER_INTERVAL_MS),
  );
}

/** Clears all scheduled timers. Call on graceful shutdown. */
export function stopSyncScheduler(): void {
  started = false;
  if (initialTimer !== undefined) clearTimeout(initialTimer);
  initialTimer = undefined;
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  console.warn('[Scheduler] Sync scheduler stopped.');
}
