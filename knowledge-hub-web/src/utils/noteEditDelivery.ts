import type { NoteEdit, NoteEditDeliveryResult } from '../types/ai';
import { noteDraftIdentity } from '../services/auth';
import { applyNoteEdits } from './noteEditApplier';
import { getActiveBlockNoteEditor, getActiveNoteId, isActiveScriptEditor, runNoteAction } from './activeBlockNoteEditor';

const active = new Map<string, Promise<NoteEditDeliveryResult>>();
type Receipt = NoteEditDeliveryResult | { state: 'applying' };

function receiptKey(messageId: string, noteId: string): string {
  const identity = noteDraftIdentity.get();
  if (!identity) throw new Error('The signed-in note recovery session is unavailable. No automatic edits applied.');
  return `athena-note-edit:${identity}:${noteId}:${messageId}`;
}

function readReceipt(key: string): Receipt | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('state' in value)) throw new Error('The note-edit receipt could not be read. Check the note before repeating the edit.');
  if (value.state === 'applying') return { state: 'applying' };
  if ((value.state !== 'saved' && value.state !== 'partial' && value.state !== 'blocked') || !('applied' in value) || typeof value.applied !== 'number'
    || !('failed' in value) || !Array.isArray(value.failed) || !value.failed.every(item => typeof item === 'string')
    || 'error' in value && typeof value.error !== 'string') throw new Error('The note-edit receipt is invalid. Check the note before repeating the edit.');
  return { state: value.state, applied: value.applied, failed: value.failed,
    ...('error' in value && typeof value.error === 'string' ? { error: value.error } : {}) };
}

const interrupted = (): NoteEditDeliveryResult => ({
  state: 'blocked', applied: 0, failed: [],
  error: 'This edit was already started, but its save receipt is unavailable. Check the note and its history before repeating it; it has not been applied again.',
});

/** Call only for a newly completed live turn, never while rendering or loading history. */
export async function deliverNoteEdits(messageId: string | undefined, noteId: string, edits: NoteEdit[]): Promise<NoteEditDeliveryResult> {
  if (!messageId) return { state: 'blocked', applied: 0, failed: [], error: 'The reply has no stable edit receipt ID. No automatic changes applied.' };
  let key: string;
  try { key = receiptKey(messageId, noteId); }
  catch (error) { return { state: 'blocked', applied: 0, failed: [], error: error instanceof Error ? error.message : 'The note recovery session is unavailable.' }; }
  const existing = active.get(key);
  if (existing) return existing;
  const work = (async (): Promise<NoteEditDeliveryResult> => {
    let applied = 0;
    let failed: string[] = [];
    try {
      const previous = readReceipt(key);
      if (previous) return previous.state === 'applying' ? interrupted() : previous;
      const editor = getActiveBlockNoteEditor();
      if (!editor || getActiveNoteId() !== noteId) throw new Error('The target note is no longer open. No automatic changes applied.');
      // Mark before mutating: reconnecting must not duplicate an append or overwrite a later user edit.
      sessionStorage.setItem(key, JSON.stringify({ state: 'applying' }));
      await runNoteAction(noteId, true, () => {
        const result = applyNoteEdits(editor, edits, { script: isActiveScriptEditor() });
        applied = result.applied; failed = result.failed;
      });
      const result: NoteEditDeliveryResult = { state: failed.length ? 'partial' : 'saved', applied, failed };
      sessionStorage.setItem(key, JSON.stringify(result));
      return result;
    } catch (error) {
      const result: NoteEditDeliveryResult = { state: 'blocked', applied, failed,
        error: error instanceof Error ? error.message : 'Could not apply and save the note edit.' };
      console.error('[Athena note edit]', error);
      try { sessionStorage.setItem(key, JSON.stringify(result)); }
      catch (storageError) { console.error('[Athena note edit receipt]', storageError); }
      return result;
    }
  })();
  active.set(key, work);
  try { return await work; } finally { active.delete(key); }
}
