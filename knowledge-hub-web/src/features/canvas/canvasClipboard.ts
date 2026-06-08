/**
 * canvasClipboard.ts
 * Helpers for copying hub items to the clipboard in a format the canvas
 * recognises, so pasting into the canvas creates a linked hub_ref node.
 *
 * Strategy: plain text is always written as  __kh__{json}
 * The paste handler reads text/plain and looks for that prefix.
 * Custom MIME types are NOT used — browsers block them in paste events.
 */

export interface CanvasClipboardItem {
  id: string;
  refType: string;   // 'discover_item' | 'spark' | 'note' | etc.
  label: string;
  body?: string;     // synopsis / body text to show on the node
  url?: string;      // source URL
  tags?: string[];   // badge labels
}

/**
 * Write a hub item to the clipboard.
 * Plain text is always written as __kh__{json} so the paste handler
 * can detect it regardless of whether the custom MIME type is readable.
 */
export async function copyItemToCanvas(item: CanvasClipboardItem): Promise<void> {
  const json    = JSON.stringify(item);
  const encoded = `__kh__${json}`;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([encoded], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    // Safari / Firefox fallback
    await navigator.clipboard.writeText(encoded);
  }
}

/**
 * Try to read a CanvasClipboardItem from a ClipboardEvent.
 * Returns null if the clipboard doesn't contain a hub item.
 */
export function readCanvasItem(e: ClipboardEvent): CanvasClipboardItem | null {
  if (!e.clipboardData) return null;

  const text = e.clipboardData.getData('text/plain');
  if (text.startsWith('__kh__')) {
    try { return JSON.parse(text.slice(6)) as CanvasClipboardItem; } catch { /* fall through */ }
  }

  return null;
}

/**
 * Read plain text from a ClipboardEvent.
 */
export function readPlainText(e: ClipboardEvent): string {
  return e.clipboardData?.getData('text/plain') ?? '';
}
