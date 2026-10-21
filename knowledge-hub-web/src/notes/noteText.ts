export interface NoteContentBlock { type?: string; content?: { text?: string }[]; children?: NoteContentBlock[] }

/** Recursively joins block text, skipping non-text blocks. */
export function extractNoteBlockText(blocks: NoteContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (Array.isArray(block.content)) {
      const text = block.content.map(c => c.text ?? '').join('');
      if (text.trim() !== '') parts.push(text.trim());
    }
    if (Array.isArray(block.children)) {
      const childText = extractNoteBlockText(block.children);
      if (childText !== '') parts.push(childText);
    }
  }
  return parts.join('\n');
}
