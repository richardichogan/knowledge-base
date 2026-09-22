/**
 * jobs/noteReindexJob.ts
 *
 * Rebuilds the content_items mirror for every active note.
 *
 * Notes were historically indexed with `body` set to the raw BlockNote
 * wrapper JSON. That made both the Postgres FTS tsvector and the Foundry IQ
 * embedding almost entirely structural boilerplate — identical across every
 * note — so notes routinely failed to surface for questions their prose
 * plainly answered. Notes written from now on are indexed as rendered plain
 * text, but every note already in the database still holds the old raw-JSON
 * body and will never be fixed by the Foundry IQ backfill sweep, which only
 * re-embeds what content_items already contains rather than re-deriving it
 * from the notes table.
 *
 * The job is idempotent and cheap to run on every boot: it only writes when
 * the freshly rendered payload actually differs from what is already stored.
 * A write bumps content_items.updated_at, which is what makes the hourly
 * Foundry IQ backfill pick the row up and re-embed it — so no embedding cost
 * is incurred for notes that are already correct.
 */
import type { Pool } from 'pg';
import { upsertContentItem } from '../db/queries.js';
import { buildNoteIndexPayload, type IndexableNote } from '../routes/notes.js';

interface NoteReindexRow {
  id: string;
  content: string;
  project_id: string | null;
  tags: string[];
  updated_at: string;
  indexed_body: string | null;
}

/** Runs the note re-index job. All errors are logged, never thrown. */
export async function runNoteReindexJob(db: Pool): Promise<void> {
  try {
    const { rows } = await db.query<NoteReindexRow>(
      `SELECT n.id, n.content, n.project_id, n.tags, n.updated_at, ci.body AS indexed_body
         FROM notes n
         LEFT JOIN content_items ci ON ci.source = 'note' AND ci.source_id = n.id::text
        WHERE n.status = 'active'`,
    );

    let rebuilt = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const note: IndexableNote = {
          id: row.id,
          content: row.content,
          projectId: row.project_id,
          tags: row.tags,
          updatedAt: new Date(row.updated_at).toISOString(),
        };
        const payload = await buildNoteIndexPayload(db, note);
        if (payload.body === row.indexed_body) continue;

        await upsertContentItem(db, payload);
        rebuilt++;
      } catch (err) {
        failed++;
        console.error(`[NoteReindex] Failed to rebuild note ${row.id}:`, err instanceof Error ? err.message : err);
      }
    }

    if (rebuilt === 0 && failed === 0) {
      console.warn(`[NoteReindex] All ${rows.length} notes already indexed as plain text — nothing to do.`);
    } else {
      console.warn(`[NoteReindex] Rebuilt ${rebuilt}/${rows.length} note bodies as plain text (${failed} failed).`);
    }
  } catch (err) {
    console.error('[NoteReindex] Job failed:', err instanceof Error ? err.message : String(err));
  }
}
