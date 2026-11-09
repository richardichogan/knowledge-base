import type { BlockNoteEditor } from '@blocknote/core';
import { SOURCE_CAPTION_TYPE } from './SourceCaption';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
interface Snapshot { json: string; empty: boolean }

const WATCH_MS = 1500;

const isEmptyText = (content: unknown): boolean => Array.isArray(content)
  && content.every((item: { text?: string; content?: unknown }) => (typeof item.text === 'string' ? item.text.trim() === '' : false));

/**
 * Call just before a paste runs. When the paste adds a block (a snip image, pasted text on its
 * own lines) or fills an empty one, a source caption block is inserted after the last such
 * block and focused for typing. Pasting into the middle of existing text adds nothing.
 */
export function watchPasteForSource(editor: Editor): void {
  const before = new Map<string, Snapshot>();
  for (const block of editor.document) {
    before.set(block.id, { json: JSON.stringify(block), empty: isEmptyText(block.content) });
  }
  let unsubscribe: (() => void) | undefined;
  const timer = setTimeout(() => { unsubscribe?.(); }, WATCH_MS);
  unsubscribe = editor.onChange(() => {
    unsubscribe?.();
    clearTimeout(timer);
    const blocks = editor.document;
    let lastIndex = -1;
    blocks.forEach((block, index) => {
      if (block.type === SOURCE_CAPTION_TYPE) return;
      const prior = before.get(block.id);
      if (!prior || (prior.empty && JSON.stringify(block) !== prior.json)) lastIndex = index;
    });
    const target = blocks[lastIndex];
    if (!target || blocks[lastIndex + 1]?.type === SOURCE_CAPTION_TYPE) return;
    setTimeout(() => {
      try {
        if (!editor.getBlock(target.id)) return;
        const [caption] = editor.insertBlocks([{ type: SOURCE_CAPTION_TYPE }], target.id, 'after');
        if (!caption) return;
        editor.setTextCursorPosition(caption.id, 'start');
        editor.focus();
      } catch { /* the editor was closed or changed; the block can be added by hand */ }
    }, 0);
  });
}
