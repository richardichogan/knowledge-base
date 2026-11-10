/**
 * utils/noteEditApplier.ts — the browser side of the shared note-edit applier
 * (knowledge-hub-backend/src/utils/noteEditApplier.ts), run inside the live
 * BlockNote editor so the whole set is one undo step.
 */
import type { BlockNoteEditor } from '@blocknote/core';
import type { NoteEdit } from '../types';
import { passageTagKeys } from '../notes/passageTagModel';
import { preserveScriptSelection } from '../notes/scriptSectionSelection';
import type { Transaction } from '@tiptap/pm/state';
import { applyNoteEdits as applyShared, flatten, inlineText, type NoteEditOutcome, type NoteEditTarget } from '../../../knowledge-hub-backend/src/utils/noteEditApplier';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

/** Bounded visual edits must never fall back to a fuzzy match or flatten rich blocks. */
export function applyReviewedNoteText(editor: Editor, find: string, replacement: string): void {
  const matches = flatten(editor.document as Block[]).filter(block => inlineText(block).includes(find));
  const target = matches[0];
  if (!find || matches.length !== 1 || inlineText(target).split(find).length !== 2) {
    throw new Error('Select a unique passage within one paragraph or list item. No edits applied.');
  }
  if (target.children?.length || !Array.isArray(target.content)
    || target.content.some((item: { type?: string }) => item.type !== 'text')) {
    throw new Error('This passage contains nested or embedded content. Edit it in MD to preserve its structure.');
  }
  const current = editor.blocksToMarkdownLossy([target]);
  if (current.split(find).length !== 2) {
    throw new Error('The selection crosses formatting boundaries. Select a smaller passage or edit in MD.');
  }
  if (passageTagKeys(target.content).size > 0) {
    throw new Error('This passage contains tags. Edit it directly in MD to preserve them.');
  }
  const next = editor.tryParseMarkdownToBlocks(current.replace(find, () => replacement));
  editor.transact(() => { editor.replaceBlocks([target], next); });
}

/**
 * Applies the edits in order. Returns the summaries that failed (e.g. a
 * heading that no longer exists); the rest are applied.
 */
export function applyNoteEdits(editor: Editor, edits: NoteEdit[], options: { script?: boolean } = {}): { applied: number; failed: string[]; outcomes: NoteEditOutcome[] } {
  return applyShared(editor as unknown as NoteEditTarget, edits, {
    script: options.script,
    wrap: options.script ? (transaction, run) => { preserveScriptSelection(transaction as Transaction, run); } : undefined,
  });
}
