/**
 * utils/noteEditApplier.ts — applies edits Athena proposed to the open Think
 * note, inside the live BlockNote editor (so typing/autosave never clash and
 * the whole set is one ⌘Z step). Sections are located by heading text,
 * tolerant of case, punctuation and "#" prefixes.
 */
import type { BlockNoteEditor } from '@blocknote/core';
import type { NoteEdit } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

function inlineText(block: Block): string {
  const content: unknown = block?.content;
  if (!Array.isArray(content)) return '';
  return content.map((c: { text?: string }) => c.text ?? '').join('');
}

function norm(s: string): string {
  return s.toLowerCase().replace(/^#+\s*/, '').replace(/[“”"'’:.\-–—*_`]/g, '').replace(/\s+/g, ' ').trim();
}

function level(block: Block): number {
  return Number(block?.props?.level ?? 1);
}

/** Index of the heading matching `heading` among top-level blocks, or -1. */
function findHeading(blocks: Block[], heading: string): number {
  const target = norm(heading);
  const headings = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'heading');
  const exact = headings.find(({ b }) => norm(inlineText(b)) === target);
  if (exact) return exact.i;
  const partial = headings.find(({ b }) => norm(inlineText(b)).includes(target) || target.includes(norm(inlineText(b))));
  return partial ? partial.i : -1;
}

/** Blocks after heading `i` up to (not including) the next heading of the same or higher level. */
function sectionBody(blocks: Block[], i: number): Block[] {
  const lvl = level(blocks[i]);
  const body: Block[] = [];
  for (let j = i + 1; j < blocks.length; j++) {
    if (blocks[j].type === 'heading' && level(blocks[j]) <= lvl) break;
    body.push(blocks[j]);
  }
  return body;
}

function flatten(blocks: Block[]): Block[] {
  return blocks.flatMap((b) => [b, ...flatten(Array.isArray(b.children) ? b.children : [])]);
}

/**
 * Models often repeat the section heading as the first line of a section's
 * new content ("Background\nThe team…" or "## Background"). The heading is
 * already in the note, so drop that leading line.
 */
function withoutLeadingHeading(markdown: string, heading: string | undefined): string {
  if (heading === undefined) return markdown;
  const lines = markdown.replace(/^\s+/, '').split('\n');
  const first = (lines[0] ?? '').replace(/^\*\*(.*)\*\*$/, '$1');
  if (norm(first) !== norm(heading)) return markdown;
  return lines.slice(1).join('\n').replace(/^\s+/, '');
}

/**
 * Model output often uses single line breaks between what are meant to be
 * separate paragraphs ("Summary\nThis note…"), which Markdown joins into one.
 * Split them — except inside lists, tables, quotes and code blocks.
 */
function withParagraphBreaks(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inCode = false;
  const structural = (l: string): boolean => /^\s*([-*+]\s|\d+[.)]\s|\||>|#)/.test(l);
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inCode = !inCode;
    out.push(line);
    const next = lines[i + 1];
    if (!inCode && next !== undefined && line.trim() !== '' && next.trim() !== '' && !structural(line) && !structural(next)) {
      out.push('');
    }
  });
  return out.join('\n');
}

function parse(editor: Editor, markdown: string): Block[] {
  return editor.tryParseMarkdownToBlocks(withParagraphBreaks(markdown.trim())) as Block[];
}

function applyOne(editor: Editor, edit: NoteEdit): void {
  const blocks = editor.document as Block[];
  const md = edit.markdown ?? '';
  switch (edit.action) {
    case 'append': {
      const last = blocks[blocks.length - 1];
      editor.insertBlocks(parse(editor, md), last, 'after');
      return;
    }
    case 'prepend': {
      // After the title heading if the note opens with one, else at the very top.
      const first = blocks[0];
      if (first?.type === 'heading') editor.insertBlocks(parse(editor, md), first, 'after');
      else editor.insertBlocks(parse(editor, md), first, 'before');
      return;
    }
    case 'add_to_section': {
      const i = findHeading(blocks, edit.heading ?? '');
      if (i < 0) throw new Error(`Section “${edit.heading ?? ''}” not found`);
      const body = sectionBody(blocks, i);
      const anchor = body.length > 0 ? body[body.length - 1] : blocks[i];
      editor.insertBlocks(parse(editor, withoutLeadingHeading(md, edit.heading)), anchor, 'after');
      return;
    }
    case 'replace_section': {
      const i = findHeading(blocks, edit.heading ?? '');
      if (i < 0) throw new Error(`Section “${edit.heading ?? ''}” not found`);
      const body = sectionBody(blocks, i);
      const replacement = parse(editor, withoutLeadingHeading(md, edit.heading));
      // If the new content brings its own heading, replace the heading too.
      if (replacement[0]?.type === 'heading') {
        editor.replaceBlocks([blocks[i], ...body], replacement);
      } else if (body.length > 0) {
        editor.replaceBlocks(body, replacement);
      } else {
        editor.insertBlocks(replacement, blocks[i], 'after');
      }
      return;
    }
    case 'delete_section': {
      const i = findHeading(blocks, edit.heading ?? '');
      if (i < 0) throw new Error(`Section “${edit.heading ?? ''}” not found`);
      editor.removeBlocks([blocks[i], ...sectionBody(blocks, i)]);
      return;
    }
    case 'replace_all': {
      // A full redraft: the whole note body becomes the new content (one ⌘Z step with the rest).
      const replacement = parse(editor, md);
      if (replacement.length > 0) editor.replaceBlocks(blocks, replacement);
      return;
    }
    case 'replace_text': {
      const find = edit.find ?? '';
      const target = flatten(blocks).find((b) => inlineText(b).includes(find))
        ?? flatten(blocks).find((b) => norm(inlineText(b)).includes(norm(find)));
      if (target === undefined) throw new Error(`Text “${find.slice(0, 60)}” not found`);
      const current = editor.blocksToMarkdownLossy([target]);
      const updated = current.includes(find)
        ? current.replace(find, md)
        : inlineText(target).replace(find, md);
      editor.replaceBlocks([target], parse(editor, updated));
      return;
    }
  }
}

/**
 * Applies the edits in order. Returns the summaries that failed (e.g. a
 * heading that no longer exists); the rest are applied.
 */
export function applyNoteEdits(editor: Editor, edits: NoteEdit[]): { applied: number; failed: string[] } {
  const failed: string[] = [];
  let applied = 0;
  const run = (): void => {
    for (const edit of edits) {
      try {
        applyOne(editor, edit);
        applied++;
      } catch (err) {
        failed.push(`${edit.summary}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  // One undo step for the whole set when the editor supports transactions.
  const maybeTransact = (editor as unknown as { transact?: (fn: () => void) => void }).transact;
  if (typeof maybeTransact === 'function') maybeTransact.call(editor, run);
  else run();
  return { applied, failed };
}
