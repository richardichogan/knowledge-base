export interface NoteContentBlock { type?: string; content?: unknown; children?: NoteContentBlock[] }

/** Renders a link chip as text; returning '' drops it. */
export type MentionText = (type: string, id: string) => string;

function contentText(value: unknown, mention?: MentionText): string {
  if (Array.isArray(value)) return value.map(item => contentText(item, mention)).join('');
  if (value === null || typeof value !== 'object') return '';
  if (mention && 'type' in value && (value.type === 'noteMention' || value.type === 'entityMention')
    && 'props' in value && value.props !== null && typeof value.props === 'object') {
    const props = value.props as Record<string, unknown>;
    const type = value.type === 'noteMention' ? 'note' : props['entityType'];
    const id = value.type === 'noteMention' ? props['noteId'] : props['entityId'];
    return typeof type === 'string' && typeof id === 'string' ? mention(type, id) : '';
  }
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('rows' in value && Array.isArray(value.rows)) {
    return value.rows.map(row => {
      if (row === null || typeof row !== 'object' || !('cells' in row) || !Array.isArray(row.cells)) return '';
      return row.cells.map((cell: unknown) => contentText(cell, mention)).join(' | ');
    }).join('\n');
  }
  return 'content' in value ? contentText(value.content, mention) : '';
}

/** Keeps table rows and cell boundaries as well as nested block text. */
export function extractNoteBlockText(blocks: NoteContentBlock[], mention?: MentionText): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const text = contentText(block.content, mention);
    if (text.trim() !== '') parts.push(text.trim());
    if (Array.isArray(block.children)) {
      const childText = extractNoteBlockText(block.children, mention);
      if (childText !== '') parts.push(childText);
    }
  }
  return parts.join('\n');
}
