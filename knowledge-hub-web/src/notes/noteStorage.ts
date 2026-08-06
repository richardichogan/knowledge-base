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

interface PreviewBlock { type?: string; content?: { text?: string }[]; children?: PreviewBlock[] }

/** Recursively joins block text content into a flat preview snippet, skipping non-text blocks (e.g. images). */
function extractPreviewText(blocks: PreviewBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (Array.isArray(block.content)) {
      const text = block.content.map((c) => c.text ?? '').join('');
      if (text.trim() !== '') parts.push(text.trim());
    }
    if (Array.isArray(block.children)) {
      const childText = extractPreviewText(block.children);
      if (childText !== '') parts.push(childText);
    }
  }
  return parts.join(' ');
}

function buildPreview(contentJson: string): string {
  try {
    const blocks = JSON.parse(contentJson) as unknown;
    if (!Array.isArray(blocks)) return '';
    return extractPreviewText(blocks as PreviewBlock[]).slice(0, 200);
  } catch {
    return '';
  }
}

export async function fetchNotes(): Promise<NoteListItem[]> {
  const result = await api.getNotes(1, 100);
  if (!result.success) return [];
  return result.data.items.map((n) => {
    const doc = deserialise(n.content, n.id, n.createdAt, n.updatedAt);
    const body = buildPreview(doc.contentJson);
    return {
      id: n.id,
      title: doc.title,
      contentType: doc.contentType,
      updatedAt: n.updatedAt,
      ...(body !== '' && { body }),
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
