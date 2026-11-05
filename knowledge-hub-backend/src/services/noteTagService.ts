import type { Pool } from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import type { TaxonomyTag } from '../routes/taxonomy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_TAGS = 200;
const FOLDER_PAGE_SIZE = 100;

export function noteTagIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_NOTE_TAGS
    || value.some(id => typeof id !== 'string' || !UUID.test(id))) {
    throw new ValidationError(`${field} must be an array of at most ${MAX_NOTE_TAGS} valid tag IDs.`);
  }
  return [...new Set((value as string[]).map(id => id.toLowerCase()))].sort();
}

function validateNoteId(id: string): void {
  if (!UUID.test(id)) throw new ValidationError('A valid note ID is required.');
}

export async function readNoteTags(db: Pool, noteId: string): Promise<Array<TaxonomyTag & { path: string }>> {
  validateNoteId(noteId);
  const note = await db.query('SELECT id FROM notes WHERE id=$1', [noteId]);
  if (!note.rows.length) throw new NotFoundError('Note not found.');
  const { rows } = await db.query<{
    id: string; name: string; slug: string; parent_id: string | null; parent_name: string | null;
    colour: string | null; role: 'filing' | 'concept'; project_id: string | null; source: string;
  }>(`SELECT t.id,t.name,t.slug,t.parent_id,parent.name AS parent_name,t.colour,t.role,t.project_id,nt.source
    FROM note_tags nt JOIN tags t ON t.id=nt.tag_id LEFT JOIN tags parent ON parent.id=t.parent_id
    WHERE nt.note_id=$1 ORDER BY t.name,t.id`, [noteId]);
  return rows.map(row => ({
    id: row.id, name: row.name, slug: row.slug, parentId: row.parent_id, colour: row.colour,
    role: row.role, projectId: row.project_id, usageCount: 0, source: row.source,
    path: row.parent_name ? `${row.parent_name} / ${row.name}` : row.name,
  }));
}

export async function readNoteFiling(db: Pool, noteId: string, offset: unknown = 0): Promise<{
  noteId: string; tags: Awaited<ReturnType<typeof readNoteTags>>; expectedTagIds: string[];
  folders: Array<{ id: string; name: string; parentId: string | null; path: string }>;
  hasMore: boolean; nextOffset: number | null;
}> {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new ValidationError('offset must be a nonnegative integer.');
  }
  const tags = await readNoteTags(db, noteId);
  const { rows } = await db.query<{ id: string; name: string; parentId: string | null; path: string }>(
    `SELECT t.id,t.name,t.parent_id AS "parentId",
      CASE WHEN parent.id IS NULL THEN t.name ELSE parent.name || ' / ' || t.name END AS path
      FROM tags t LEFT JOIN tags parent ON parent.id=t.parent_id
      ORDER BY lower(COALESCE(parent.name,t.name)),t.parent_id NULLS FIRST,lower(t.name),t.id
      LIMIT $1 OFFSET $2`, [FOLDER_PAGE_SIZE + 1, offset]);
  const hasMore = rows.length > FOLDER_PAGE_SIZE;
  return { noteId, tags, expectedTagIds: tags.map(tag => tag.id).sort(), folders: rows.slice(0, FOLDER_PAGE_SIZE),
    hasMore, nextOffset: hasMore ? offset + FOLDER_PAGE_SIZE : null };
}

export async function setNoteTags(db: Pool, noteId: string, requested: unknown, expected: unknown): Promise<{ noteId: string; tagIds: string[] }> {
  validateNoteId(noteId);
  const tagIds = noteTagIds(requested, 'tagIds');
  const expectedTagIds = noteTagIds(expected, 'expectedTagIds');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const note = await client.query("SELECT id FROM notes WHERE id=$1 AND status='active' FOR UPDATE", [noteId]);
    if (!note.rows.length) throw new NotFoundError('Note not found or archived.');
    const current = await client.query<{ tag_id: string; source: string }>(
      'SELECT tag_id::text,source FROM note_tags WHERE note_id=$1 ORDER BY tag_id', [noteId]);
    if (JSON.stringify(current.rows.map(row => row.tag_id)) !== JSON.stringify(expectedTagIds)) {
      throw new ConflictError('Tags changed elsewhere. Reload the current tags before editing them.', 'NOTE_TAGS_CONFLICT');
    }
    if (JSON.stringify(tagIds) === JSON.stringify(expectedTagIds)) {
      await client.query('COMMIT');
      return { noteId, tagIds };
    }
    const existing = await client.query('SELECT id FROM tags WHERE id=ANY($1::uuid[])', [tagIds]);
    if (existing.rows.length !== tagIds.length) throw new ValidationError('One or more tags no longer exist. Reload the tag folders.');
    const removed = current.rows.filter(row => !tagIds.includes(row.tag_id));
    for (const row of removed.filter(row => row.source === 'auto')) {
      await client.query(`INSERT INTO tag_rejections(content_kind,content_id,tag_id) VALUES('note',$1,$2) ON CONFLICT DO NOTHING`, [noteId, row.tag_id]);
    }
    // Delete only the observed removals; never erase a new background auto-tag.
    await client.query('DELETE FROM note_tags WHERE note_id=$1 AND tag_id=ANY($2::uuid[])', [noteId, removed.map(row => row.tag_id)]);
    if (tagIds.length) await client.query(`INSERT INTO note_tags(note_id,tag_id,source)
      SELECT $1,id,'user' FROM unnest($2::uuid[]) AS tag(id)
      ON CONFLICT(note_id,tag_id) DO UPDATE SET source='user'`, [noteId, tagIds]);
    const saved = await client.query<{ tag_id: string }>('SELECT tag_id::text FROM note_tags WHERE note_id=$1 ORDER BY tag_id', [noteId]);
    await client.query('COMMIT');
    return { noteId, tagIds: saved.rows.map(row => row.tag_id) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('[Note tags] Rollback failed:', rollbackError); }
    throw error;
  } finally { client.release(); }
}
