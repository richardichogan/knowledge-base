import { object } from '../jobs/contracts.js';
import { ValidationError } from '../types/errors.js';
import type { Draft } from './contracts.js';

const ERROR_PASSAGE_PREVIEW_LENGTH = 100;
const PARAGRAPH_BODY_GROUP = 3;
const PARAGRAPH_CLOSE_GROUP = 4;

function passageWrapper(value: string): string {
  const block = /^(\s*<(p|h[1-6]|li|blockquote)\b[^>]*>)([\s\S]*)(<\/\2\s*>\s*)$/i.exec(value);
  const inner = block ? block[PARAGRAPH_BODY_GROUP]! : value;
  if (/<\/?(?:p|h[1-6]|li|blockquote|div|section|article|ul|ol)\b/i.test(inner) || /\n\s*\n/.test(inner)) {
    throw new ValidationError('Editorial repairs must change one sentence or paragraph at a time. The saved draft is unchanged.');
  }
  return block ? `${block[1]}${block[PARAGRAPH_CLOSE_GROUP]}` : '';
}

export function applyEditorialEdits(destination: Draft['destination'], content: Record<string, unknown>, value: unknown, additionalFields: readonly string[] = []): Record<string, unknown> {
  const response = object(value);
  if (!Array.isArray(response.edits) || !response.edits.length) throw new ValidationError('Editorial repair returned no passage edits. The saved draft is unchanged.');
  const allowed = [...(destination === 'blog' ? ['title', 'slug', 'excerpt', 'summary', 'content', 'keyTakeaways', 'twitterCopy'] : ['copy']), ...additionalFields];
  const replacements: Array<{ field: string; index: number | null; start: number; end: number; after: string }> = [];
  for (const input of response.edits) {
    const edit = object(input);
    if (typeof edit.field !== 'string' || !allowed.includes(edit.field) || typeof edit.before !== 'string'
      || !edit.before.trim() || typeof edit.after !== 'string' || edit.before === edit.after) {
      throw new ValidationError('Editorial repair returned an invalid or unchanged passage. The saved draft is unchanged.');
    }
    let wrapper: string;
    try {
      wrapper = passageWrapper(edit.before);
      if (edit.after !== '' && wrapper !== passageWrapper(edit.after)) throw new ValidationError('Editorial repair changed paragraph structure. The saved draft is unchanged.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      throw new ValidationError(`${edit.field} (${edit.before.slice(0, ERROR_PASSAGE_PREVIEW_LENGTH)}): ${error.message}`);
    }
    const before = edit.before;
    const field = content[edit.field];
    const values: unknown[] = Array.isArray(field) ? field : [field];
    const matches: Array<{ index: number | null; start: number }> = [];
    values.forEach((candidate, index) => {
      if (typeof candidate !== 'string') return;
      const start = candidate.indexOf(before);
      if (start < 0) return;
      if (candidate.lastIndexOf(before) !== start) throw new ValidationError('Editorial repair matched an ambiguous passage. The saved draft is unchanged.');
      matches.push({ index: Array.isArray(field) ? index : null, start });
    });
    if (matches.length !== 1) throw new ValidationError('Editorial repair did not identify one exact saved passage. The saved draft is unchanged.');
    const match = matches[0]!;
    const replacement = { field: edit.field, ...match, end: match.start + edit.before.length, after: edit.after };
    if (replacements.some(prior => prior.field === replacement.field && prior.index === replacement.index
      && prior.start < replacement.end && replacement.start < prior.end)) {
      throw new ValidationError('Editorial repair returned overlapping passages. The saved draft is unchanged.');
    }
    replacements.push(replacement);
  }
  if (!replacements.length) throw new ValidationError('Editorial repair returned no usable passage edits. The saved draft is unchanged.');
  const revised = { ...content };
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    const field = revised[edit.field];
    const current: unknown = edit.index === null ? field : Array.isArray(field) ? field[edit.index] : undefined;
    if (typeof current !== 'string') throw new ValidationError('Editorial repair targeted a non-text field. The saved draft is unchanged.');
    const patched = current.slice(0, edit.start) + edit.after + current.slice(edit.end);
    if (!patched.trim() && edit.index === null) throw new ValidationError('Editorial repair removed a required passage. The saved draft is unchanged.');
    if (edit.index === null) revised[edit.field] = patched;
    else if (Array.isArray(field)) revised[edit.field] = field.map((item: unknown, index: number) => index === edit.index ? patched : item);
  }
  for (const [field, value] of Object.entries(revised)) {
    if (Array.isArray(value)) revised[field] = value.filter(item => item !== '');
  }
  return revised;
}
