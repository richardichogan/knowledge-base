/**
 * notes/markdownToBlocks.ts — shared markdown → BlockNote block conversion.
 * Used by the Athena chat attach/export flows and by the Think page's
 * standalone file import feature so both land content in the editor
 * identically.
 */

import { BlockNoteEditor } from '@blocknote/core';
import { editorSchema } from './editorSchema';

let markdownParser: ReturnType<typeof BlockNoteEditor.create<{ schema: typeof editorSchema }>> | null = null;

function getMarkdownParser(): ReturnType<typeof BlockNoteEditor.create<{ schema: typeof editorSchema }>> {
  markdownParser ??= BlockNoteEditor.create({ schema: editorSchema });
  return markdownParser;
}

/**
 * Parses Markdown using BlockNote's native Markdown importer so native .md files,
 * Athena saves, and the editor all agree on headings, lists, quotes, code
 * blocks, links, tables, inline marks, and nested structure.
 */
export function markdownToNoteBlocks(text: string): unknown[] {
  const markdown = text.trim();
  if (markdown === '') return [];
  return getMarkdownParser().tryParseMarkdownToBlocks(markdown);
}

/** Plain text becomes editable paragraphs without treating Markdown or HTML as formatting. */
export function plainTextToNoteBlocks(text: string): { type: 'paragraph'; content: string }[] {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (normalised.trim() === '') return [];
  return normalised.split('\n').map(content => ({ type: 'paragraph', content }));
}
