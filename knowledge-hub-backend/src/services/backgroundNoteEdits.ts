/**
 * services/backgroundNoteEdits.ts — saves a background chat task's note edits
 * on the server, whether or not the note is open. Runs the same applier as the
 * live editor against the saved note, keeps the previous writing as a
 * restorable "Before Athena task" version recording what each edit did, and
 * returns the receipt Athena's next turn sees.
 */
import type { Pool } from 'pg';
import type { Note } from '../types/index.js';
import type { NoteEditProposal } from '../ai/noteEdits.js';
import type { NoteEditReceipt } from '../ai/chatSessionStore.js';
import { applyNoteEdits, type NoteEditOutcome } from '../utils/noteEditApplier.js';
import { JsonNoteEditor } from '../utils/jsonNoteEditor.js';
import { parseWriting, writeNoteInTransaction, type AthenaTaskAudit } from './noteVersionService.js';
import { scheduleGitHubPublish } from './noteGitHubService.js';
import { recordAiAuthoredNote } from '../ai/aiLedger.js';

export interface BackgroundNoteEditResult {
  receipt: NoteEditReceipt;
  outcomes: NoteEditOutcome[];
  note: Note | null;
}

export async function applyBackgroundNoteEdits(
  db: Pool, noteId: string, edits: NoteEditProposal[], task: Omit<AthenaTaskAudit, 'edits' | 'at'>,
): Promise<BackgroundNoteEditResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ content: string; revision: number }>(
      "SELECT content, revision FROM notes WHERE id = $1 AND status = 'active' FOR UPDATE", [noteId]);
    const row = current.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return blocked(edits, 'That note has been archived or deleted, so I left it alone.');
    }
    const writing = parseWriting(row.content);
    const editor = new JsonNoteEditor(JSON.parse(writing.contentJson) as unknown[]);
    const result = applyNoteEdits(editor, edits, { script: writing.contentType === 'script' });
    if (result.applied === 0) {
      await client.query('ROLLBACK');
      return { receipt: { state: 'blocked', applied: 0, failed: result.failed, background: true }, outcomes: result.outcomes, note: null };
    }
    let wrapper: unknown;
    try { wrapper = JSON.parse(row.content); } catch { wrapper = {}; }
    const base = typeof wrapper === 'object' && wrapper !== null && !Array.isArray(wrapper) ? wrapper : {};
    const content = JSON.stringify({ ...base, ...writing, contentJson: JSON.stringify(editor.document) });
    const written = await writeNoteInTransaction(client, noteId, {
      content, expectedRevision: row.revision, passageTagsSupported: true,
      athenaTask: { ...task, at: new Date().toISOString(), edits: result.outcomes },
    });
    const version = await client.query<{ id: string }>(
      `SELECT id FROM note_versions WHERE note_id = $1 AND reason = 'before_athena_task'
       ORDER BY created_at DESC, id DESC LIMIT 1`, [noteId]);
    await client.query('COMMIT');
    if (written.publish) scheduleGitHubPublish(db, noteId);
    recordAiAuthoredNote(db, noteId, written.note.content);
    return {
      receipt: {
        state: result.failed.length > 0 ? 'partial' : 'saved', applied: result.applied, failed: result.failed, background: true,
        ...(version.rows[0] !== undefined && { versionId: version.rows[0].id }),
      },
      outcomes: result.outcomes,
      note: written.note,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    return blocked(edits, reason);
  } finally {
    client.release();
  }
}

function blocked(edits: NoteEditProposal[], reason: string): BackgroundNoteEditResult {
  return {
    receipt: { state: 'blocked', applied: 0, failed: [], error: reason, background: true },
    outcomes: edits.map(edit => ({ summary: edit.summary, outcome: 'skipped', reason })),
    note: null,
  };
}
