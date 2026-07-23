/**
 * Tiny singleton registry so non-editor code (e.g. the global right-click
 * context menu) can ask "what text is currently selected in the active
 * BlockNote note editor?" without prop-drilling the editor instance around.
 *
 * Needed because BlockNote/ProseMirror table cell-range selections don't
 * populate the browser's native window.getSelection() the way plain text
 * selections do — reading the DOM Selection API for a table selection
 * returns empty/wrong text. editor.getSelectedText() handles both cases
 * correctly.
 *
 * IMPORTANT: we do NOT read the selection live when the context menu opens.
 * Right-clicking causes the browser (and/or ProseMirror) to collapse the
 * selection to the click point before any of our event handlers get a
 * chance to read it, which was producing garbage (e.g. a single word/mention
 * under the cursor instead of the actually-selected rows). Instead we
 * subscribe to editor.onSelectionChange and continuously cache the last
 * *non-empty* selection's text/markdown as the user selects it — well
 * before they right-click — and hand back that snapshot instead.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { BlockNoteEditor } from '@blocknote/core';
import { CellSelection, TableMap } from 'prosemirror-tables';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeEditor: BlockNoteEditor<any, any, any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let unsubscribe: (() => void) | null = null;
let lastSelectionSnapshot = '';
// While true, incoming selectionchange updates are ignored. Set the instant a
// right-click begins (mousedown) so the browser's native "select word under
// cursor to build its context menu" behavior — which happens between
// mousedown and the contextmenu event, before any JS can intervene — can't
// clobber the real snapshot we captured while the user was dragging over the
// table rows.
let captureSuspended = false;

export function suspendBlockNoteSelectionCapture(): void {
  captureSuspended = true;
}

export function resumeBlockNoteSelectionCapture(): void {
  captureSuspended = false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeSelectedText(editor: BlockNoteEditor<any, any, any>): string {
  try {
    // BlockNote's block-level getSelection()/getSelectedText() APIs snap to
    // whole top-level blocks — a table is a SINGLE top-level block, so they
    // can't distinguish "2 selected rows" from "the whole table" (or, worse,
    // return nothing useful). When the raw ProseMirror selection is a
    // CellSelection (dragging across table cells/rows), read the exact
    // selected cells directly instead of going through BlockNote's
    // block-based abstraction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pmState = (editor as any)._tiptapEditor?.state;
    const pmSelection = pmState?.selection;
    if (pmSelection instanceof CellSelection) {
      // Walk up from the anchor cell to find the enclosing `table` node and
      // the doc position right before its content (rows) start — TableMap
      // needs positions relative to that, not absolute doc positions.
      const $anchor = pmSelection.$anchorCell;
      let tableDepth = $anchor.depth;
      while (tableDepth > 0 && $anchor.node(tableDepth).type.name !== 'table') tableDepth--;

      if (tableDepth > 0 && $anchor.node(tableDepth).type.name === 'table') {
        const tableNode = $anchor.node(tableDepth);
        const tableContentStart = $anchor.start(tableDepth);
        const map = TableMap.get(tableNode);
        const rowsByIndex = new Map<number, string[]>();
        pmSelection.forEachCell((node: { textContent: string }, pos: number) => {
          const rect = map.findCell(pos - tableContentStart);
          const row = rowsByIndex.get(rect.top) ?? [];
          row.push(node.textContent.trim());
          rowsByIndex.set(rect.top, row);
        });
        const text = Array.from(rowsByIndex.entries())
          .sort(([a], [b]) => a - b)
          .map(([, cells]) => cells.filter(Boolean).join(' | '))
          .filter(Boolean)
          .join('\n');
        if (text.trim().length > 0) return text.trim();
      }
    }

    const direct = editor.getSelectedText().trim();
    if (direct.length > 2) return direct;

    // Table cell-range (and other multi-block) selections: getSelectedText()
    // can return empty/garbled text since ProseMirror's CellSelection isn't a
    // simple flat text range. Fall back to serializing the actual selected
    // blocks (e.g. table rows/cells) to markdown, which preserves structure.
    const blocks = editor.getSelection()?.blocks;
    if (blocks && blocks.length > 0) {
      return editor.blocksToMarkdownLossy(blocks).trim();
    }
    return direct;
  } catch {
    return '';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setActiveBlockNoteEditor(editor: BlockNoteEditor<any, any, any> | null): void {
  unsubscribe?.();
  unsubscribe = null;
  activeEditor = editor;
  lastSelectionSnapshot = '';

  if (editor) {
    unsubscribe = editor.onSelectionChange(() => {
      if (captureSuspended) return;
      const text = computeSelectedText(editor);
      // Only overwrite the snapshot with meaningful selections — a right-click
      // collapsing the selection fires a selectionchange too, and we don't
      // want that to clobber the good snapshot we captured moments earlier.
      if (text.length > 2) lastSelectionSnapshot = text;
    });
  }
}

export function getActiveBlockNoteSelectedText(): string {
  // While a right-click is in flight, never do a live read — the browser may
  // have already auto-selected a single word to build its (suppressed)
  // native context menu, and reading live here would return that instead of
  // what the user actually selected. Only trust the frozen snapshot.
  if (captureSuspended) return lastSelectionSnapshot;
  if (lastSelectionSnapshot.length > 2) return lastSelectionSnapshot;
  if (!activeEditor) return '';
  return computeSelectedText(activeEditor);
}

/** Clears the cached snapshot — call once the selection has been consumed (e.g. after creating a task) so a stale selection isn't reused next time. */
export function clearActiveBlockNoteSelectionSnapshot(): void {
  lastSelectionSnapshot = '';
}

