/**
 * notes/NoteList.tsx — left panel: searchable, paginated list of notes.
 * Flat and newest-first by default; grouping by project is an opt-in toggle.
 */

import React, { useEffect, useRef, useState } from 'react';
import { confirmDialog } from '../services/appDialogs';
import { TextInput } from '@carbon/react';
import { TrashCan, Close, SortAscending, GroupObjects, View } from '@carbon/icons-react';
import type { NoteListItem } from './types';
import { useTaxonomy } from '../hooks/useTaxonomy';
import { useProjects } from '../hooks/useProjects';
import { usePersistedBoolean, usePersistedChoice } from '../hooks/usePersistedState';
import { contentTypeIcon, ctxTags, identitiesFor, useIdentity } from '../identity';
import { activateNoteOnKeyDown, NOTE_SORT_OPTIONS, type NoteSortKey, type NoteListQuery } from './noteListState';
import './noteList.scss';

const SORT_LABELS: Record<NoteSortKey, string> = {
  modified: 'Modified',
  created: 'Created',
  title: 'Title',
};

interface NoteListProps {
  notes: NoteListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}


export const NoteList: React.FC<NoteListProps> = ({
  notes,
  selectedId,
  onSelect,
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
}) => {
  const [filter, setFilter] = useState('');

  const [sortKey, setSortKey] = usePersistedChoice<NoteSortKey>(
    'kh_notes_sort',
    NOTE_SORT_OPTIONS,
    'modified',
  );
  // Grouping and previews are both off by default: the common case is
  // "find the thing I was just working on", which a flat newest-first list
  // answers in one glance. Group headers and preview text each push roughly
  // a third of the list below the fold in exchange for context you only want
  // when browsing rather than resuming.
  const [groupByProject, setGroupByProject] = usePersistedBoolean('kh_notes_group', false);
  const [showPreviews, setShowPreviews] = usePersistedBoolean('kh_notes_previews', false);

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

  const resolveNoteProjectId = (note: NoteListItem): string => {
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
  const compareNotes = (a: NoteListItem, b: NoteListItem): number => {
    if (sortKey === 'title') return a.title.localeCompare(b.title);
    const field = sortKey === 'created' ? 'createdAt' : 'updatedAt';
    const aTime = new Date(a[field] ?? a.updatedAt).getTime();
    const bTime = new Date(b[field] ?? b.updatedAt).getTime();
    return bTime - aTime;
  };

  const sortedNotes = onQueryChange === undefined ? [...filteredNotes].sort(compareNotes) : filteredNotes;

  // Group by the explicit project first, falling back to older taxonomy-only
  // notes that predate first-class project assignment.
  const groups = new Map<string, { label: string; notes: NoteListItem[] }>();
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

      {/* Notes grouped by project */}
      <div className="notes-list">
        {loading && <p className="notes-list-progress" role="status">Loading notes...</p>}
        {!loading && !unavailable && sortedNotes.length === 0 && (
          <div className="notes-list-empty">No documents found</div>
        )}
        {groupByProject
          ? sortedGroups.map(([key, group]) => (
              <div key={key} className="notes-group">
                <p className="notes-group__label">{group.label}</p>
                {group.notes.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    deleting={deletingId === note.id}
                    deletePending={deletingId !== null}
                    showPreview={showPreviews}
                    sortKey={sortKey}
                  />
                ))}
              </div>
            ))
          : sortedNotes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                selectedId={selectedId}
                onSelect={onSelect}
                onDelete={onDelete}
                deleting={deletingId === note.id}
                deletePending={deletingId !== null}
                showPreview={showPreviews}
                sortKey={sortKey}
              />
            ))}
      </div>
      <div className="notes-list-pagination">
        <span className="notes-list-pagination__count" role="status">
          {loading ? 'Loading notes…' : unavailable && notes.length === 0 ? 'Notes unavailable'
            : total !== undefined ? `${sortedNotes.length} of ${total} notes` : `${sortedNotes.length} notes`}
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
  note: NoteListItem; selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
  deletePending: boolean;
  showPreview: boolean;
  /** Drives which timestamp the card shows, so the visible dates match the chosen order. */
  sortKey: NoteSortKey;
}> = ({ note, selectedId, onSelect, onDelete, deleting, deletePending, showPreview, sortKey }) => {
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
      className={`notes-list-item${isActive ? ' notes-list-item--active' : ''}`}
      onClick={() => { onSelect(note.id); }}
      onKeyDown={(event) => { activateNoteOnKeyDown(event, () => { onSelect(note.id); }); }}
      data-ctx-title={note.title}
      {...(snippet !== '' ? { 'data-ctx-body': snippet } : {})}
      data-ctx-type="hub_ref"
      data-ctx-ref-id={note.id}
      data-ctx-ref-type="note"
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
        <span className="notes-list-item-date">
          {formatDate((sortKey === 'created' ? note.createdAt : note.updatedAt) ?? note.updatedAt)}
        </span>
        <span className="notes-type-tag kh-type-mark">
          <TypeIcon size={12} aria-hidden="true" />
          {note.contentType.replace(/-/g, ' ')}
        </span>
      </div>
    </div>
  );
};
