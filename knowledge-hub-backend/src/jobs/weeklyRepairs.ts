import { applyEditorialEdits } from '../publishing/passageEdits.js';
import { ValidationError } from '../types/errors.js';
import { object } from './contracts.js';

const sentences = new Intl.Segmenter('en-GB', { granularity: 'sentence' });
const MIN_ECHO_WORDS = 3;
const WRAPPER_BODY = 3;
const WRAPPER_CLOSE = 4;
const protectedPatterns = [
  /<a\b[^>]*>[\s\S]*?<\/a>/gi,
  /\[[^\n]*?\]\(https?:\/\/[^)\s]+\)/g,
  /<https?:\/\/[^>]+>/g,
  /https?:\/\/[^\s<>)]+/g,
  /"[^"\n]+"|“[^”\n]+”|‘[^’\n]+’|`[^`\n]+`/g,
  /^>[^\n]*$/gm,
  /<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi,
];

export function protectedWeeklyText(text: string, sources: unknown): string[] {
  const spans = protectedPatterns.flatMap(pattern => [...text.matchAll(new RegExp(pattern))].map(match => match[0]));
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source !== 'object') continue;
    const entry = object(source);
    if (typeof entry.title === 'string' && text.includes(entry.title)) spans.push(entry.title);
    for (const { segment } of sentences.segment(text)) {
      const passage = segment.trim();
      if (passage.split(/\s+/).length >= MIN_ECHO_WORDS
        && [entry.body, entry.summary].some(value => typeof value === 'string' && value.includes(passage))) {
        spans.push(passage);
      }
    }
  }
  return [...new Set(spans)];
}

/** Preserve source wording and constrain each proposed replacement to one sentence or phrase. */
export function applyWeeklyRepairs(
  content: Record<string, unknown>, response: unknown, fields: readonly string[], sources: unknown, sentenceLimit = 1,
): { content: Record<string, unknown>; rejected: Array<{ edit: unknown; error: string }>;
  applied: Array<{ field: string; before: string; after: string }> } {
  const edits = object(response).edits;
  if (!Array.isArray(edits) || !edits.length) throw new ValidationError('The weekly editor returned no edits.');
  let revised = content;
  const rejected: Array<{ edit: unknown; error: string }> = [];
  const applied: Array<{ field: string; before: string; after: string }> = [];
  for (const value of edits) {
    try {
      const input = object(value);
      if (typeof input.before !== 'string' || typeof input.after !== 'string' || typeof input.field !== 'string') {
        throw new ValidationError('An edit requires field, before and after strings.');
      }
      const edit = { before: input.before, after: input.after, field: input.field };
      if (!fields.includes(edit.field)) throw new ValidationError('The editor targeted a non-editable field.');
      const wrapper = /^(\s*<(p|h[1-6]|li|blockquote)\b[^>]*>)([\s\S]*)(<\/\2\s*>\s*)$/i;
      const beforeBlock = wrapper.exec(edit.before);
      const afterBlock = wrapper.exec(edit.after);
      if (beforeBlock && afterBlock && beforeBlock[1] === afterBlock[1] && beforeBlock[WRAPPER_CLOSE] === afterBlock[WRAPPER_CLOSE]) {
        edit.before = beforeBlock[WRAPPER_BODY]!;
        edit.after = afterBlock[WRAPPER_BODY]!;
      }
      // Models sometimes include unchanged surrounding sentences as match context.
      // Remove only identical context; never generate or infer replacement wording.
      let start = 0;
      while (start < edit.before.length && edit.before[start] === edit.after[start]) start++;
      while (start > 0 && !/\s/.test(edit.before[start - 1]!)) start--;
      let suffix = 0;
      while (suffix < edit.before.length - start && suffix < edit.after.length - start
        && edit.before[edit.before.length - suffix - 1] === edit.after[edit.after.length - suffix - 1]) suffix++;
      while (suffix > 0 && !/\s/.test(edit.before[edit.before.length - suffix]!)) suffix--;
      const narrowedBefore = edit.before.slice(start, edit.before.length - suffix);
      const savedField = revised[edit.field];
      const fieldValues: unknown[] = Array.isArray(savedField) ? savedField : [savedField];
      const matches = (passage: string): number => fieldValues.reduce<number>((count, item) =>
        count + (typeof item === 'string' ? item.split(passage).length - 1 : 0), 0);
      if (edit.before && !/<\/?(?:p|h[1-6]|li|blockquote|div|section|article|ul|ol)\b/i.test(edit.before)
        && narrowedBefore.trim() && matches(edit.before) === 1 && matches(narrowedBefore) === 1) {
        edit.after = edit.after.slice(start, edit.after.length - suffix);
        edit.before = narrowedBefore;
      }
      if (/\n/.test(edit.before) || [...sentences.segment(edit.before.replace(/<[^>]*>/g, '').trim())].length > sentenceLimit) {
        throw new ValidationError('Return only the flagged phrase or one sentence, not a paragraph or multiple sentences.');
      }
      for (const span of protectedWeeklyText(edit.before, sources)) {
        if (!edit.after.includes(span)) throw new ValidationError(`Keep the cited or quoted text unchanged: ${span}`);
      }
      const field = revised[edit.field];
      for (const value of Array.isArray(field) ? field : [field]) {
        if (typeof value !== 'string') continue;
        const start = value.indexOf(edit.before);
        if (start < 0) continue;
        const end = start + edit.before.length;
        for (const span of protectedWeeklyText(value, sources)) {
          for (let at = value.indexOf(span); at >= 0; at = value.indexOf(span, at + span.length)) {
            if (start < at + span.length && at < end
              && (start > at || end < at + span.length || !edit.after.includes(span))) {
              throw new ValidationError(`The edit overlaps protected source or quoted text: ${span}`);
            }
          }
        }
      }
      const before = edit.before.trim();
      const echoed = (Array.isArray(sources) ? sources : []).some(source => {
        if (!source || typeof source !== 'object' || before.split(/\s+/).length < MIN_ECHO_WORDS) return false;
        const entry = object(source);
        return [entry.body, entry.summary].some(text => typeof text === 'string' && text.includes(before));
      });
      if (echoed) throw new ValidationError('This exact passage reproduces supplied source text; do not rewrite it for style.');
      revised = applyEditorialEdits('blog', revised, { edits: [edit] }, fields);
      applied.push(edit);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      rejected.push({ edit: value, error: error.message });
    }
  }
  return { content: revised, rejected, applied };
}
