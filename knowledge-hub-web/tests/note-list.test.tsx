import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NoteList } from '../src/notes/NoteList';
import { fetchNotesPage } from '../src/notes/noteStorage';
import { activateNoteOnKeyDown, loadedNotes, nextNotesPage, noteListQuery, noteDateBuckets, noteListDate, parseCollapsedNoteBuckets, NOTE_BUCKET_STORAGE_KEY } from '../src/notes/noteListState';
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
    assert.ok(calls.every((call) => JSON.stringify(call.query) === '{"sort":"modified","structure":"flat"}'));
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
  assert.match(html, /100 of 111 items/);
  assert.match(html, /<\/div><div class="notes-list-pagination">/);
  assert.match(html, /class="notes-list-pagination__more">Load more/);
  const retry = renderList({ notes, total: 111, hasMore: true, loadMoreError: true, onLoadMore: () => undefined });
  assert.match(retry, /Retry load more/);
  assert.match(retry, /role="alert">Could not load more notes/);
  assert.match(retry, /notes-list-item--active/);
  const busy = renderList({ hasMore: true, loadingMore: true, onLoadMore: () => undefined });
  assert.match(busy, /notes-list-pagination__more" disabled=""/);
  const complete = renderList({ notes: [...notes, ...Array.from({ length: 11 }, (_, i) => note(100 + i))], total: 111 });
  assert.match(complete, /111 of 111 items/);
  assert.doesNotMatch(complete, /notes-list-pagination__more/);
});

test('date buckets use local calendar boundaries, Monday weeks and first-match precedence', () => {
  const rows = ['2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25', '2026-10-19', '2026-10-18', '2026-09-30', '2025-12-31']
    .map((date, index) => ({ ...note(index), updatedAt: new Date(`${date}T12:00:00`).toISOString() }));
  const buckets = noteDateBuckets(rows, 'modified', new Date('2026-10-28T12:00:00'));
  assert.deepEqual(buckets.map(bucket => [bucket.label, bucket.notes.length]), [
    ['Today', 1], ['Yesterday', 1], ['This week', 1], ['Last week', 2], ['October', 1], ['September', 1], ['December 2025', 1],
  ]);
  for (const day of [26, 27]) {
    const matching = rows.filter(row => new Date(row.updatedAt) < new Date(2026, 9, day + 1));
    const earlyWeek = noteDateBuckets(matching, 'modified', new Date(2026, 9, day, 12));
    assert.ok(!earlyWeek.some(bucket => bucket.key === 'this-week'));
    assert.equal(earlyWeek.find(bucket => bucket.key === 'yesterday')?.notes.length, 1);
  }
  const september = rows.filter(row => row.id === 'note-6');
  const nextYear = noteDateBuckets(september, 'modified', new Date(2027, 0, 20));
  assert.equal(nextYear[0]?.key, buckets[5]?.key);
  assert.equal(nextYear[0]?.label, 'September 2026');
});

test('Created buckets and tooltips use createdAt with the existing updatedAt fallback', () => {
  const row = { ...note(0), updatedAt: new Date(2026, 9, 28, 12).toISOString(), createdAt: new Date(2026, 8, 1).toISOString() };
  const now = new Date(2026, 9, 28, 12);
  assert.equal(noteDateBuckets([row], 'modified', now)[0]?.key, 'today');
  assert.equal(noteDateBuckets([row], 'created', now)[0]?.key, 'month:2026-09');
  assert.equal(noteListDate(row, 'created'), row.createdAt);
  const withoutCreated = { ...row, createdAt: undefined };
  assert.equal(noteDateBuckets([withoutCreated], 'created', now)[0]?.key, 'today');
  assert.equal(noteListDate(withoutCreated, 'created'), row.updatedAt);
});

test('midnight and DST changes use local dates rather than fixed 24-hour windows', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    for (const [month, day] of [[2, 30], [9, 26]] as const) {
      const now = new Date(2026, month, day, 0, 5);
      const rows = [
        { ...note(0), updatedAt: new Date(2026, month, day, 0, 0).toISOString() },
        { ...note(1), updatedAt: new Date(2026, month, day - 1, 0, 30).toISOString() },
      ];
      assert.deepEqual(noteDateBuckets(rows, 'modified', now).map(bucket => bucket.key), ['today', 'yesterday']);
      assert.equal(noteDateBuckets([rows[0]!], 'modified', new Date(2026, month, day + 1))[0]?.key, 'yesterday');
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('combined pages share one date header and filtered results have loaded matching counts', () => {
  const page = { total: 3, hasMore: true, page: 1, items: [note(0), note(1)] };
  const rows = loadedNotes([page, { ...page, page: 2, hasMore: false, items: [note(1), note(2)] }]);
  const buckets = noteDateBuckets(rows, 'modified', new Date(2026, 9, 28));
  assert.equal(buckets.length, 1);
  assert.deepEqual(buckets[0]?.notes.map(row => row.id), ['note-0', 'note-1', 'note-2']);
  const html = renderList({ notes: rows, total: 3 });
  assert.equal((html.match(/class="notes-date-bucket__header"/g) ?? []).length, 1);
  assert.match(html, /notes-date-bucket__count">3</);
  const results = renderList({ notes: [note(1)], total: 1, selectedId: null });
  assert.match(results, /notes-date-bucket__count">1</);
  assert.match(results, /1 of 1 items/);
  const empty = renderList({ notes: [], total: 0 });
  assert.doesNotMatch(empty, /notes-date-bucket__header/);
});

test('compact rows retain type, full local timestamp, delete and context but remove visible dates', () => {
  const dated = { ...note(0), updatedAt: new Date(2026, 9, 26, 14, 32).toISOString() };
  const html = renderList({ notes: [dated] });
  assert.match(html, /notes-list-item--compact/);
  assert.match(html, /26 Oct 2026, 14:32/);
  assert.match(html, /notes-type-tag kh-type-mark/);
  assert.match(html, /title="Delete note"/);
  assert.match(html, /data-ctx-ref-id="note-0"/);
  assert.doesNotMatch(html, /notes-list-item-date|notes-list-item-preview/);
  assert.match(html, /<button type="button" class="notes-date-bucket__header" aria-expanded="true" aria-controls=/);
  const titleSort = renderList({}, { kh_notes_sort: 'title' });
  assert.match(titleSort, /notes-list-item--compact/);
  assert.doesNotMatch(titleSort, /notes-date-bucket__header|notes-list-item-date/);
  const alternateViews: Record<string, string>[] = [{ kh_notes_group: 'true' }, { kh_notes_previews: 'true' }];
  for (const preferences of alternateViews) {
    const unchanged = renderList({}, preferences);
    assert.match(unchanged, /notes-list-item-date/);
    assert.doesNotMatch(unchanged, /notes-date-bucket|notes-list-item--compact/);
  }
});

test('saved bucket keys collapse rows without losing counts; malformed storage does not break the list', () => {
  const key = noteDateBuckets([note(0)], 'modified')[0]!.key;
  assert.deepEqual(parseCollapsedNoteBuckets(JSON.stringify([key, key])), [key]);
  assert.deepEqual(parseCollapsedNoteBuckets(null), []);
  const collapsed = renderList({ selectedId: null }, { [NOTE_BUCKET_STORAGE_KEY]: JSON.stringify([key]) });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /notes-date-bucket__count">1</);
  assert.doesNotMatch(collapsed, /data-ctx-ref-id="note-0"/);
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    for (const value of ['not json', '{}', '["today", 5]']) {
      const html = renderList({}, { [NOTE_BUCKET_STORAGE_KEY]: value });
      assert.match(html, /aria-expanded="true"/);
      assert.match(html, /data-ctx-ref-id="note-0"/);
    }
    assert.equal(warnings.length, 3);
  } finally {
    console.warn = originalWarn;
  }
});
