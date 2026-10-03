/**
 * ai/noteEdits.ts — edits Athena *proposes* to the Think note that is open
 * alongside the chat. Nothing here changes the saved note: proposals are
 * returned with the reply and applied in the user's live editor only when
 * they click Apply (so there's no clash with typing/autosave, and ⌘Z undoes).
 */

export type NoteEditAction =
  | 'append'           // add to the end of the note
  | 'prepend'          // add at the top (after the title heading)
  | 'add_to_section'   // add at the end of the section under `heading`
  | 'replace_section'  // replace the content under `heading` (heading kept unless markdown starts with one)
  | 'delete_section'   // remove `heading` and its content
  | 'replace_text'     // replace exact text `find` with `markdown`
  | 'replace_all';     // rewrite the whole note body with `markdown` (a full redraft)

export interface NoteEditProposal {
  action: NoteEditAction;
  heading?: string;
  find?: string;
  markdown?: string;
  summary: string;
}

const ACTIONS: readonly NoteEditAction[] = ['append', 'prepend', 'add_to_section', 'replace_section', 'delete_section', 'replace_text', 'replace_all'];

/** Validates the model's proposed edits; returns cleaned edits plus any problems to report back. */
export function validateNoteEdits(raw: unknown): { edits: NoteEditProposal[]; problems: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const edits: NoteEditProposal[] = [];
  const problems: string[] = [];
  list.forEach((item, i) => {
    const e = (item ?? {}) as Record<string, unknown>;
    const action = ACTIONS.find((a) => a === e['action']);
    const str = (k: string): string | undefined => (typeof e[k] === 'string' && (e[k] as string).trim() !== '' ? (e[k] as string) : undefined);
    const heading = str('heading');
    const find = str('find');
    const markdown = str('markdown');
    const summary = str('summary') ?? action ?? 'Edit';
    if (action === undefined) { problems.push(`edit ${String(i + 1)}: unknown action`); return; }
    if ((action === 'add_to_section' || action === 'replace_section' || action === 'delete_section') && heading === undefined) {
      problems.push(`edit ${String(i + 1)}: "${action}" needs the exact heading text`); return;
    }
    if (action === 'replace_text' && (find === undefined || markdown === undefined)) {
      problems.push(`edit ${String(i + 1)}: replace_text needs "find" (exact existing text) and "markdown" (replacement)`); return;
    }
    if (action !== 'delete_section' && action !== 'replace_text' && markdown === undefined) {
      problems.push(`edit ${String(i + 1)}: "${action}" needs "markdown" content`); return;
    }
    edits.push({
      action,
      summary: summary.slice(0, 200),
      ...(heading !== undefined && { heading: heading.trim() }),
      ...(find !== undefined && { find }),
      ...(markdown !== undefined && { markdown }),
    });
  });
  return { edits, problems };
}

// ── Checking proposals against the note as saved ─────────────────────────────
// Mirrors the matching in the web app's noteEditApplier, so anything that
// passes here can be applied when he clicks Apply.

interface NoteBlock { type?: string; props?: { level?: number }; content?: unknown; children?: NoteBlock[] }

function blockText(b: NoteBlock): string {
  return Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('') : '';
}

function norm(s: string): string {
  return s.toLowerCase().replace(/^#+\s*/, '').replace(/[“”"'’:.\-–—*_`]/g, '').replace(/\s+/g, ' ').trim();
}

function flattenBlocks(blocks: NoteBlock[]): NoteBlock[] {
  return blocks.flatMap((b) => [b, ...flattenBlocks(Array.isArray(b.children) ? b.children : [])]);
}

/** The note's top-level headings, as the applier sees them. */
export function noteHeadings(blocks: NoteBlock[]): string[] {
  return blocks.filter((b) => b.type === 'heading').map(blockText).filter((t) => t.trim() !== '');
}

/**
 * Problems with proposed edits against the note's current blocks: section
 * headings that aren't in the note, and "find" text that isn't in it.
 */
/** Headings written in a block of markdown ("## Title" lines), in order. */
function markdownHeadings(markdown: string | undefined): string[] {
  return (markdown ?? '').split('\n').map((l) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l)?.[1]).filter((h): h is string => h !== undefined).map((h) => norm(h));
}

/**
 * Problems with proposed edits against the note's current blocks: section headings that aren't in
 * the note, and "find" text that isn't in it. Edits apply in order, so each is checked against the
 * note as the EARLIER edits will have left it — a section renamed or added by edit 1 can be the
 * target of edit 2, and one removed by edit 1 can't.
 */
export function checkEditsAgainstNote(edits: NoteEditProposal[], blocks: NoteBlock[], alreadyProposed = 0): string[] {
  let headings = noteHeadings(blocks).map((h) => norm(h));
  let texts = flattenBlocks(blocks).map(blockText);
  const problems: string[] = [];
  // `alreadyProposed` edits (earlier calls this turn) shape the headings but aren't reported on again; numbering restarts after them.
  const label = (i: number): string => String(i - alreadyProposed + 1);
  const hasHeading = (target: string): boolean => headings.some((h) => h === target || h.includes(target) || (target.includes(h) && h !== ''));
  edits.forEach((e, i) => {
    const n = label(i);
    const reported = i >= alreadyProposed;
    const wanted = e.heading !== undefined ? norm(e.heading) : '';
    if (reported && wanted !== '' && (e.action === 'add_to_section' || e.action === 'replace_section' || e.action === 'delete_section') && !hasHeading(wanted)) {
      problems.push(`edit ${n}: there is no heading "${e.heading ?? ''}" in the note${i > 0 ? ' (as it will be after the edits before this one)' : ''}`);
    }
    if (reported && e.action === 'replace_text' && e.find !== undefined) {
      const find = e.find;
      const found = texts.some((t) => t.includes(find)) || texts.some((t) => norm(t).includes(norm(find)));
      if (!found) problems.push(`edit ${n}: the text to replace ("${find.slice(0, 80)}") is not in the note — "find" must be copied exactly from a single paragraph`);
    }
    // Carry this edit's effect on the headings forward.
    const written = markdownHeadings(e.markdown);
    if (e.action === 'replace_all') {
      headings = written;
      texts = (e.markdown ?? '').split('\n').filter((l) => l.trim() !== '');
    } else if (e.action === 'replace_section' && wanted !== '') {
      const at = headings.findIndex((h) => h === wanted || h.includes(wanted) || (wanted.includes(h) && h !== ''));
      // A replacement that brings its own heading replaces the heading too; otherwise the heading stays.
      if (at >= 0 && written.length > 0 && !written.includes(wanted)) headings.splice(at, 1, ...written);
      else if (written.length > 0) headings.push(...written.filter((h) => !headings.includes(h)));
    } else if (e.action === 'delete_section' && wanted !== '') {
      headings = headings.filter((h) => !(h === wanted || h.includes(wanted)));
    } else if (written.length > 0) {
      headings.push(...written);
    }
    if (e.action !== 'replace_all' && e.markdown !== undefined) texts = [...texts, ...e.markdown.split('\n').filter((l) => l.trim() !== '')];
  });
  return problems;
}
