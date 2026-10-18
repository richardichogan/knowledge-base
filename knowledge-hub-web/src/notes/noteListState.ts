import type { NoteListItem } from './types';

export const NOTE_SORT_OPTIONS = ['modified', 'created', 'title'] as const;
export type NoteSortKey = (typeof NOTE_SORT_OPTIONS)[number];
export interface NoteListQuery { q?: string; sort?: NoteSortKey }

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
