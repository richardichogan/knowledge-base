/**
 * notes/noteStorage.ts — CRUD against the existing /api/notes backend.
 *
 * The backend Note model stores content as a plain string.
 * We serialise NoteDocument.contentJson and NoteDocument.title into
 * the `content` field as JSON so no schema changes are needed.
 */

import { api } from '../services/api';
import type { NoteDocument, NoteListItem } from './types';
import type { ContentType } from './constants';
import { UNTITLED_DOCUMENT } from './constants';
import { requireApiData } from '../services/apiError';
import { noteListQuery } from './noteListState';
import type { NoteListQuery, NoteListPage } from './noteListState';

export type { NoteListPage } from './noteListState';

// ── Serialisation ─────────────────────────────────────────────────────────────

interface StoredPayload {
  title: string;
  contentType: ContentType;
  contentJson: string;
  githubPath?: string;
}

export function serialise(doc: Pick<NoteDocument, 'title' | 'contentType' | 'contentJson' | 'githubPath'>): string {
  const payload: StoredPayload = {
    title: doc.title,
    contentType: doc.contentType,
    contentJson: doc.contentJson,
    ...(doc.githubPath !== undefined && { githubPath: doc.githubPath }),
  };
  return JSON.stringify(payload);
}

function deserialise(raw: string, id: string, createdAt: string, updatedAt: string, projectId?: string): NoteDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    if (/^\s*[[{]/.test(raw)) throw new Error('This note contains malformed JSON. Its saved content has not been changed.');
    return {
      id, title: UNTITLED_DOCUMENT, contentType: 'note', createdAt, updatedAt,
      contentJson: JSON.stringify([{ type: 'paragraph', content: raw }]),
      ...(projectId !== undefined && { projectId }),
    };
  }
  if (Array.isArray(parsed)) {
    return { id, title: UNTITLED_DOCUMENT, contentType: 'note', contentJson: raw, createdAt, updatedAt,
      ...(projectId !== undefined && { projectId }) };
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Partial<StoredPayload>).contentJson !== 'string') {
    throw new Error('This note has an unsupported writing format. Its saved content has not been changed.');
  }
  const payload = parsed as StoredPayload;
  const blocks: unknown = JSON.parse(payload.contentJson);
  if (!Array.isArray(blocks)) throw new Error('This note body is not a block array. Its saved content has not been changed.');
  return {
    id, title: payload.title ?? UNTITLED_DOCUMENT, contentType: payload.contentType ?? 'note',
    contentJson: payload.contentJson, createdAt, updatedAt,
    ...(payload.githubPath !== undefined && { githubPath: payload.githubPath }),
    ...(projectId !== undefined && { projectId }),
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

import { extractNoteBlockText, type NoteContentBlock } from './noteText';
export { extractNoteBlockText, type NoteContentBlock } from './noteText';

/**
 * Builds the note-list preview snippet. Skips any leading lines that just
 * repeat the note title — BlockNote documents very often open with an H1
 * echoing the title, which otherwise makes every card show its own title
 * twice.
 */
export function buildPreview(contentJson: string, title: string): string {
  try {
    const blocks = JSON.parse(contentJson) as unknown;
    if (!Array.isArray(blocks)) return '';
    const normalisedTitle = title.trim().toLowerCase();
    const lines = extractNoteBlockText(blocks as NoteContentBlock[]).split('\n');
    let start = 0;
    while (start < lines.length && (lines[start] ?? '').trim().toLowerCase() === normalisedTitle) start += 1;
    return lines.slice(start).join('\n').slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Note list for the sidebar. Uses the summary view — titles and previews
 * computed server-side — instead of downloading every note's full body
 * (several MB once notes contain images), which made Think slow to open and
 * prone to timing out.
 */
export async function fetchNotes(): Promise<NoteListItem[]> {
  const notes: NoteListItem[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await fetchNotesPage(page);
    notes.push(...result.items);
    if (!result.hasMore) return notes;
  }
  throw new Error('Note list is too large. Use search to narrow the list.');
}

export async function fetchNotesPage(page = 1, query: NoteListQuery = {}, structure: 'flat' | 'designs' = 'flat',
  typeFilter: { contentType?: ContentType; excludeContentType?: ContentType } = {}): Promise<NoteListPage> {
  const result = requireApiData(await api.getNoteSummaries(page, 100, { ...noteListQuery(query), structure, ...typeFilter }));
  const items = result.items.map((n) => ({
    id: n.id,
    title: n.title || UNTITLED_DOCUMENT,
    contentType: n.contentType as ContentType,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    ...(n.preview !== '' && { body: n.preview }),
    tagIds: n.taxonomyTagIds,
    ...(n.projectId !== undefined && { projectId: n.projectId }),
  }));
  return { items, total: result.total, page: result.page, hasMore: result.hasMore };
}

/** Loads one note's full body (previously fetched the whole list to find it). */
export async function fetchNote(id: string): Promise<NoteDocument | null> {
  const result = await api.getNote(id);
  const note = requireApiData(result);
  return fromApiNote(note);
}

export async function createNote(
  doc: Pick<NoteDocument, 'title' | 'contentType' | 'contentJson'>,
  projectId?: string,
): Promise<NoteDocument | null> {
  const result = await api.createNote({ content: serialise(doc), tags: [], ...(projectId !== undefined && { projectId }) });
  return fromApiNote(requireApiData(result));
}

export function fromApiNote(note: import('../types/contentItem').Note): NoteDocument {
  return { ...deserialise(note.content, note.id, note.createdAt, note.updatedAt, note.projectId), revision: note.revision ?? 0 };
}

export async function saveNote(doc: NoteDocument): Promise<NoteDocument> {
  // No tags argument: taxonomy tags live in note_tags, and sending [] here
  // wiped the note's stored tags on every autosave.
  const result = await api.patchNote(doc.id, serialise(doc), undefined, doc.projectId ?? null, doc.revision ?? 0);
  if (!result.success) throw new Error(result.error.message);
  return fromApiNote(result.data);
}

export async function deleteNote(id: string): Promise<void> {
  requireApiData(await api.deleteNote(id));
}
