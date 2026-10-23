export interface NoteContentBlock { type?: string; content?: unknown; children?: NoteContentBlock[] }

function contentText(value: unknown): string {
  if (Array.isArray(value)) return value.map(contentText).join('');
  if (value === null || typeof value !== 'object') return '';
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('rows' in value && Array.isArray(value.rows)) {
    return value.rows.map(row => {
      if (row === null || typeof row !== 'object' || !('cells' in row) || !Array.isArray(row.cells)) return '';
      return row.cells.map(contentText).join(' | ');
    }).join('\n');
  }
  return 'content' in value ? contentText(value.content) : '';
}

/** Keeps table rows and cell boundaries as well as nested block text. */
export function extractNoteBlockText(blocks: NoteContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const text = contentText(block.content);
    if (text.trim() !== '') parts.push(text.trim());
    if (Array.isArray(block.children)) {
      const childText = extractNoteBlockText(block.children);
      if (childText !== '') parts.push(childText);
    }
  }
  return parts.join('\n');
}
