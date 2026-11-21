import type { Pool, PoolClient } from 'pg';
import { ConflictError, ValidationError } from '../types/errors.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export async function lockNotePresence(client: PoolClient, noteId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`note-editor:${noteId}`]);
}

export async function setNoteEditorPresence(db: Pool, noteId: string, editorId: string, registrationId: string, ownerId: string, open: boolean): Promise<void> {
  if (!UUID.test(noteId) || !UUID.test(editorId) || !UUID.test(registrationId) || !ownerId) throw new ValidationError('A valid note and editor identity are required.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockNotePresence(client, noteId);
    if (open) {
      const saved = await client.query(`INSERT INTO note_editor_presence (note_id, editor_id, owner_id, registration_id)
        SELECT id, $2, $3, $4 FROM notes WHERE id=$1 AND status='active'
        ON CONFLICT (note_id, editor_id) DO UPDATE SET registration_id=EXCLUDED.registration_id, opened_at=NOW()
        WHERE note_editor_presence.owner_id=EXCLUDED.owner_id RETURNING note_id`,
      [noteId, editorId, ownerId, registrationId]);
      if (!saved.rowCount) throw new ConflictError('The note editor session could not be registered.', 'NOTE_EDITOR_PRESENCE');
    } else {
      await client.query('DELETE FROM note_editor_presence WHERE note_id=$1 AND editor_id=$2 AND owner_id=$3 AND registration_id=$4',
        [noteId, editorId, ownerId, registrationId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function hasOpenNoteEditors(client: PoolClient, noteId: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM note_editor_presence WHERE note_id=$1 LIMIT 1', [noteId]);
  return (result.rowCount ?? 0) > 0;
}
