/**
 * build/specFromNote.ts — creates an Athena Build spec from a Think note. Shared by
 * POST /api/build/specs/from-note and the use case handoff.
 */
import type { Pool } from 'pg';
import { NotFoundError } from '../types/errors.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import * as store from './buildStore.js';

const MAX_SPEC_CHARS = 60_000;
const MAX_TITLE_CHARS = 200;

export async function createSpecFromNote(db: Pool, noteId: string, opts: {
  repo: string; baseBranch?: string | undefined; useWorkBranch?: boolean | undefined; title?: string | undefined;
}): Promise<store.BuildSpec> {
  const { rows } = await db.query<{ content: string; project_id: string | null }>(
    `SELECT content, project_id FROM notes WHERE id::text = $1 AND status = 'active'`, [noteId]);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Note');
  const text = (await renderNoteAsText(db, row.content)).trim();
  const firstLine = text.split('\n').find((l) => l.trim() !== '')?.replace(/^#+\s*/, '').trim() ?? 'Untitled spec';
  const spec = await store.createSpec({
    title: (opts.title ?? firstLine).slice(0, MAX_TITLE_CHARS), specMarkdown: text.slice(0, MAX_SPEC_CHARS),
    repo: opts.repo, baseBranch: opts.baseBranch, useWorkBranch: opts.useWorkBranch,
    projectId: row.project_id, noteId,
  }, db);
  await store.addEvent(spec.id, null, 'created', 'Spec created from a Think note', {}, db);
  return spec;
}
