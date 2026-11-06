import { randomUUID } from 'node:crypto';
import { ValidationError } from '../types/errors.js';

export interface ChecklistItem { id: string; title: string; done: boolean }

const MAX_ITEMS = 50;
const MAX_TITLE = 300;

/** Validates a submitted checklist; items without an id get one, so edits keep identity. */
export function parseChecklist(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) throw new ValidationError('Checklist must be a list', { checklist: 'invalid' });
  if (value.length > MAX_ITEMS) throw new ValidationError(`A checklist holds at most ${MAX_ITEMS.toString()} items`, { checklist: 'too-long' });
  return value.map((raw: unknown) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const title = typeof item['title'] === 'string' ? item['title'].trim() : '';
    if (title === '' || title.length > MAX_TITLE) throw new ValidationError(`Each checklist item needs a title of up to ${MAX_TITLE.toString()} characters`, { checklist: 'invalid-title' });
    const id = typeof item['id'] === 'string' && item['id'] !== '' ? item['id'].slice(0, 64) : randomUUID();
    return { id, title, done: item['done'] === true };
  });
}

export function readChecklist(value: unknown): ChecklistItem[] {
  return Array.isArray(value) ? value.filter((i): i is ChecklistItem => typeof (i as ChecklistItem | null)?.title === 'string') : [];
}
