/**
 * notes/NoteList.tsx â€” left panel: searchable, filterable list of notes.
 * Flat and newest-first by default; grouping by project is an opt-in toggle.
 */

import React, { useEffect, useRef, useState } from 'react';
import { confirmDialog } from '../services/appDialogs';
import { TextInput } from '@carbon/react';
import { ChevronDown, TrashCan, Add, DocumentImport, Close } from '@carbon/icons-react';
import type { NoteListItem } from './types';
import { useTaxonomy, expandTagIds } from '../hooks/useTaxonomy';
import { useProjects } from '../hooks/useProjects';
import { usePersistedBoolean, usePersistedChoice } from '../hooks/usePersistedState';
import { CONTENT_TYPE_OPTIONS } from './constants';
import type { ContentType } from './constants';

const SORT_OPTIONS = ['modified', 'created', 'title'] as const;
type SortKey = (typeof SORT_OPTIONS)[number];

const SORT_LABELS: Record<SortKey, string> = {
  modified: 'Modified',
  created: 'Created',
  title: 'Title',
};

interface NoteListProps {
  notes: NoteListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onImport: () => void;
  deletingId?: string | null;
  /** Bumped by the parent to pull focus into the search box (e.g. after expanding from the rail). */
  focusSearchSignal?: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const TYPE_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  project:      { color: '#3ddbd9', bg: 'rgba(61,219,217,0.1)',  border: 'rgba(61,219,217,0.2)' },
  blog:         { color: '#f1c21b', bg: 'rgba(241,194,27,0.1)',  border: 'rgba(241,194,27,0.2)' },
  note:         { color: '#a8a8a8', bg: 'rgba(168,168,168,0.1)', border: 'rgba(168,168,168,0.2)' },
  podcast:      { color: '#be84ff', bg: 'rgba(190,132,255,0.1)', border: 'rgba(190,132,255,0.2)' },
  'podcast-show-notes': { color: '#8a3ffc', bg: 'rgba(138,63,252,0.1)', border: 'rgba(138,63,252,0.2)' },
  newsletter:   { color: '#be84ff', bg: 'rgba(190,132,255,0.1)', border: 'rgba(190,132,255,0.2)' },
  script:       { color: '#ff8389', bg: 'rgba(255,131,137,0.1)', border: 'rgba(255,131,137,0.2)' },
  architecture: { color: '#4589ff', bg: 'rgba(69,137,255,0.1)',  border: 'rgba(69,137,255,0.2)' },
  meeting:      { color: '#ff832b', bg: 'rgba(255,131,43,0.1)',  border: 'rgba(255,131,43,0.2)' },
  research:     { color: '#1192e8', bg: 'rgba(17,146,232,0.1)',  border: 'rgba(17,146,232,0.2)' },
  spec:         { color: '#ee5396', bg: 'rgba(238,83,150,0.1)',  border: 'rgba(238,83,150,0.2)' },
  'use-case':   { color: '#08bdba', bg: 'rgba(8,189,186,0.1)',   border: 'rgba(8,189,186,0.2)' },
};

export const NoteList: React.FC<NoteListProps> = ({
  notes,
  selectedId,
  onSelect,
  onDelete,
  onCreate,
  onImport,
  deletingId = null,
  focusSearchSignal = 0,
}) => {
  const [filter, setFilter] = useState('');
  const [activeProjectId, setActiveProjectId] = useState('');
  const [activeContentType, setActiveContentType] = useState<ContentType | ''>('');
  const [activeTagId, setActiveTagId] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const [sortKey, setSortKey] = usePersistedChoice<SortKey>(
    'kh_notes_sort',
    SORT_OPTIONS,
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

  // Build a flat map of tagId â†’ tag name, and a set of all "project child" tag IDs.
  // A project child is any tag whose parent is a top-level project group tag.
  // We treat every child tag of every top-level tag as a potential project grouper,
  // preferring the first match found on the note.
  const tagNameMap = new Map<string, string>();
  const tagColourMap = new Map<string, string>(); // tagId â†’ colour
  const tagParentMap = new Map<string, string>(); // childId â†’ parentName
  for (const parent of parents) {
    tagNameMap.set(parent.id, parent.name);
    if (parent.colour) tagColourMap.set(parent.id, parent.colour);
    for (const child of parent.children ?? []) {
      tagNameMap.set(child.id, child.name);
      if (child.colour) tagColourMap.set(child.id, child.colour);
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

  const activeFilterCount = [
    activeProjectId !== '',
    activeContentType !== '',
    activeTagId !== '',
  ].filter(Boolean).length;

  const availableProjectIds = new Set(notes.map(resolveNoteProjectId));
  const availableProjectOptions = [...availableProjectIds]
    .map((id) => ({
      id,
      label: id === '__none__'
        ? 'General / unassigned'
        : (projectNameMap.get(id) ?? tagNameMap.get(id) ?? id),
    }))
    .sort((a, b) => {
      if (a.id === '__none__') return 1;
      if (b.id === '__none__') return -1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
  const availableContentTypes = CONTENT_TYPE_OPTIONS.filter((option) =>
    notes.some((note) => note.contentType === option.id),
  );
  const flatTags = parents.flatMap((parent) => [
    { ...parent, depth: 0 },
    ...(parent.children ?? []).map((child) => ({ ...child, depth: 1 })),
  ]);

  const filteredNotes = notes.filter((n) => {
    if (!n.title.toLowerCase().includes(filter.toLowerCase())) return false;
    if (activeProjectId !== '' && resolveNoteProjectId(n) !== activeProjectId) return false;
    if (activeContentType !== '' && n.contentType !== activeContentType) return false;
    if (activeTagId !== '') {
      const matchIds = expandTagIds(activeTagId, parents);
      if (!(n.tagIds ?? []).some((id) => matchIds.has(id))) return false;
    }
    return true;
  });

  // Sorting is applied before grouping so both the flat list and the grouped
  // list obey the same chosen order. The API orders by created_at, which is
  // not a proxy for "most recently edited", so order is always re-derived
  // client-side rather than trusted.
  const compareNotes = (a: NoteListItem, b: NoteListItem): number => {
    if (sortKey === 'title') return a.title.localeCompare(b.title);
    const field = sortKey === 'created' ? 'createdAt' : 'updatedAt';
    const aTime = new Date(a[field] ?? a.updatedAt).getTime();
    const bTime = new Date(b[field] ?? b.updatedAt).getTime();
    return bTime - aTime;
  };

  const sortedNotes = [...filteredNotes].sort(compareNotes);

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
      <div className="notes-list-search">
        <div className="notes-list-search__field">
        <TextInput
          id="notes-search"
          ref={searchRef}
          labelText="Search"
          hideLabel
          placeholder="Searchâ€¦"
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
        <button
          type="button"
          className="notes-list-search__action"
          title="New note"
          aria-label="New note"
          onClick={onCreate}
        >
          <Add size={16} />
        </button>
        <div className="notes-list-search__overflow">
          <button
            type="button"
            className="notes-list-search__action"
            title="More actions"
            aria-label="More actions"
            aria-expanded={overflowOpen}
            aria-haspopup="menu"
            onClick={() => { setOverflowOpen((open) => !open); }}
          >
            <ChevronDown size={16} />
          </button>
          {overflowOpen && (
            <>
              {/* Click-away layer: a menu that only closes on re-click of its
                  own trigger strands itself open the moment focus moves. */}
              <div
                className="notes-list-menu__scrim"
                role="presentation"
                onClick={() => { setOverflowOpen(false); }}
              />
              <div className="notes-list-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="notes-list-menu__item"
                  onClick={() => { setOverflowOpen(false); onImport(); }}
                >
                  <DocumentImport size={16} />
                  <span>Importâ€¦</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="notes-list-arrange">
        <label className="notes-list-arrange__sort">
          <span className="notes-list-arrange__label">Sort</span>
          <select
            className="notes-list-filter__select"
            value={sortKey}
            onChange={(event) => { setSortKey(event.target.value as SortKey); }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option} value={option}>{SORT_LABELS[option]}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`notes-list-arrange__toggle${groupByProject ? ' notes-list-arrange__toggle--on' : ''}`}
          aria-pressed={groupByProject}
          onClick={() => { setGroupByProject((on) => !on); }}
        >
          Group
        </button>
        <button
          type="button"
          className={`notes-list-arrange__toggle${showPreviews ? ' notes-list-arrange__toggle--on' : ''}`}
          aria-pressed={showPreviews}
          onClick={() => { setShowPreviews((on) => !on); }}
        >
          Previews
        </button>
      </div>

      <div className="notes-list-filters" aria-label="Filter notes">
        <div className="notes-list-filters__heading">
          <button
            type="button"
            className="notes-list-filters__toggle"
            aria-expanded={filtersExpanded}
            aria-controls="notes-list-filter-fields"
            onClick={() => { setFiltersExpanded((expanded) => !expanded); }}
          >
            <ChevronDown
              size={16}
              className={`notes-list-filters__chevron${filtersExpanded ? ' notes-list-filters__chevron--expanded' : ''}`}
            />
            <span>Filters{activeFilterCount > 0 ? ` Â· ${activeFilterCount} active` : ''}</span>
            <span className="notes-list-filters__result-count">
              {filteredNotes.length} of {notes.length}
            </span>
          </button>
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="notes-list-filters__clear"
              onClick={() => {
                setActiveProjectId('');
                setActiveContentType('');
                setActiveTagId('');
              }}
            >
              Clear
            </button>
          )}
        </div>
        <div
          id="notes-list-filter-fields"
          className="notes-list-filters__fields"
          hidden={!filtersExpanded}
        >
          <label className="notes-list-filter">
            <span className="notes-list-filter__label">Project</span>
            <select
              className="notes-list-filter__select"
              value={activeProjectId}
              onChange={(event) => { setActiveProjectId(event.target.value); }}
            >
              <option value="">All projects</option>
              {availableProjectOptions.map((project) => (
                <option key={project.id} value={project.id}>{project.label}</option>
              ))}
            </select>
          </label>
          <label className="notes-list-filter">
            <span className="notes-list-filter__label">Content type</span>
            <select
              className="notes-list-filter__select"
              value={activeContentType}
              onChange={(event) => { setActiveContentType(event.target.value as ContentType | ''); }}
            >
              <option value="">All types</option>
              {availableContentTypes.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="notes-list-filter notes-list-filter--wide">
            <span className="notes-list-filter__label">Tag</span>
            <select
              className="notes-list-filter__select"
              value={activeTagId}
              onChange={(event) => { setActiveTagId(event.target.value); }}
            >
              <option value="">All tags</option>
              {flatTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.depth === 1 ? `â€” ${tag.name}` : tag.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Notes grouped by project */}
      <div className="notes-list">
        {sortedNotes.length === 0 && (
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
                    showPreview={showPreviews}
                    sortKey={sortKey}
                    tagNameMap={tagNameMap}
                    tagColourMap={tagColourMap}
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
                showPreview={showPreviews}
                sortKey={sortKey}
                tagNameMap={tagNameMap}
                tagColourMap={tagColourMap}
              />
            ))}
      </div>
    </>
  );
};

const NoteCard: React.FC<{
  note: NoteListItem; selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
  showPreview: boolean;
  /** Drives which timestamp the card shows, so the visible dates match the chosen order. */
  sortKey: SortKey;
  tagNameMap: Map<string, string>;
  tagColourMap: Map<string, string>;
}> = ({ note, selectedId, onSelect, onDelete, deleting, showPreview, sortKey, tagNameMap, tagColourMap }) => {
  const isActive = selectedId === note.id;
  const cardRef = useRef<HTMLDivElement>(null);

  // Notes are opened from places other than this list (search, Athena links,
  // deep links), so the list has to follow the selection rather than assume
  // the user just clicked a visible row. `nearest` keeps an already-visible
  // row where it is instead of yanking the list around on every selection.
  useEffect(() => {
    if (isActive) cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isActive]);

  const st = TYPE_STYLE[note.contentType] ?? TYPE_STYLE['note'] ?? { color: '#a8a8a8', bg: 'rgba(168,168,168,0.1)', border: 'rgba(168,168,168,0.2)' };
  const preview = note.body ?? '';
  const snippet = preview.replace(/[#*_`>\[\]\n]+/g, ' ').trim().slice(0, 120);
  // Encode as "name|colour" so the canvas renderer can use the correct colour
  const tagEntries = (note.tagIds ?? [])
    .map((id) => {
      const name = tagNameMap.get(id);
      if (!name) return null;
      const colour = tagColourMap.get(id);
      return colour ? `${name}|${colour}` : name;
    })
    .filter((n): n is string => !!n);

  return (
    <div
      ref={cardRef}
      className={`notes-list-item${isActive ? ' notes-list-item--active' : ''}`}
      onClick={() => { onSelect(note.id); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { onSelect(note.id); } }}
      data-ctx-title={note.title}
      {...(snippet !== '' ? { 'data-ctx-body': snippet } : {})}
      data-ctx-type="hub_ref"
      data-ctx-ref-id={note.id}
      data-ctx-ref-type="note"
      data-ctx-source={`Note Â· ${note.contentType}`}
      {...(tagEntries.length > 0 ? { 'data-ctx-tags': tagEntries.join(',') } : {})}
      role="button" tabIndex={0}
    >
      <button
        className="notes-list-item__delete"
        title="Delete note"
        disabled={deleting}
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
        <span
          className="notes-type-tag"
          ref={(el) => {
            if (el) {
              el.style.color = st.color;
              el.style.background = st.bg;
              el.style.borderColor = st.border;
            }
          }}
        >
          {note.contentType}
        </span>
      </div>
    </div>
  );
};
