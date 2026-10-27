import type { NoteListItem } from './types';

export const NOTE_SORT_OPTIONS = ['modified', 'created', 'title'] as const;
export type NoteSortKey = (typeof NOTE_SORT_OPTIONS)[number];
export interface NoteListQuery { q?: string; sort?: NoteSortKey }

export const NOTE_BUCKET_STORAGE_KEY = 'kh_notes_collapsed_buckets';
export interface NoteDateBucket { key: string; label: string; notes: NoteListItem[] }
const RELATIVE_BUCKETS = ['today', 'yesterday', 'this-week', 'last-week'];
const DAYS_PER_WEEK = 7;

export function noteListDate(note: NoteListItem, sort: NoteSortKey): string {
  return (sort === 'created' ? note.createdAt : note.updatedAt) ?? note.updatedAt;
}

export function noteDateBuckets(notes: NoteListItem[], sort: NoteSortKey, now = new Date()): NoteDateBucket[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK);
  const lastMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - DAYS_PER_WEEK);
  const buckets = new Map<string, NoteDateBucket>();
  for (const note of notes) {
    const date = new Date(noteListDate(note, sort));
    let key: string;
    let label: string;
    if (date >= today && date < tomorrow) { key = 'today'; label = 'Today'; }
    else if (date >= yesterday && date < today) { key = 'yesterday'; label = 'Yesterday'; }
    else if (date >= monday && date < yesterday) { key = 'this-week'; label = 'This week'; }
    else if (date >= lastMonday && date < monday) { key = 'last-week'; label = 'Last week'; }
    else if (!Number.isFinite(date.getTime())) { key = 'undated'; label = 'Date unavailable'; }
    else {
      key = `month:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      label = date.toLocaleDateString('en-GB', { month: 'long', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
    }
    const bucket = buckets.get(key);
    if (bucket) bucket.notes.push(note);
    else buckets.set(key, { key, label, notes: [note] });
  }
  const rank = (key: string): number => {
    const relative = RELATIVE_BUCKETS.indexOf(key);
    return relative >= 0 ? relative : key === 'undated' ? RELATIVE_BUCKETS.length + 1 : RELATIVE_BUCKETS.length;
  };
  return [...buckets.values()].sort((a, b) => rank(a.key) - rank(b.key) || b.key.localeCompare(a.key));
}

export function parseCollapsedNoteBuckets(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((key): key is string => typeof key === 'string')) {
      throw new Error('Expected a list of collapsed date bucket keys.');
    }
    return [...new Set(value)];
  } catch (error) {
    console.warn('[Notes] Could not restore collapsed date buckets:', error);
    return [];
  }
}

/** Only search and sorting may restrict Think's list, including restored query state. */
export function noteListQuery(value: NoteListQuery): NoteListQuery {
  const q = value.q?.trim();
  return {
    ...(q && { q }),
    sort: value.sort !== undefined && NOTE_SORT_OPTIONS.includes(value.sort) ? value.sort : 'modified',
  };
}

export interface NoteListPage { items: NoteListItem[]; total: number; page: number; hasMore: boolean }

export function nextNotesPage(last: NoteListPage): number | undefined {
  return last.hasMore ? last.page + 1 : undefined;
}

export function loadedNotes(pages: NoteListPage[]): NoteListItem[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => page.items).filter((note) => {
    if (seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
}

export function activateNoteOnKeyDown(
  event: { key: string; target: EventTarget | null; currentTarget: EventTarget | null; preventDefault: () => void },
  activate: () => void,
): void {
  // Nested controls retain their native keyboard action without opening the note.
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  activate();
}
