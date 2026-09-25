/**
 * notes/markdownToBlocks.ts — shared markdown → BlockNote block conversion.
 * Used by the Athena chat attach/export flows and by the Think page's
 * standalone file import feature so both land content in the editor
 * identically. Mirrors the backend's textToBlocks() used by create_note_draft.
 */

export interface NoteBlock {
  type: 'heading' | 'paragraph';
  props?: { level: number };
  content: Array<{ type: 'text'; text: string; styles: Partial<Record<'bold' | 'italic' | 'code', boolean>> }>;
}

type InlineStyle = NoteBlock['content'][number]['styles'];

function parseInlineMarkdown(text: string): NoteBlock['content'] {
  const segments: NoteBlock['content'] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index), styles: {} });
    }

    const styles: InlineStyle = {};
    const matchedText = match[2] ?? match[3] ?? match[4] ?? '';
    if (match[2] !== undefined) styles.bold = true;
    if (match[3] !== undefined) styles.code = true;
    if (match[4] !== undefined) styles.italic = true;
    segments.push({ type: 'text', text: matchedText, styles });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex), styles: {} });
  }

  return segments.length > 0 ? segments : [{ type: 'text', text, styles: {} }];
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
        content: parseInlineMarkdown(headingMatch[2] ?? ''),
      };
    }
    return { type: 'paragraph' as const, content: parseInlineMarkdown(p) };
  });
}
