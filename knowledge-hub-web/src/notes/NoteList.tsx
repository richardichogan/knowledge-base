/**
 * notes/NoteList.tsx — left panel: searchable, paginated list of notes.
 * Flat and newest-first by default; grouping by project is an opt-in toggle.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { confirmDialog } from '../services/appDialogs';
import { TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { TrashCan, Close, SortAscending, GroupObjects, View, ChevronDown, ChevronRight } from '@carbon/icons-react';
import type { ThinkListItem } from './types';
import { useTaxonomy } from '../hooks/useTaxonomy';
import { useProjects } from '../hooks/useProjects';
import { readStored, writeStored, usePersistedBoolean, usePersistedChoice } from '../hooks/usePersistedState';
import { contentTypeIcon, ctxTags, identitiesFor, useIdentity } from '../identity';
import { activateNoteOnKeyDown, NOTE_SORT_OPTIONS, NOTE_BUCKET_STORAGE_KEY, noteDateBuckets, noteListDate, parseCollapsedNoteBuckets, type NoteSortKey, type NoteListQuery } from './noteListState';
import './noteList.scss';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';

const SORT_LABELS: Record<NoteSortKey, string> = {
  modified: 'Modified',
  created: 'Created',
  title: 'Title',
};

interface NoteListProps {
  notes: ThinkListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSelectPassage?: (noteId: string, passageId: string) => void;
  onDelete: (id: string) => void;
  deletingId?: string | null;
  /** Bumped by the parent to pull focus into the search box (e.g. after expanding from the rail). */
  focusSearchSignal?: number;
  onQueryChange?: (query: NoteListQuery) => void;
  total?: number;
  loading?: boolean;
  unavailable?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreError?: boolean;
  fetching?: boolean;
  onLoadMore?: () => void;
  /** Definition notes, shown in their own collapsible section below the dated list. */
  definitions?: ThinkListItem[];
  definitionsHasMore?: boolean;
  definitionsLoadingMore?: boolean;
  onLoadMoreDefinitions?: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  const time = new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${formatDate(iso)}, ${time}`;
}

export const NoteList: React.FC<NoteListProps> = ({
  notes,
  selectedId,
  onSelect,
  onSelectPassage,
  onDelete,
  deletingId = null,
  focusSearchSignal = 0,
  onQueryChange,
  total,
  loading = false,
  unavailable = false,
  hasMore = false,
  loadingMore = false,
  loadMoreError = false,
  fetching = false,
  onLoadMore,
  definitions = [],
  definitionsHasMore = false,
  definitionsLoadingMore = false,
  onLoadMoreDefinitions,
}) => {
  const [filter, setFilter] = useState('');
  const [passageFilter, setPassageFilter] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => { setPassageFilter(filter.trim()); }, 250);
    return () => { window.clearTimeout(timer); };
  }, [filter]);
  const passageQuery = useQuery({
    queryKey: ['passage-search', passageFilter],
    queryFn: async ({ signal }) => requireApiData(await api.searchNotePassages(passageFilter, signal)),
    enabled: onSelectPassage !== undefined && passageFilter.length >= 2 && passageFilter === filter.trim(),
    retry: false,
  });
  const [definitionsOpen, setDefinitionsOpen] = usePersistedBoolean('kh_notes_definitions_open', false);
  const definitionSelected = definitions.some(note => note.id === selectedId);
  useEffect(() => { if (definitionSelected) setDefinitionsOpen(true); }, [definitionSelected, setDefinitionsOpen]);
  // Matches are shown while searching without changing the remembered collapsed state.
  const definitionsExpanded = definitionsOpen || filter.trim() !== '';
  const definitionsRowsId = useId();

  const [sortKey, setSortKey] = usePersistedChoice<NoteSortKey>(
    'kh_notes_sort',
    NOTE_SORT_OPTIONS,
    'modified',
  );
  // The compact flat list groups dates; project grouping and previews remain opt-in.
  const [groupByProject, setGroupByProject] = usePersistedBoolean('kh_notes_group', false);
  const [showPreviews, setShowPreviews] = usePersistedBoolean('kh_notes_previews', false);
  const compact = !groupByProject && !showPreviews;
  const bucketed = compact && sortKey !== 'title';
  const bucketListId = useId();
  const [bucketDate, setBucketDate] = useState(() => new Date());
  const [collapsedBuckets, setCollapsedBuckets] = useState(() => parseCollapsedNoteBuckets(readStored(NOTE_BUCKET_STORAGE_KEY)));
  useEffect(() => { writeStored(NOTE_BUCKET_STORAGE_KEY, JSON.stringify(collapsedBuckets)); }, [collapsedBuckets]);
  useEffect(() => {
    if (!bucketed) return;
    let timer: number | undefined;
    const refresh = (): void => {
      const now = new Date();
      setBucketDate(now);
      window.clearTimeout(timer);
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(refresh, midnight.getTime() - now.getTime());
    };
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh(); };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bucketed]);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSearchSignal > 0) searchRef.current?.focus();
  }, [focusSearchSignal]);

  const { data: parents = [] } = useTaxonomy();
  const { data: projects = [] } = useProjects();
  const projectNameMap = new Map(projects.map((project) => [project.id, project.name]));
  const projectIdByName = new Map(
    projects.map((project) => [project.name.trim().toLocaleLowerCase(), project.id]),
  );
  useEffect(() => {
    if (onQueryChange === undefined) return;
    const timer = setTimeout(() => {
      onQueryChange({
        ...(filter.trim() !== '' && { q: filter.trim() }),
        sort: sortKey,
      });
    }, 250);
    return () => { clearTimeout(timer); };
  }, [onQueryChange, filter, sortKey]);

  // Build a flat map of tagId → tag name, and a set of all "project child" tag IDs.
  // A project child is any tag whose parent is a top-level project group tag.
  // We treat every child tag of every top-level tag as a potential project grouper,
  // preferring the first match found on the note.
  const tagNameMap = new Map<string, string>();
  const tagParentMap = new Map<string, string>();
  for (const parent of parents) {
    tagNameMap.set(parent.id, parent.name);
    for (const child of parent.children ?? []) {
      tagNameMap.set(child.id, child.name);
      tagParentMap.set(child.id, parent.name);
    }
  }

  const resolveNoteProjectId = (note: ThinkListItem): string => {
    if (note.projectId) return note.projectId;
    const projectTagId = (note.tagIds ?? []).find((id) => tagParentMap.has(id));
    const projectTagName = projectTagId ? tagNameMap.get(projectTagId) : undefined;
    if (!projectTagName) return '__none__';
    return projectIdByName.get(projectTagName.trim().toLocaleLowerCase()) ?? projectTagId ?? '__none__';
  };

  const filteredNotes = onQueryChange === undefined
    ? notes.filter((note) => note.title.toLowerCase().includes(filter.trim().toLowerCase()))
    : notes;

  // Standalone lists sort locally; paginated lists preserve the server's global order.
  const compareNotes = (a: ThinkListItem, b: ThinkListItem): number => {
    if (sortKey === 'title') return a.title.localeCompare(b.title);
    const field = sortKey === 'created' ? 'createdAt' : 'updatedAt';
    const aTime = new Date(a[field] ?? a.updatedAt).getTime();
    const bTime = new Date(b[field] ?? b.updatedAt).getTime();
    return bTime - aTime;
  };

  const sortedNotes = onQueryChange === undefined ? [...filteredNotes].sort(compareNotes) : filteredNotes;
  const dateBuckets = bucketed ? noteDateBuckets(sortedNotes, sortKey, bucketDate) : [];
  const selectedBucket = dateBuckets.find(bucket => bucket.notes.some(note => note.id === selectedId))?.key;
  useEffect(() => {
    if (selectedBucket) setCollapsedBuckets(current => current.includes(selectedBucket)
      ? current.filter(key => key !== selectedBucket) : current);
  }, [selectedId, selectedBucket]);

  const renderNote = (note: ThinkListItem): React.ReactElement => (
    <NoteCard key={note.id} note={note} selectedId={selectedId} onSelect={onSelect} onDelete={onDelete}
      deleting={deletingId === note.id} deletePending={deletingId !== null} showPreview={showPreviews} sortKey={sortKey} compact={compact} />
  );

  // Group by the explicit project first, falling back to older taxonomy-only
  // notes that predate first-class project assignment.
  const groups = new Map<string, { label: string; notes: ThinkListItem[] }>();
  for (const note of sortedNotes) {
    const noteTagIds = note.tagIds ?? [];
    const projectTagId = noteTagIds.find((id) => tagParentMap.has(id));
    const projectTagName = projectTagId ? tagNameMap.get(projectTagId) : undefined;
    // Legacy notes predate notes.project_id and were filed only with a
    // taxonomy child such as "Imagine". Resolve a matching tag name to the
    // canonical project id so legacy and first-class project notes share one
    // menu block instead of rendering duplicate labels with different keys.
    const key = resolveNoteProjectId(note);
    if (!groups.has(key)) {
      const label = projectNameMap.get(key)
        ?? projectTagName
        ?? 'General';
      groups.set(key, { label, notes: [] });
    }
    groups.get(key)!.notes.push(note);
  }
  // Sort: named groups alphabetical, General last
  const sortedGroups = [...groups.entries()].sort(([aKey, a], [bKey, b]) => {
    if (aKey === '__none__') return 1;
    if (bKey === '__none__') return -1;
    return a.label.localeCompare(b.label);
  });

  return (
    <>
      <div className="notes-list-search notes-list-tools">
        <div className="notes-list-search__field">
          <TextInput
            id="notes-search"
            ref={searchRef}
            labelText="Search"
            hideLabel
            placeholder="Search…"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); }}
            size="sm"
          />
          {filter !== '' && (
            <button
              type="button"
              className="notes-list-search__clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => { setFilter(''); searchRef.current?.focus(); }}
            >
              <Close size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <label className="notes-list-tools__sort notes-list-tools__icon" title={`Sort notes: ${SORT_LABELS[sortKey]}`}>
          <SortAscending size={16} aria-hidden="true" />
          <select
            className="notes-list-tools__select"
            aria-label={`Sort notes: ${SORT_LABELS[sortKey]}`}
            value={sortKey}
            onChange={(event) => { setSortKey(event.target.value as NoteSortKey); }}
          >
            {NOTE_SORT_OPTIONS.map((option) => (
              <option key={option} value={option}>{SORT_LABELS[option]}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="notes-list-tools__icon"
          title="Group by project"
          aria-label="Group by project"
          aria-pressed={groupByProject}
          onClick={() => { setGroupByProject((on) => !on); }}
        >
          <GroupObjects size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="notes-list-tools__icon"
          title="Show note previews"
          aria-label="Show note previews"
          aria-pressed={showPreviews}
          onClick={() => { setShowPreviews((on) => !on); }}
        >
          <View size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="notes-list">
        {passageFilter.length >= 2 && passageFilter === filter.trim() && <>
          {passageQuery.isFetching && <p className="notes-list-progress" role="status">Searching tagged passages…</p>}
          {passageQuery.isError && <p className="notes-passage-search__error" role="alert">
            Tagged passages unavailable: {describeApiError(passageQuery.error)}{' '}
            <button type="button" onClick={() => { void passageQuery.refetch(); }}>Retry</button>
          </p>}
          {(passageQuery.data?.items.length ?? 0) > 0 && <section className="notes-passage-search" aria-label="Tagged passages">
            <p className="notes-group__label">Tagged passages</p>
            {passageQuery.data?.items.map(passage => <button key={`${passage.noteId}:${passage.kind}:${passage.id}`}
              type="button" className="notes-passage-search__item"
              onClick={() => { onSelectPassage?.(passage.noteId, passage.id); }}>
              <span>{passage.text}</span><small>{passage.label} · {passage.noteTitle}</small>
            </button>)}
            {passageQuery.data?.hasMore && <p className="notes-list-progress">More results available; refine your search.</p>}
          </section>}
        </>}
        {loading && <p className="notes-list-progress" role="status">Loading notes...</p>}
        {!loading && !unavailable && sortedNotes.length === 0 && definitions.length === 0
          && (passageQuery.data?.items.length ?? 0) === 0 && (
          <div className="notes-list-empty">No documents found</div>
        )}
        {groupByProject
          ? sortedGroups.map(([key, group]) => (
              <div key={key} className="notes-group">
                <p className="notes-group__label">{group.label}</p>
                {group.notes.map(renderNote)}
              </div>
            ))
          : bucketed ? dateBuckets.map(bucket => {
            const collapsed = collapsedBuckets.includes(bucket.key);
            const Chevron = collapsed ? ChevronRight : ChevronDown;
            const rowsId = `${bucketListId}-${bucket.key}`;
            return <div key={bucket.key} className="notes-date-bucket">
              <button type="button" className="notes-date-bucket__header" aria-expanded={!collapsed} aria-controls={rowsId}
                onClick={() => setCollapsedBuckets(current => current.includes(bucket.key)
                  ? current.filter(key => key !== bucket.key) : [...current, bucket.key])}>
                <span>{bucket.label}</span>
                <span className="notes-date-bucket__count">{bucket.notes.length}</span>
                <Chevron size={16} aria-hidden="true" />
              </button>
              <div id={rowsId} hidden={collapsed}>{!collapsed && bucket.notes.map(renderNote)}</div>
            </div>;
          }) : sortedNotes.map(renderNote)}
        {definitions.length > 0 && (
          <div className="notes-date-bucket">
            <button type="button" className="notes-date-bucket__header" aria-expanded={definitionsExpanded}
              aria-controls={definitionsRowsId} onClick={() => { setDefinitionsOpen(!definitionsExpanded); }}>
              <span>Definitions</span>
              <span className="notes-date-bucket__count">{definitions.length}{definitionsHasMore ? '+' : ''}</span>
              {definitionsExpanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>
            <div id={definitionsRowsId} hidden={!definitionsExpanded}>
              {definitionsExpanded && definitions.map(renderNote)}
              {definitionsExpanded && definitionsHasMore && onLoadMoreDefinitions !== undefined && (
                <button type="button" className="notes-list-pagination__more" disabled={definitionsLoadingMore}
                  onClick={onLoadMoreDefinitions}>
                  {definitionsLoadingMore ? 'Loading…' : 'Load more definitions'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="notes-list-pagination">
        <span className="notes-list-pagination__count" role="status">
          {loading ? 'Loading notes…' : unavailable && notes.length === 0 ? 'Notes unavailable'
            : total !== undefined ? `${sortedNotes.length} of ${total} items` : `${sortedNotes.length} items`}
        </span>
        {hasMore && onLoadMore !== undefined && (
          <button type="button" className="notes-list-pagination__more"
            disabled={loadingMore || fetching} onClick={onLoadMore}>
            {loadingMore ? 'Loading…' : loadMoreError ? 'Retry load more' : 'Load more'}
          </button>
        )}
        {loadMoreError && <p className="notes-list-pagination__error" role="alert">
          Could not load more notes. Your loaded notes are unchanged.
        </p>}
      </div>
    </>
  );
};

const NoteCard: React.FC<{
  note: ThinkListItem; selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
  deletePending: boolean;
  showPreview: boolean;
  /** Drives which timestamp the card shows, so the visible dates match the chosen order. */
  sortKey: NoteSortKey;
  compact: boolean;
}> = ({ note, selectedId, onSelect, onDelete, deleting, deletePending, showPreview, sortKey, compact }) => {
  const identity = useIdentity();
  const isActive = selectedId === note.id;
  const cardRef = useRef<HTMLDivElement>(null);

  // Notes are opened from places other than this list (search, Athena links,
  // deep links), so the list has to follow the selection rather than assume
  // the user just clicked a visible row. `nearest` keeps an already-visible
  // row where it is instead of yanking the list around on every selection.
  useEffect(() => {
    if (isActive) cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isActive]);

  const TypeIcon = contentTypeIcon(note.contentType);
  const preview = note.body ?? '';
  const snippet = preview.replace(/[#*_`>[\]\n]+/g, ' ').trim().slice(0, 120);
  // Encoded as "name|colour" so the canvas renderer can use the correct colour
  const tagEntries = ctxTags(identitiesFor(identity, note.tagIds ?? []));

  return (
    <div
      ref={cardRef}
      className={`notes-list-item${isActive ? ' notes-list-item--active' : ''}${compact ? ' notes-list-item--compact' : ''}`}
      title={compact ? `${note.title}\n${formatDateTime(noteListDate(note, sortKey))}` : undefined}
      onClick={() => { onSelect(note.id); }}
      onKeyDown={(event) => { activateNoteOnKeyDown(event, () => { onSelect(note.id); }); }}
      data-ctx-title={note.title}
      {...(snippet !== '' ? { 'data-ctx-body': snippet } : {})}
      data-ctx-type="hub_ref" data-ctx-ref-id={note.id} data-ctx-ref-type="note"
      data-ctx-source={`Note · ${note.contentType}`}
      {...(tagEntries !== undefined ? { 'data-ctx-tags': tagEntries } : {})}
      role="button" tabIndex={0}
    >
      <button
        type="button"
        className="notes-list-item__delete"
        title="Delete note"
        disabled={deleting || deletePending}
        onClick={async (e) => {
          e.stopPropagation();
          if (!await confirmDialog(`Delete "${note.title}"? This cannot be undone.`, { title: 'Delete note', confirmLabel: 'Delete', tone: 'danger' })) return;
          onDelete(note.id);
        }}
      >
        <TrashCan size={14} />
      </button>
      <div className="notes-list-item-title">{note.title}</div>
      {showPreview && (
        snippet !== '' ? (
          <p className="notes-list-item-preview">{snippet}</p>
        ) : (
          <p className="notes-list-item-preview notes-list-item-preview--empty">No content</p>
        )
      )}
      <div className="notes-list-item-bottom">
        {!compact && <span className="notes-list-item-date">{formatDate(noteListDate(note, sortKey))}</span>}
        <span className={`notes-type-tag kh-type-mark kh-content-type--${note.contentType}`}>
          <TypeIcon size={12} aria-hidden="true" />
          {note.contentType.replace(/-/g, ' ')}
        </span>
      </div>
    </div>
  );
};
