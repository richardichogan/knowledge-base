/**
 * notes/markdownToBlocks.ts — shared markdown → BlockNote block conversion.
 * Used by the Athena chat attach/export flows and by the Think page's
 * standalone file import feature so both land content in the editor
 * identically. Mirrors the backend's textToBlocks() used by create_note_draft.
 */

export interface NoteBlock {
  type: 'heading' | 'paragraph';
  props?: { level: number };
  content: Array<{ type: 'text'; text: string; styles: Record<string, never> }>;
}

/**
 * Splits raw markdown text into simple BlockNote paragraph/heading blocks —
 * good enough for an imported document (not a full markdown renderer).
 */
export function markdownToNoteBlocks(text: string): NoteBlock[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '');
  return paragraphs.map((p) => {
    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(p);
    if (headingMatch) {
      const hashes = headingMatch[1] ?? '#';
      return {
        type: 'heading' as const,
        props: { level: hashes.length },
        content: [{ type: 'text' as const, text: headingMatch[2] ?? '', styles: {} }],
      };
    }
    return { type: 'paragraph' as const, content: [{ type: 'text' as const, text: p, styles: {} }] };
  });
}
