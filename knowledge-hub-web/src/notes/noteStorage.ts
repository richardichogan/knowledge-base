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

// ── Serialisation ─────────────────────────────────────────────────────────────

interface StoredPayload {
  title: string;
  contentType: ContentType;
  contentJson: string;
  githubPath?: string;
}

function serialise(doc: Pick<NoteDocument, 'title' | 'contentType' | 'contentJson' | 'githubPath'>): string {
  const payload: StoredPayload = {
    title: doc.title,
    contentType: doc.contentType,
    contentJson: doc.contentJson,
    ...(doc.githubPath !== undefined && { githubPath: doc.githubPath }),
  };
  return JSON.stringify(payload);
}

function deserialise(raw: string, id: string, createdAt: string, updatedAt: string): NoteDocument {
  try {
    const payload = JSON.parse(raw) as Partial<StoredPayload>;
    return {
      id,
      title: payload.title ?? UNTITLED_DOCUMENT,
      contentType: payload.contentType ?? 'note',
      contentJson: payload.contentJson ?? '[]',
      createdAt,
      updatedAt,
      ...(payload.githubPath !== undefined && { githubPath: payload.githubPath }),
    };
  } catch {
    return {
      id,
      title: UNTITLED_DOCUMENT,
      contentType: 'note',
      contentJson: '[]',
      createdAt,
      updatedAt,
    };
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function fetchNotes(): Promise<NoteListItem[]> {
  const result = await api.getNotes(1, 100);
  if (!result.success) return [];
  return result.data.items.map((n) => {
    const doc = deserialise(n.content, n.id, n.createdAt, n.updatedAt);
    return {
      id: n.id,
      title: doc.title,
      contentType: doc.contentType,
      updatedAt: n.updatedAt,
      tagIds: n.taxonomyTagIds ?? [],
      ...(n.projectId !== undefined && n.projectId !== null && { projectId: n.projectId }),
    };
  });
}

export async function fetchNote(id: string): Promise<NoteDocument | null> {
  const result = await api.getNotes(1, 100);
  if (!result.success) return null;
  const note = result.data.items.find((n) => n.id === id);
  if (note === undefined) return null;
  return deserialise(note.content, note.id, note.createdAt, note.updatedAt);
}

export async function createNote(
  doc: Pick<NoteDocument, 'title' | 'contentType' | 'contentJson'>,
): Promise<NoteDocument | null> {
  const result = await api.createNote({ content: serialise(doc), tags: [] });
  if (!result.success) return null;
  return deserialise(result.data.content, result.data.id, result.data.createdAt, result.data.updatedAt);
}

export async function saveNote(doc: NoteDocument): Promise<boolean> {
  const result = await api.patchNote(doc.id, serialise(doc), [], undefined);
  return result.success;
}

export async function deleteNote(id: string): Promise<void> {
  await api.deleteNote(id);
}
