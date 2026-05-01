/**
 * taskArchiveService.ts
 *
 * Archives completed tasks (both one-off and recurring) that have been
 * in the completed state for more than ARCHIVE_AFTER_DAYS days.
 *
 * Called nightly by the scheduler.
 */

import type { Pool } from 'pg';

const ARCHIVE_AFTER_DAYS = 14;

export async function archiveCompletedTasks(db: Pool): Promise<number> {
  const result = await db.query<{ id: string }>(
    `UPDATE tasks
     SET archived = true, updated_at = NOW()
     WHERE status = 'completed'
       AND archived = false
       AND updated_at < NOW() - INTERVAL '${ARCHIVE_AFTER_DAYS} days'
     RETURNING id`,
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    console.warn(`[taskArchive] Archived ${count} completed task(s) older than ${ARCHIVE_AFTER_DAYS} days`);
  }
  return count;
}
