import type { NoteEdit, NoteEditDeliveryResult } from '../types/ai';
import { noteDraftIdentity } from '../services/auth';
import { applyNoteEdits } from './noteEditApplier';
import { getActiveBlockNoteEditor, getActiveNoteId, isActiveScriptEditor, runNoteAction } from './activeBlockNoteEditor';

const active = new Map<string, Promise<NoteEditDeliveryResult>>();
type Receipt = NoteEditDeliveryResult | { state: 'applying' };

function receiptKey(messageId: string, noteId: string): string {
  const identity = noteDraftIdentity.get();
  if (!identity) throw new Error('I couldn’t reach your note session, so I left the note alone.');
  return `athena-note-edit:${identity}:${noteId}:${messageId}`;
}

function readReceipt(key: string): Receipt | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('state' in value)) throw new Error('I couldn’t tell whether that saved. Have a quick look at the note before trying again.');
  if (value.state === 'applying') return { state: 'applying' };
  if ((value.state !== 'saved' && value.state !== 'partial' && value.state !== 'blocked') || !('applied' in value) || typeof value.applied !== 'number'
    || !('failed' in value) || !Array.isArray(value.failed) || !value.failed.every(item => typeof item === 'string')
    || 'error' in value && typeof value.error !== 'string') throw new Error('I couldn’t tell whether that saved. Have a quick look at the note before trying again.');
  return { state: value.state, applied: value.applied, failed: value.failed,
    ...('error' in value && typeof value.error === 'string' ? { error: value.error } : {}) };
}

const interrupted = (): NoteEditDeliveryResult => ({
  state: 'blocked', applied: 0, failed: [],
  error: 'I’d already started on this one but lost track of whether it saved. Check the note before asking again; I haven’t applied it twice.',
});

/** Call only for a newly completed live turn, never while rendering or loading history. */
export async function deliverNoteEdits(messageId: string | undefined, noteId: string, edits: NoteEdit[]): Promise<NoteEditDeliveryResult> {
  if (!messageId) return { state: 'blocked', applied: 0, failed: [], error: 'Something went wrong on my side, so I left the note alone.' };
  let key: string;
  try { key = receiptKey(messageId, noteId); }
  catch (error) { return { state: 'blocked', applied: 0, failed: [], error: error instanceof Error ? error.message : 'I couldn’t reach your note session.' }; }
  const existing = active.get(key);
  if (existing) return existing;
  const work = (async (): Promise<NoteEditDeliveryResult> => {
    let applied = 0;
    let failed: string[] = [];
    try {
      const previous = readReceipt(key);
      if (previous) return previous.state === 'applying' ? interrupted() : previous;
      const editor = getActiveBlockNoteEditor();
      if (!editor || getActiveNoteId() !== noteId) throw new Error('That note isn’t open any more, so I left it alone. Open it and ask again.');
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
        error: error instanceof Error ? error.message : 'Those changes didn’t save.' };
      console.error('[Athena note edit]', error);
      try { sessionStorage.setItem(key, JSON.stringify(result)); }
      catch (storageError) { console.error('[Athena note edit receipt]', storageError); }
      return result;
    }
  })();
  active.set(key, work);
  try { return await work; } finally { active.delete(key); }
}
