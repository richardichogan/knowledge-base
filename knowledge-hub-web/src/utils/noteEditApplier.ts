/**
 * utils/noteEditApplier.ts — applies edits Athena proposed to the open Think
 * note, inside the live BlockNote editor (so typing/autosave never clash and
 * the whole set is one ⌘Z step). Sections are located by heading text,
 * tolerant of case, punctuation and "#" prefixes.
 */
import type { BlockNoteEditor } from '@blocknote/core';
import type { NoteEdit } from '../types';
import { nextMatch } from '../../../knowledge-hub-backend/src/utils/textMatches';
import { passageTagKeys } from '../notes/passageTagModel';
import { scriptInlineContent } from '../../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
import { scriptNoteBlocks } from '../../../knowledge-hub-backend/src/utils/scriptNoteContent';
import { groupScriptSections, ungroupScriptSections, splitScriptSectionTail } from '../../../knowledge-hub-backend/src/utils/scriptSections';
import { preserveScriptSelection } from '../notes/scriptSectionSelection';
import type { Transaction } from '@tiptap/pm/state';
import { parseScriptVisuals, visualSourceCurrent } from '../../../knowledge-hub-backend/src/utils/scriptVisuals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

function inlineText(block: Block): string {
  const content: unknown = block?.content;
  if (!Array.isArray(content)) return '';
  return content.map((c: { type?: string; props?: { cue?: string }; text?: string; content?: unknown }) =>
    c.type === 'scriptCue' ? `[${c.props?.cue === 'beat' ? 'beat' : 'pause'}]` : c.text ?? inlineText({ content: c.content })).join('');
}

function replaceInlineText(content: Block[], find: string, replacement: string, script = false, from = 0, wholeWord = false): Block[] {
  const text = inlineText({ content });
  const start = from > 0 || wholeWord ? nextMatch(text, find, wholeWord, from) : text.indexOf(find);
  const end = start + find.length;
  let offset = 0;
  let inserted = false;
  const visit = (items: Block[]): Block[] => items.flatMap(item => {
    if (item.type === 'link' && Array.isArray(item.content)) return [{ ...item, content: visit(item.content) }];
    if (item.type === 'scriptCue') {
      const from = offset;
      offset += item.props?.cue === 'beat' ? '[beat]'.length : '[pause]'.length;
      if (offset <= start || from >= end) return [item];
      if (!script || from < start || offset > end) throw new Error('Select the whole delivery cue to replace it.');
      const insert = inserted ? [] : scriptInlineContent(replacement);
      inserted = true;
      return insert;
    }
    if (item.type === 'noteMention' || item.type === 'entityMention') {
      // Backlinks take no space in the text Athena reads, so they stay put unless the passage runs across one.
      if (offset > start && offset < end) throw new Error('This passage runs across a link to another note. Select the text on one side of the link.');
      return [item];
    }
    if (item.type !== 'text' || typeof item.text !== 'string') {
      throw new Error('This passage contains embedded content. Select a plain text passage instead.');
    }
    const from = offset;
    offset += item.text.length;
    if (offset <= start || from >= end) return [item];
    const prefix = item.text.slice(0, Math.max(0, start - from));
    const suffix = item.text.slice(Math.max(0, end - from));
    const insert = inserted ? '' : replacement;
    inserted = true;
    return script
      ? [...(prefix ? [{ ...item, text: prefix }] : []), ...scriptInlineContent(insert, item.styles ?? {}), ...(suffix ? [{ ...item, text: suffix }] : [])]
      : [{ ...item, text: prefix + insert + suffix }];
  });
  return visit(content);
}

/** Bounded visual edits must never fall back to a fuzzy match or flatten rich blocks. */
export function applyReviewedNoteText(editor: Editor, find: string, replacement: string): void {
  const matches = flatten(editor.document as Block[]).filter(block => inlineText(block).includes(find));
  const target = matches[0];
  if (!find || matches.length !== 1 || inlineText(target).split(find).length !== 2) {
    throw new Error('Select a unique passage within one paragraph or list item. No edits applied.');
  }
  if (target.children?.length || !Array.isArray(target.content)
    || target.content.some((item: { type?: string }) => item.type !== 'text')) {
    throw new Error('This passage contains nested or embedded content. Edit it in MD to preserve its structure.');
  }
  const current = editor.blocksToMarkdownLossy([target]);
  if (current.split(find).length !== 2) {
    throw new Error('The selection crosses formatting boundaries. Select a smaller passage or edit in MD.');
  }
  if (passageTagKeys(target.content).size > 0) {
    throw new Error('This passage contains tags. Edit it directly in MD to preserve them.');
  }
  const next = editor.tryParseMarkdownToBlocks(current.replace(find, () => replacement));
  editor.transact(() => { editor.replaceBlocks([target], next); });
}

function preservePassageTags(before: unknown, after: unknown): void {
  const remaining = passageTagKeys(after);
  if ([...passageTagKeys(before)].some(key => !remaining.has(key))) {
    throw new Error('This change would remove a tagged passage. Edit it directly in the note instead.');
  }
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

/** A short paragraph used as a label (e.g. "Key points") in notes that have no real headings. */
function findLabel(blocks: Block[], heading: string): number {
  const target = norm(heading);
  if (target === '') return -1;
  return blocks.findIndex(b => b.type !== 'heading' && !/ListItem$/.test(String(b.type))
    && inlineText(b).length <= 80 && norm(inlineText(b)) === target);
}

/** Last block of the list that directly follows the label at `i`, or the label itself. */
function labelEnd(blocks: Block[], i: number): Block {
  let end = blocks[i];
  for (let j = i + 1; j < blocks.length && /ListItem$/.test(String(blocks[j].type)); j++) end = blocks[j];
  return end;
}

/** Blocks after heading `i` up to (not including) the next heading of the same or higher level. */
function sectionBody(blocks: Block[], i: number): Block[] {
  const lvl = level(blocks[i]);
  const body: Block[] = [];
  for (let j = i + 1; j < blocks.length; j++) {
    if (blocks[j].type === 'heading' && (blocks[i].props?.scriptSection
      ? blocks[j].props?.scriptSection : level(blocks[j]) <= lvl)) break;
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

// Athena reads a source caption as "Source: …", so a paragraph written that way becomes one.
function sourceCaptions(blocks: Block[]): Block[] {
  return blocks.map(block => {
    if (block.type !== 'paragraph' || !Array.isArray(block.content)) return block;
    const first = block.content[0];
    if (first?.type !== 'text' || !/^Source:\s/.test(first.text ?? '')) return block;
    const text = (first.text as string).replace(/^Source:\s+/, '');
    return { ...block, type: 'sourceCaption', props: {}, content: [...(text ? [{ ...first, text }] : []), ...block.content.slice(1)] };
  });
}

function parse(editor: Editor, markdown: string, script = false): Block[] {
  const blocks = sourceCaptions(editor.tryParseMarkdownToBlocks(withParagraphBreaks(markdown.trim())) as Block[]);
  if (!script) return blocks;
  return (scriptNoteBlocks(blocks) as Block[]).map(block => block.type === 'heading'
    ? { ...block, props: { ...block.props, scriptSection: true } } : block);
}

function validatedVisualEdit(blocks: Block[], edit: NoteEdit, script: boolean) {
  const section = blocks.find(block => block.id === edit.sectionId && block.props?.scriptSection);
  if (!script || !section || !edit.visuals || !visualSourceCurrent(edit.visuals.source, section)
    || (section.props.scriptVisuals ?? '') !== edit.expectedVisuals) {
    throw new Error('The script section or its visuals changed while Ariadne was designing. Nothing was overwritten; request an updated plan.');
  }
  return { section, visuals: parseScriptVisuals(edit.visuals, section) };
}

const FORMAT_TARGETS: Record<NonNullable<NoteEdit['formats']>[number]['style'], { type: string; props: Record<string, unknown> }> = {
  paragraph: { type: 'paragraph', props: {} },
  h1: { type: 'heading', props: { level: 1 } },
  h2: { type: 'heading', props: { level: 2 } },
  h3: { type: 'heading', props: { level: 3 } },
  bullet: { type: 'bulletListItem', props: {} },
  numbered: { type: 'numberedListItem', props: {} },
  checklist: { type: 'checkListItem', props: { checked: false } },
  quote: { type: 'quote', props: {} },
};

/** Removes only a typed list marker from the start of a block; every other character stays. */
function stripLeadingMarker(content: Block[]): Block[] | undefined {
  const first = content[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
  const text = first.text.replace(/^\s*(?:[-*•–]\s+|\d+[.)]\s+|\[[ xX]?\]\s+)/, '');
  return text === first.text ? undefined : [...(text ? [{ ...first, text }] : []), ...content.slice(1)];
}

function applyOne(editor: Editor, edit: NoteEdit, titleBlock: Block | undefined, script: boolean): void {
  const blocks = editor.document as Block[];
  const md = edit.markdown ?? '';
  const titleId = titleBlock?.id;
  switch (edit.action) {
    case 'set_script_visuals': {
      const { section, visuals } = validatedVisualEdit(blocks, edit, script);
      editor.updateBlock(section, { props: { ...section.props, scriptVisuals: JSON.stringify(visuals) } });
      return;
    }
    case 'append': {
      const appendTo = script ? splitScriptSectionTail(blocks).body : blocks;
      const last = appendTo[appendTo.length - 1];
      editor.insertBlocks(parse(editor, md, script), last, 'after');
      return;
    }
    case 'prepend': {
      // After the title heading if the note opens with one, else at the very top.
      const first = blocks[0];
      if (first?.type === 'heading') editor.insertBlocks(parse(editor, md, script), first, 'after');
      else editor.insertBlocks(parse(editor, md, script), first, 'before');
      return;
    }
    case 'add_to_section': {
      const i = findHeading(blocks, edit.heading ?? '');
      if (i < 0) {
        const label = findLabel(blocks, edit.heading ?? '');
        if (label < 0) throw new Error(`Section “${edit.heading ?? ''}” not found`);
        editor.insertBlocks(parse(editor, withoutLeadingHeading(md, edit.heading), script), labelEnd(blocks, label), 'after');
        return;
      }
      const body = sectionBody(blocks, i);
      const anchor = body.length > 0 ? body[body.length - 1] : blocks[i];
      editor.insertBlocks(parse(editor, withoutLeadingHeading(md, edit.heading), script), anchor, 'after');
      return;
    }
    case 'replace_section': {
      const i = findHeading(blocks, edit.heading ?? '');
      if (i < 0) throw new Error(`Section “${edit.heading ?? ''}” not found`);
      if (blocks[i].id === titleId) throw new Error('Athena body edits cannot replace the note title. Edit the title directly.');
      const body = sectionBody(blocks, i);
      if (passageTagKeys([blocks[i], ...body]).size > 0) throw new Error('This section contains tagged passages. Edit it directly in the note instead.');
      const replacement = parse(editor, withoutLeadingHeading(md, edit.heading), script);
      // If the new content brings its own heading, replace the heading too.
      if (replacement[0]?.type === 'heading') {
        if (blocks[i].props?.scriptSection) {
          replacement[0] = { ...replacement[0], id: blocks[i].id, props: {
            ...blocks[i].props, ...replacement[0].props,
            scriptSection: true, scriptDirection: blocks[i].props.scriptDirection ?? '',
          } };
        }
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
      if (blocks[i].id === titleId) throw new Error('Athena body edits cannot delete the note title.');
      const section = [blocks[i], ...sectionBody(blocks, i)];
      if (passageTagKeys(section).size > 0) throw new Error('This section contains tagged passages. Edit it directly in the note instead.');
      editor.removeBlocks(section);
      return;
    }
    case 'replace_all': {
      // A full redraft: the whole note body becomes the new content (one ⌘Z step with the rest).
      const replacement = parse(editor, md, script);
      if (replacement.length > 0) {
        if (passageTagKeys(blocks.filter(block => block.id !== titleId)).size > 0) {
          throw new Error('This note contains tagged passages. Edit it directly in the note instead.');
        }
        if (titleBlock !== undefined) {
          if (replacement[0]?.type === 'heading' && norm(inlineText(replacement[0])) === norm(inlineText(titleBlock))) replacement.shift();
          editor.replaceBlocks(blocks, [titleBlock, ...replacement]);
        } else editor.replaceBlocks(blocks, replacement);
      }
      return;
    }
    case 'format_blocks': {
      const missing: string[] = [];
      const byId = new Map(flatten(blocks).map(candidate => [candidate.id, candidate]));
      for (const format of edit.formats ?? []) {
        const block = byId.get(format.blockId);
        if (!block) { missing.push(format.blockId); continue; }
        const content = format.stripMarker && Array.isArray(block.content)
          ? stripLeadingMarker(block.content) : undefined;
        const target = FORMAT_TARGETS[format.style];
        editor.updateBlock(block, { type: target.type, props: target.props, ...(content && { content }) });
      }
      if (missing.length) throw new Error(`${String(missing.length)} block${missing.length === 1 ? '' : 's'} changed or moved since Athena read the note; nothing in them was altered. Ask Athena to format again.`);
      return;
    }
    case 'move_section': {
      for (const move of edit.moves ?? []) {
        const current = editor.document as Block[];
        const at = current.findIndex(block => block.id === move.blockId);
        const head = current[at];
        if (!head || head.type !== 'heading' || head.id === titleId) throw new Error('A section changed or moved since Athena read the note; nothing was moved. Ask Athena to reorder again.');
        const level = head.props?.level ?? 1;
        let end = at + 1;
        while (end < current.length && !(current[end].type === 'heading' && (current[end].props?.level ?? 1) <= level)) end++;
        const section = current.slice(at, end);
        const target = move.beforeId === undefined ? undefined : current.find(block => block.id === move.beforeId);
        if (move.beforeId !== undefined && (!target || section.includes(target) || target.id === titleId)) {
          throw new Error('The destination section changed or moved since Athena read the note; nothing was moved. Ask Athena to reorder again.');
        }
        editor.removeBlocks(section);
        const rest = editor.document as Block[];
        if (target) editor.insertBlocks(section, target, 'before');
        else editor.insertBlocks(section, rest[rest.length - 1], 'after');
      }
      return;
    }
    case 'replace_every': {
      const find = edit.find ?? '';
      const wholeWord = edit.wholeWord === true;
      let changed = 0;
      let skipped = 0;
      for (const block of flatten(editor.document as Block[])) {
        if (block.id === titleId || !Array.isArray(block.content) || nextMatch(inlineText(block), find, wholeWord) < 0) continue;
        try {
          let content: Block[] = block.content;
          let at = nextMatch(inlineText({ content }), find, wholeWord);
          while (at >= 0) {
            content = replaceInlineText(content, find, md, script, at, wholeWord);
            changed++;
            at = nextMatch(inlineText({ content }), find, wholeWord, at + md.length);
          }
          preservePassageTags(block.content, content);
          editor.updateBlock(block, { content });
        } catch { skipped++; }
      }
      if (skipped > 0) throw new Error(`Changed ${String(changed)}, but left ${String(skipped)} paragraph${skipped === 1 ? '' : 's'} untouched because the text runs across a link or a tagged passage. Edit those by hand.`);
      return;
    }
    case 'replace_text': {
      const find = edit.find ?? '';
      const matches = flatten(blocks).filter(b => inlineText(b).includes(find));
      const target = matches[0];
      if (!find || matches.length !== 1 || inlineText(target).split(find).length !== 2) throw new Error('The passage is missing or no longer unique. Ask Athena for a current, exact text edit.');
      if (target.id === titleId) throw new Error('Athena body edits cannot rename the note. Edit its title directly.');
      if (/[\r\n]/.test(md)) throw new Error('Text edits must stay within the existing paragraph or list item.');
      const content = replaceInlineText(target.content, find, md, script);
      preservePassageTags(target.content, content);
      editor.updateBlock(target, { content });
      return;
    }
  }
}

/**
 * Applies the edits in order. Returns the summaries that failed (e.g. a
 * heading that no longer exists); the rest are applied.
 */
export function applyNoteEdits(editor: Editor, edits: NoteEdit[], options: { script?: boolean } = {}): { applied: number; failed: string[] } {
  const failed: string[] = [];
  let applied = 0;
  if (edits.length && edits.every(edit => edit.action === 'set_script_visuals')) {
    try { edits.forEach(edit => { validatedVisualEdit(editor.document as Block[], edit, options.script === true); }); }
    catch (error) { return { applied: 0, failed: [error instanceof Error ? error.message : 'The visual result could not be validated.'] }; }
  }
  const run = (): void => {
    const cards = options.script && (editor.document as Block[]).some(block => block.props?.scriptSection)
      && edits.some(edit => edit.action !== 'replace_text' && edit.action !== 'replace_every' && edit.action !== 'set_script_visuals');
    if (cards) editor.replaceBlocks(editor.document, ungroupScriptSections(editor.document as Block[]));
    const titleBlock = (editor.document as Block[]).find(block => block.type === 'heading' && inlineText(block).trim());
    for (const edit of edits) {
      try {
        applyOne(editor, edit, titleBlock, options.script === true);
        applied++;
      } catch (err) {
        failed.push(`${edit.summary}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (cards) {
      const current = editor.document as Block[];
      const { body, tail } = splitScriptSectionTail(current);
      editor.replaceBlocks(current, [...groupScriptSections(body, () => ({
        type: 'heading', props: { level: 2, scriptSection: true, scriptDirection: '' },
        content: [], children: [],
      }), { markedOnly: true }), ...tail]);
    }
  };
  // One undo step for the whole set when the editor supports transactions.
  const maybeTransact = (editor as unknown as { transact?: (fn: (transaction?: Transaction) => void) => void }).transact;
  const apply = (transaction?: Transaction): void => {
    if (options.script && transaction) preserveScriptSelection(transaction, run);
    else run();
  };
  if (typeof maybeTransact === 'function') maybeTransact.call(editor, apply);
  else apply();
  return { applied, failed };
}
