/**
 * utils/jsonNoteEditor.ts — a stand-in for the BlockNote editor over a note's
 * saved block JSON, so background chat tasks can run the shared note-edit
 * applier on the server. Blocks are found by id anywhere in the tree; custom
 * inline content (mentions, cues, passage tags) is carried through untouched.
 */
import { randomUUID } from 'node:crypto';
import { textToBlocks } from '../ai/markdownToNoteBlocks.js';
import type { NoteEditTarget } from './noteEditApplier.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

/** Props every BlockNote block type shares; kept when a block changes type. */
const SHARED_PROPS = ['textColor', 'backgroundColor', 'textAlignment'];

function withIds(blocks: Block[]): Block[] {
  return blocks.map(block => ({
    ...block,
    id: typeof block.id === 'string' && block.id !== '' ? block.id : randomUUID(),
    ...(Array.isArray(block.children) && { children: withIds(block.children) }),
  }));
}

export class JsonNoteEditor implements NoteEditTarget {
  document: Block[];

  constructor(blocks: Block[]) {
    this.document = withIds(structuredClone(blocks));
  }

  private locate(block: Block): { list: Block[]; index: number } {
    const id = block?.id;
    const search = (list: Block[]): { list: Block[]; index: number } | null => {
      for (let index = 0; index < list.length; index++) {
        if (list[index].id === id) return { list, index };
        const children = list[index].children;
        if (Array.isArray(children)) {
          const found = search(children);
          if (found) return found;
        }
      }
      return null;
    };
    const found = typeof id === 'string' ? search(this.document) : null;
    if (!found) throw new Error('A block changed or moved while the edit was being applied.');
    return found;
  }

  updateBlock(block: Block, update: Block): void {
    const { list, index } = this.locate(block);
    const current = list[index];
    const typeChanged = typeof update.type === 'string' && update.type !== current.type;
    const baseProps = typeChanged
      ? Object.fromEntries(Object.entries(current.props ?? {}).filter(([key]) => SHARED_PROPS.includes(key)))
      : current.props ?? {};
    list[index] = {
      ...current,
      ...update,
      id: current.id,
      props: { ...baseProps, ...(update.props ?? {}) },
      ...(Array.isArray(update.children) ? { children: withIds(update.children) } : { children: current.children ?? [] }),
    };
  }

  insertBlocks(blocks: Block[], reference: Block, placement: 'before' | 'after'): void {
    const inserted = withIds(structuredClone(blocks));
    if (reference === undefined) { this.document.push(...inserted); return; }
    const { list, index } = this.locate(reference);
    list.splice(placement === 'after' ? index + 1 : index, 0, ...inserted);
  }

  replaceBlocks(remove: Block[], insert: Block[]): void {
    if (remove.length === 0) return;
    const inserted = withIds(structuredClone(insert));
    const { list, index } = this.locate(remove[0]);
    const removeIds = new Set(remove.map(block => block.id));
    const before = list.slice(0, index).filter(block => !removeIds.has(block.id)).length;
    this.removeBlocks(remove);
    list.splice(before, 0, ...inserted);
  }

  removeBlocks(blocks: Block[]): void {
    // The caller may pass the live document array itself.
    for (const block of [...blocks]) {
      const { list, index } = this.locate(block);
      list.splice(index, 1);
    }
  }

  tryParseMarkdownToBlocks(markdown: string): Block[] {
    return textToBlocks(markdown);
  }
}
