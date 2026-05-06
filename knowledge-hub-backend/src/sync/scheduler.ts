import { SYNC_CADENCE_MINUTES, DEFAULT_SYNC_CADENCE_MINUTES, MS_PER_MINUTE, INITIAL_SYNC_DELAY_MS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { runTier1Sync } from './syncOrchestrator.js';
import { tagContent, loadConceptTags } from '../services/taxonomyService.js';

/**
 * After each sync, tag any discovered articles that have no tags yet.
 * Runs up to MAX_AUTO_TAG items per cycle to avoid long-running jobs.
 */
const MAX_AUTO_TAG = 20;
const AUTO_TAG_SUMMARY_CHARS = 2000;

async function autoTagNewDiscoverItems(): Promise<void> {
  const db = getDb();
  try {
    // Check we have concept tags — no point calling the AI if taxonomy is empty
    const tags = await loadConceptTags(db);
    if (tags.length === 0) return;

    const result = await db.query<{ id: string; title: string; body: string }>(
      `SELECT ci.id, ci.title, ci.body
       FROM content_items ci
       WHERE ci.source = 'discovered-article'
         AND NOT EXISTS (
           SELECT 1 FROM discover_item_tags dit WHERE dit.discover_item_id = ci.id
         )
       ORDER BY ci.indexed_at DESC
       LIMIT $1`,
      [MAX_AUTO_TAG],
    );

    if (result.rows.length === 0) return;
    console.warn(`[Scheduler] Auto-tagging ${result.rows.length} untagged discover item(s)…`);

    for (const row of result.rows) {
      const summary = `${row.title}\n\n${row.body ?? ''}`.slice(0, AUTO_TAG_SUMMARY_CHARS);
      await tagContent(db, summary, row.id, 'discover_item', row.title);
    }
  } catch (err) {
    console.error('[Scheduler] Auto-tag pass failed:', err instanceof Error ? err.message : err);
  }
}

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
    runTier1Sync(db)
      .then(() => autoTagNewDiscoverItems())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Scheduler] Initial sync failed:', message);
      });
  }, INITIAL_SYNC_DELAY_MS);

  // Then repeat on the cadence
  timers.push(
    setInterval(() => {
      runTier1Sync(db)
        .then(() => autoTagNewDiscoverItems())
        .catch((err: unknown) => {
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
