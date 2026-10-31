import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Note } from '../types/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/index.js';
import { scheduleGitHubPublish } from './noteGitHubService.js';
import { notePassageTags } from '../utils/notePassageTags.js';

export const NOTE_HISTORY_INTERVAL_MS = 1_800_000;
export const NOTE_HISTORY_LIMIT = 30;
type Reason = 'automatic' | 'before_athena' | 'before_restore' | 'before_github';
export interface Writing { title: string; contentType: string; contentJson: string }
interface NoteRow {
  id: string; content: string; created_at: Date; updated_at: Date;
  tags: string[]; linked_items: string[]; status: Note['status']; project_id: string | null;
  revision: number; last_history_at: Date | null;
}
export interface VersionRow {
  id: string; note_id: string; writing: Writing; fingerprint: string;
  revision: number; writing_updated_at: Date; created_at: Date; reason: Reason; restored_from: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseWriting(content: string): Writing {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch {
    if (/^\s*[[{]/.test(content)) throw new ValidationError('Note content is malformed; no changes were made', {});
    return { title: 'Untitled', contentType: 'note', contentJson: JSON.stringify([{ type: 'paragraph', content: content }]) };
  }
  if (Array.isArray(parsed)) return { title: 'Untitled', contentType: 'note', contentJson: JSON.stringify(parsed) };
  if (!object(parsed) || typeof parsed.contentJson !== 'string') {
    throw new ValidationError('Note body must contain BlockNote content', {});
  }
  let blocks: unknown;
  try { blocks = JSON.parse(parsed.contentJson); } catch { throw new ValidationError('Note body is malformed; no changes were made', {}); }
  if (!Array.isArray(blocks)) throw new ValidationError('Note body must be a block array', {});
  return {
    title: typeof parsed.title === 'string' ? parsed.title : 'Untitled',
    contentType: typeof parsed.contentType === 'string' ? parsed.contentType : 'note',
    contentJson: parsed.contentJson,
  };
}

function canonical(value: unknown, block = false): unknown {
  if (Array.isArray(value)) return value.map(item => canonical(item, block));
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !(block && key === 'id')).map(key => [
    key, canonical(value[key], key === 'children'),
  ]));
}
export function writingFingerprint(writing: Writing): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    title: writing.title, contentType: writing.contentType,
    blocks: canonical(JSON.parse(writing.contentJson) as unknown, true),
  }))).digest('hex');
}
export function automaticCheckpointDue(last: Date | null, now: Date): boolean {
  return last === null || now.getTime() - last.getTime() >= NOTE_HISTORY_INTERVAL_MS;
}
function note(row: NoteRow): Note {
  return { id: row.id, content: row.content, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    tags: row.tags, linkedItems: row.linked_items, status: row.status, revision: row.revision,
    ...(row.project_id !== null && { projectId: row.project_id }) };
}
function requireRevision(expected: number | undefined, row: NoteRow): void {
  if (!Number.isInteger(expected) || expected !== row.revision) throw new ConflictError('This note changed elsewhere. Keep your draft and reload the saved note before continuing.', 'NOTE_REVISION_CONFLICT', { revision: String(row.revision) });
}
async function checkpoint(client: PoolClient, row: NoteRow, writing: Writing, reason: Reason, restoredFrom?: string): Promise<void> {
  const fingerprint = writingFingerprint(writing);
  const latest = await client.query<{ fingerprint: string }>(
    'SELECT fingerprint FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [row.id]);
  if (latest.rows[0]?.fingerprint === fingerprint) return;
  await client.query(
    `INSERT INTO note_versions (note_id, writing, fingerprint, revision, writing_updated_at, reason, restored_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.id, JSON.stringify(writing), fingerprint, row.revision, row.updated_at, reason, restoredFrom ?? null]);
  await client.query(
    `DELETE FROM note_versions WHERE note_id = $1 AND id NOT IN
     (SELECT id FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`, [row.id, NOTE_HISTORY_LIMIT]);
}

export interface NoteWrite {
  content?: string; tags?: string[]; projectId?: string | null; expectedRevision?: number | undefined;
  protect?: boolean; restoreId?: string; appendBlocks?: unknown[]; importGitHub?: boolean;
  restoreWriting?: Writing;
  protectBefore?: boolean;
  passageTagsSupported?: boolean;
}
/** All note writing and checkpoint decisions share the locked note transaction. */
export async function writeNote(db: Pool, id: string, input: NoteWrite): Promise<Note> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await writeNoteInTransaction(client, id, input);
    await client.query('COMMIT');
    if (result.publish) scheduleGitHubPublish(db, id);
    return result.note;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

/** Caller owns commit/rollback and must schedule publication only after commit. */
export async function writeNoteInTransaction(client: PoolClient, id: string, input: NoteWrite): Promise<{ note: Note; publish: boolean }> {
    const current = await client.query<NoteRow>("SELECT * FROM notes WHERE id = $1 AND status = 'active' FOR UPDATE", [id]);
    const row = current.rows[0];
    if (!row) throw new NotFoundError('Note not found or archived');
    // Internal append operations compute their changes after acquiring the lock.
    if (input.appendBlocks === undefined) requireRevision(input.expectedRevision, row);
    const before = parseWriting(input.restoreId !== undefined ? input.content ?? row.content : row.content);
    let content = input.content ?? row.content;
    let reason: Reason = 'automatic';
    if (input.restoreWriting !== undefined) {
      let wrapper: unknown;
      try { wrapper = JSON.parse(row.content); } catch { wrapper = {}; }
      content = JSON.stringify({ ...(object(wrapper) ? wrapper : {}), ...input.restoreWriting });
      reason = 'before_restore';
    } else if (input.restoreId !== undefined) {
      const version = await client.query<VersionRow>('SELECT * FROM note_versions WHERE id = $1 AND note_id = $2', [input.restoreId, id]);
      if (!version.rows[0]) throw new NotFoundError('Checkpoint not found for this note');
      const saved = version.rows[0].writing;
      // Preserve wrapper metadata such as githubPath, not historical organisation.
      let wrapper: unknown;
      try { wrapper = JSON.parse(input.content ?? row.content); } catch { wrapper = {}; }
      content = JSON.stringify({ ...(object(wrapper) ? wrapper : {}), ...saved });
      reason = 'before_restore';
    } else if (input.appendBlocks !== undefined) {
      let wrapper: unknown;
      try { wrapper = JSON.parse(row.content); } catch { wrapper = {}; }
      content = JSON.stringify({ ...(object(wrapper) ? wrapper : {}), ...before,
        contentJson: JSON.stringify([...(JSON.parse(before.contentJson) as unknown[]), ...input.appendBlocks]) });
    }
    const previousWrapper: unknown = row.content.trim().startsWith('{') ? JSON.parse(row.content) as unknown : null;
    if (object(previousWrapper) && previousWrapper['automaticNamedLinks'] === true) {
      const nextWrapper: unknown = content.trim().startsWith('{') ? JSON.parse(content) as unknown : null;
      if (object(nextWrapper)) content = JSON.stringify({ ...nextWrapper, automaticNamedLinks: true });
    }
    const after = parseWriting(content);
    if (!input.passageTagsSupported) {
      const currentTags = notePassageTags(row.content);
      const nextTags = new Set(notePassageTags(content).map(tag => `${tag.kind}:${tag.id}`));
      if (currentTags.some(tag => !nextTags.has(`${tag.kind}:${tag.id}`))) {
        throw new ConflictError('This change would remove tagged passages. Open the note in the updated editor before making this change.', 'NOTE_PASSAGE_TAG_CONFLICT');
      }
    }
    const changed = writingFingerprint(before) !== writingFingerprint(after);
    if (changed && before.contentType === 'email-draft') {
      const email = await client.query<{ status: string }>('SELECT status FROM email_drafts WHERE note_id=$1', [id]);
      if (email.rows[0]?.status === 'sent') throw new ConflictError('This email is recorded as Sent. Create a new draft for a follow-up; the sent writing is unchanged.', 'WORK_EMAIL_SENT');
    }
    const time = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const due = changed && automaticCheckpointDue(row.last_history_at, time.rows[0]!.now);
    if (reason === 'before_restore' && changed) {
      const liveDraft = input.content !== undefined && writingFingerprint(before) !== writingFingerprint(parseWriting(row.content));
      await checkpoint(client, liveDraft ? { ...row, updated_at: time.rows[0]!.now } : row, before, reason, input.restoreId);
    } else if (input.importGitHub && changed) {
      await checkpoint(client, row, before, 'before_github');
    } else if (input.protectBefore && changed) {
      await checkpoint(client, row, before, 'before_athena');
    } else if (input.protect) {
      // The supplied content is the live pre-Athena draft, not a proposed replacement.
      await checkpoint(client, { ...row, revision: row.revision + (changed ? 1 : 0), updated_at: time.rows[0]!.now }, after, 'before_athena');
    } else if (due) {
      await checkpoint(client, row, before, 'automatic');
    }
    const result = await client.query<NoteRow>(
      `UPDATE notes SET content = $2, tags = COALESCE($3, tags),
       project_id = CASE WHEN $4 THEN $5 ELSE project_id END,
       revision = revision + CASE WHEN content IS DISTINCT FROM $2 OR ($3::text[] IS NOT NULL AND tags IS DISTINCT FROM $3)
         OR ($4 AND project_id IS DISTINCT FROM $5) THEN 1 ELSE 0 END,
       updated_at = CASE WHEN content IS DISTINCT FROM $2 OR ($3::text[] IS NOT NULL AND tags IS DISTINCT FROM $3)
         OR ($4 AND project_id IS DISTINCT FROM $5) THEN clock_timestamp() ELSE updated_at END,
       last_history_at = CASE WHEN $6 THEN clock_timestamp() ELSE last_history_at END
       WHERE id = $1 RETURNING *`,
      [id, content, input.tags ?? null, 'projectId' in input, input.projectId ?? null,
        due && reason !== 'before_restore' && !input.protect && !input.importGitHub]);
    let publish = false;
    if (changed) {
      const queued = await client.query(
        `UPDATE note_github_publications SET status = 'pending', error = NULL, updated_at = NOW()
         WHERE note_id = $1 AND status <> 'conflict'`, [id]);
      publish = (queued.rowCount ?? 0) > 0;
    }
    return { note: note(result.rows[0]!), publish };
}

export async function restoreArchivedNote(db: Pool, id: string, expectedRevision: number): Promise<{ note: Note; restored: boolean }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<NoteRow>('SELECT * FROM notes WHERE id = $1 FOR UPDATE', [id]);
    const row = current.rows[0];
    if (!row) throw new NotFoundError('Note not found');
    if (row.status === 'active') {
      await client.query('COMMIT');
      return { note: note(row), restored: false };
    }
    if (row.status !== 'archived') throw new ValidationError('Only archived notes can be restored');
    requireRevision(expectedRevision, row);
    const updated = await client.query<NoteRow>(
      "UPDATE notes SET status='active',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [id],
    );
    await client.query('COMMIT');
    return { note: note(updated.rows[0]!), restored: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function listNoteVersions(db: Pool, id: string): Promise<Omit<VersionRow, 'writing' | 'fingerprint' | 'note_id'>[]> {
  const existing = await db.query("SELECT id FROM notes WHERE id = $1 AND status = 'active'", [id]);
  if (!existing.rows[0]) throw new NotFoundError('Note not found or archived');
  const rows = await db.query<Omit<VersionRow, 'writing' | 'fingerprint' | 'note_id'>>(
    `SELECT id, revision, writing_updated_at, created_at, reason, restored_from FROM note_versions
     WHERE note_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [id, NOTE_HISTORY_LIMIT]);
  return rows.rows;
}
export async function getNoteVersion(db: Pool, id: string, versionId: string): Promise<VersionRow> {
  const result = await db.query<VersionRow>(
    `SELECT v.* FROM note_versions v JOIN notes n ON n.id = v.note_id
     WHERE v.note_id = $1 AND v.id = $2 AND n.status = 'active'`, [id, versionId]);
  if (!result.rows[0]) throw new NotFoundError('Checkpoint not found for this note');
  return result.rows[0];
}
