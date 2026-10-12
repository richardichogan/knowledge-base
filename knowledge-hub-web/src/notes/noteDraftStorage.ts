import { CONTENT_TYPE_OPTIONS, type ContentType } from './constants';
import type { NoteDocument } from './types';

export interface NoteDraft {
  version: 1; id: string; identity: string; noteId: string; baseRevision: number; updatedAt: string;
  writing: { title: string; contentType: ContentType; contentJson: string };
}
export const NOTE_DRAFT_PREFIX = 'kh-note-draft-v1:';
const MAX_DRAFT_CHARACTERS = 2_000_000;
const MAX_LISTED_DRAFTS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && [...value].every(character => character.charCodeAt(0) >= 32);
}
export function noteDraftKey(identity: string, noteId: string, draftId: string): string {
  if (!boundedText(identity, 1024) || !boundedText(noteId, 256) || !UUID.test(draftId)) throw new Error('Invalid draft identity.');
  return `${NOTE_DRAFT_PREFIX}${encodeURIComponent(identity)}:${encodeURIComponent(noteId)}:${draftId}`;
}
export function parseNoteDraft(raw: string, identity: string, expectedKey?: string): NoteDraft {
  if (raw.length > MAX_DRAFT_CHARACTERS) throw new Error('This local draft is too large to recover safely.');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid local draft.');
  const value = parsed as Record<string, unknown>;
  const writing = value['writing'];
  if (value['version'] !== 1 || value['identity'] !== identity || !boundedText(value['identity'], 1024)
    || typeof value['id'] !== 'string' || !UUID.test(value['id']) || !boundedText(value['noteId'], 256)
    || typeof value['baseRevision'] !== 'number' || !Number.isSafeInteger(value['baseRevision']) || value['baseRevision'] < 0
    || typeof value['updatedAt'] !== 'string' || !Number.isFinite(Date.parse(value['updatedAt']))
    || typeof writing !== 'object' || writing === null || Array.isArray(writing)) throw new Error('Invalid or differently owned local draft.');
  const fields = writing as Record<string, unknown>;
  const contentType = CONTENT_TYPE_OPTIONS.find(option => option.id === fields['contentType'])?.id;
  if (typeof fields['title'] !== 'string' || fields['title'].length > 10_000 || !contentType
    || typeof fields['contentJson'] !== 'string' || !Array.isArray(JSON.parse(fields['contentJson']) as unknown)) {
    throw new Error('This local draft has unsupported writing. Its stored record has not been changed.');
  }
  const key = noteDraftKey(identity, value['noteId'], value['id']);
  if (expectedKey !== undefined && key !== expectedKey) throw new Error('Local draft identity does not match its storage key.');
  return {
    version: 1, id: value['id'], identity, noteId: value['noteId'], baseRevision: value['baseRevision'], updatedAt: value['updatedAt'],
    writing: { title: fields['title'], contentType, contentJson: fields['contentJson'] },
  };
}
export function captureNoteDraft(identity: string, draftId: string, doc: NoteDocument, now = new Date()): NoteDraft {
  return parseNoteDraft(JSON.stringify({
    version: 1, id: draftId, identity, noteId: doc.id, baseRevision: doc.revision ?? 0, updatedAt: now.toISOString(),
    writing: { title: doc.title, contentType: doc.contentType, contentJson: doc.contentJson },
  }), identity);
}
export function storeNoteDraft(storage: Storage, draft: NoteDraft): string {
  const raw = JSON.stringify(draft);
  const key = noteDraftKey(draft.identity, draft.noteId, draft.id);
  parseNoteDraft(raw, draft.identity, key);
  storage.setItem(key, raw);
  return raw;
}
/** A late acknowledgement must never delete writing captured after that request began. */
export function removeNoteDraftIfUnchanged(storage: Storage, draft: NoteDraft, expectedRaw: string): boolean {
  const key = noteDraftKey(draft.identity, draft.noteId, draft.id);
  if (storage.getItem(key) !== expectedRaw) return false;
  storage.removeItem(key);
  return true;
}
export function listNoteDrafts(storage: Storage, identity: string): {
  drafts: NoteDraft[]; errors: Array<{ key: string; error: Error }>; truncated: boolean;
} {
  if (!boundedText(identity, 1024)) throw new Error('Sign in before reviewing local drafts.');
  const prefix = `${NOTE_DRAFT_PREFIX}${encodeURIComponent(identity)}:`;
  const drafts: NoteDraft[] = [];
  const errors: Array<{ key: string; error: Error }> = [];
  let truncated = false;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    if (drafts.length + errors.length >= MAX_LISTED_DRAFTS) { truncated = true; break; }
    try {
      const raw = storage.getItem(key);
      if (raw !== null) drafts.push(parseNoteDraft(raw, identity, key));
    } catch (error) {
      errors.push({ key, error: error instanceof Error ? error : new Error('Could not read this local draft.') });
    }
  }
  return { drafts: drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), errors, truncated };
}
export function clearAllNoteDrafts(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(NOTE_DRAFT_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
