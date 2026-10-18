import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NoteList } from '../src/notes/NoteList';
import { fetchNotesPage } from '../src/notes/noteStorage';
import { activateNoteOnKeyDown, loadedNotes, nextNotesPage, noteListQuery } from '../src/notes/noteListState';
import type { NoteListItem } from '../src/notes/types';
import { api } from '../src/services/api';
import type { NoteSummary } from '../src/types/contentItem';

const note = (index: number): NoteListItem => ({
  id: `note-${index}`, title: `Note ${index}`, contentType: 'note',
  updatedAt: '2026-10-18T08:00:00.000Z', createdAt: '2026-10-17T08:00:00.000Z',
  body: `Body ${index}`, projectId: 'project-one',
});
const summary = (index: number): NoteSummary => ({
  ...note(index), createdAt: '2026-10-17T08:00:00.000Z', preview: `Body ${index}`, taxonomyTagIds: [],
});

test('Think query ignores old filter restrictions but keeps search and sort', () => {
  const restored = {
    q: '  research  ', sort: 'title' as const, projectId: 'hidden-project',
    contentType: 'transcript', tagIds: 'hidden-tag', projectTagIds: 'legacy-tag',
    status: 'archived',
  };
  assert.deepEqual(noteListQuery(restored), { q: 'research', sort: 'title' });
  assert.deepEqual(noteListQuery({ q: '  ' }), { sort: 'modified' });
});

test('100 of 111 uses the real summary pages, retains loaded rows on failure and retries', async () => {
  const original = api.getNoteSummaries;
  const calls: { page: number | undefined; query: unknown }[] = [];
  let failSecondPage = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.getNoteSummaries = async (page, pageSize, query) => {
    calls.push({ page, query });
    assert.equal(pageSize, 100);
    if (page === 2 && failSecondPage) {
      return { success: false, error: { code: 'FIXTURE', message: 'Page unavailable' } };
    }
    const start = page === 1 ? 0 : 100;
    return { success: true, data: {
      items: Array.from({ length: page === 1 ? 100 : 11 }, (_, index) => summary(start + index)),
      total: 111, page: page!, pageSize: 100, hasMore: page === 1,
    } };
  };
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ['notes-list', { sort: 'modified' }],
    queryFn: ({ pageParam }) => fetchNotesPage(pageParam, {
      sort: 'modified', ...{ projectId: 'old-persisted-filter', tagIds: 'hidden' },
    }),
    initialPageParam: 1,
    getNextPageParam: nextNotesPage,
  });
  try {
    const first = await observer.refetch();
    assert.equal(loadedNotes(first.data!.pages).length, 100);
    assert.equal(observer.getCurrentResult().hasNextPage, true);
    const failed = await observer.fetchNextPage();
    assert.equal(failed.isFetchNextPageError, true);
    assert.deepEqual(loadedNotes(failed.data!.pages), loadedNotes(first.data!.pages));
    assert.equal(failed.isFetchingNextPage, false);
    assert.equal(failed.hasNextPage, true);
    failSecondPage = false;
    const complete = await observer.fetchNextPage();
    const rows = loadedNotes(complete.data!.pages);
    assert.equal(rows.length, 111);
    assert.equal(rows[110]?.id, 'note-110');
    assert.equal(complete.hasNextPage, false);
    assert.deepEqual(calls.map((call) => call.page), [1, 2, 2]);
    assert.ok(calls.every((call) => JSON.stringify(call.query) === '{"sort":"modified"}'));
    const overlap = loadedNotes([
      complete.data!.pages[0]!,
      { ...complete.data!.pages[1]!, items: [note(99), ...complete.data!.pages[1]!.items] },
    ]);
    assert.equal(overlap.length, 111, 'overlapping refresh pages must not duplicate cards');
  } finally {
    api.getNoteSummaries = original;
    observer.destroy();
    client.clear();
  }
});

test('note-row Enter and Space activate once; nested delete keys retain native behavior without selection', () => {
  const row = new EventTarget();
  const deleteButton = new EventTarget();
  for (const key of ['Enter', ' ']) {
    let selected = 0;
    let prevented = 0;
    const event = { key, target: row, currentTarget: row, preventDefault: () => { prevented++; } };
    activateNoteOnKeyDown(event, () => { selected++; });
    assert.equal(selected, 1, `${JSON.stringify(key)} activates the focused note row`);
    assert.equal(prevented, 1, 'Space must not scroll; Enter must not trigger a second default action');
    activateNoteOnKeyDown({ ...event, target: deleteButton }, () => { selected++; });
    assert.equal(selected, 1, 'a key from delete must not open the note, even before confirmation');
    assert.equal(prevented, 1, 'the nested native button must keep its own keyboard click behavior');
  }
  let selected = false;
  activateNoteOnKeyDown({ key: 'ArrowDown', target: row, currentTarget: row, preventDefault: () => assert.fail() },
    () => { selected = true; });
  assert.equal(selected, false);
});

function renderList(
  props: Partial<React.ComponentProps<typeof NoteList>> = {},
  preferences: Record<string, string> = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['taxonomy'], []);
  client.setQueryData(['projects'], [{ id: 'project-one', name: 'Project One' }]);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: { getItem: (key: string) => preferences[key] ?? null } },
  });
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>
      <NoteList notes={[note(0)]} selectedId="note-0" onSelect={() => undefined} onDelete={() => undefined}
        onQueryChange={() => undefined} {...props} />
    </QueryClientProvider>);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    client.clear();
  }
}

test('compact header exposes native sort and labelled icon toggles without filters', () => {
  const html = renderList();
  const header = html.slice(0, html.indexOf('<div class="notes-list">'));
  assert.match(header, /id="notes-search"/);
  assert.match(header, /<select[^>]+aria-label="Sort notes: Modified"/);
  assert.match(header, /value="modified" selected=""/);
  assert.match(header, /aria-label="Group by project" aria-pressed="false"/);
  assert.match(header, /aria-label="Show note previews" aria-pressed="false"/);
  assert.doesNotMatch(header, /notes-list-filters|notes-list-arrange|>Group<|>Previews</);
  assert.doesNotMatch(html, /notes-list-item-preview/);
  assert.match(html, /notes-list-item--active/);
});

test('persisted sort, project grouping and previews keep their existing behavior', () => {
  const html = renderList({}, { kh_notes_sort: 'title', kh_notes_group: 'true', kh_notes_previews: 'true' });
  assert.match(html, /aria-label="Sort notes: Title"/);
  assert.match(html, /value="title" selected=""/);
  assert.match(html, /aria-label="Group by project" aria-pressed="true"/);
  assert.match(html, /aria-label="Show note previews" aria-pressed="true"/);
  assert.match(html, /notes-group__label">Project One/);
  assert.match(html, /notes-list-item-preview">Body 0/);
});

test('load more is outside the scrolling rows, remains retryable and keeps selection', () => {
  const notes = Array.from({ length: 100 }, (_, index) => note(index));
  const html = renderList({ notes, total: 111, hasMore: true, onLoadMore: () => undefined });
  assert.match(html, /100 of 111 notes/);
  assert.match(html, /<\/div><div class="notes-list-pagination">/);
  assert.match(html, /class="notes-list-pagination__more">Load more/);
  const retry = renderList({ notes, total: 111, hasMore: true, loadMoreError: true, onLoadMore: () => undefined });
  assert.match(retry, /Retry load more/);
  assert.match(retry, /role="alert">Could not load more notes/);
  assert.match(retry, /notes-list-item--active/);
  const busy = renderList({ hasMore: true, loadingMore: true, onLoadMore: () => undefined });
  assert.match(busy, /notes-list-pagination__more" disabled=""/);
  const complete = renderList({ notes: [...notes, ...Array.from({ length: 11 }, (_, i) => note(100 + i))], total: 111 });
  assert.match(complete, /111 of 111 notes/);
  assert.doesNotMatch(complete, /notes-list-pagination__more/);
});
