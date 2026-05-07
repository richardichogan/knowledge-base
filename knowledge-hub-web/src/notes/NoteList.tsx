/**
 * notes/NoteList.tsx — left panel: notes grouped by project.
 * Project is the primary navigation. Tags are a secondary collapsible filter.
 */

import React, { useState } from 'react';
import { TextInput } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { NoteListItem } from './types';
import { useTaxonomy, expandTagIds } from '../hooks/useTaxonomy';
import type { TaxonomyTag } from '../services/api';
import { api } from '../services/api';

interface NoteListProps {
  notes: NoteListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const TYPE_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  project:    { color: '#3ddbd9', bg: 'rgba(61,219,217,0.1)',  border: 'rgba(61,219,217,0.2)' },
  blog:       { color: '#f1c21b', bg: 'rgba(241,194,27,0.1)',  border: 'rgba(241,194,27,0.2)' },
  note:       { color: '#a8a8a8', bg: 'rgba(168,168,168,0.1)', border: 'rgba(168,168,168,0.2)' },
  podcast:    { color: '#be84ff', bg: 'rgba(190,132,255,0.1)', border: 'rgba(190,132,255,0.2)' },
  newsletter: { color: '#be84ff', bg: 'rgba(190,132,255,0.1)', border: 'rgba(190,132,255,0.2)' },
};

export const NoteList: React.FC<NoteListProps> = ({ notes, selectedId, onSelect }) => {
  const [filter,         setFilter]         = useState('');
  const [activeTagId,    setActiveTagId]    = useState<string | null>(null);
  const [tagFilterOpen,  setTagFilterOpen]  = useState(false);

  const { data: parents = [] } = useTaxonomy();
  const { data: projectsRes } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.getProjects(),
    staleTime: 5 * 60_000,
  });
  const projects: Array<{ id: string; name: string }> =
    projectsRes?.success === true ? projectsRes.data : [];

  const filteredNotes = notes.filter((n) => {
    const textOk = n.title.toLowerCase().includes(filter.toLowerCase());
    if (!textOk) return false;
    if (!activeTagId) return true;
    const matchIds = expandTagIds(activeTagId, parents);
    return (n.tagIds ?? []).some((id) => matchIds.has(id));
  });

  // Group by project — notes without a project go under "General"
  const groups = new Map<string, { label: string; notes: NoteListItem[] }>();
  for (const note of filteredNotes) {
    const key = note.projectId ?? '__none__';
    if (!groups.has(key)) {
      const proj = projects.find((p) => p.id === note.projectId);
      groups.set(key, { label: proj?.name ?? 'General', notes: [] });
    }
    groups.get(key)!.notes.push(note);
  }
  // Sort: named projects first (alphabetical), then General
  const sortedGroups = [...groups.entries()].sort(([aKey, a], [bKey, b]) => {
    if (aKey === '__none__') return 1;
    if (bKey === '__none__') return -1;
    return a.label.localeCompare(b.label);
  });

  return (
    <>
      <div className="notes-list-search">
        <TextInput id="notes-search" labelText="Search" hideLabel placeholder="Search…" value={filter} onChange={(e) => { setFilter(e.target.value); }} size="sm" />
      </div>

      {/* Tag filter — collapsible, secondary */}
      {parents.length > 0 && (
        <div className="notes-tag-filter">
          <button
            className="notes-tag-filter__toggle"
            onClick={() => { setTagFilterOpen((v) => !v); }}
          >
            Filter by tag {activeTagId !== null && '(1 active)'}
            <span className={`notes-tag-filter__arrow${tagFilterOpen ? ' notes-tag-filter__arrow--open' : ''}`}>▾</span>
          </button>
          {tagFilterOpen && (
            <div className="notes-tag-filter__chips">
              <button
                className={`notes-tag-chip${activeTagId === null ? ' notes-tag-chip--active' : ''}`}
                onClick={() => { setActiveTagId(null); }}
              >
                All
              </button>
              {parents.map((parent) => (
                <React.Fragment key={parent.id}>
                  <button
                    className={`notes-tag-chip${activeTagId === parent.id ? ' notes-tag-chip--active' : ''}`}
                    onClick={() => { setActiveTagId(activeTagId === parent.id ? null : parent.id); }}
                    ref={(el) => { if (el && parent.colour) el.style.setProperty('--chip-colour', parent.colour); }}
                  >
                    {parent.name}
                  </button>
                  {activeTagId === parent.id && (parent.children ?? []).map((child) => (
                    <button
                      key={child.id}
                      className={`notes-tag-chip notes-tag-chip--child${activeTagId === child.id ? ' notes-tag-chip--active' : ''}`}
                      onClick={() => { setActiveTagId(child.id); }}
                      ref={(el) => { if (el && child.colour) el.style.setProperty('--chip-colour', child.colour); }}
                    >
                      {child.name}
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Notes grouped by project */}
      <div className="notes-list">
        {sortedGroups.length === 0 && (
          <div className="notes-list-empty">No documents found</div>
        )}
        {sortedGroups.map(([key, group]) => (
          <div key={key} className="notes-group">
            <p className="notes-group__label">{group.label}</p>
            {group.notes.map((note) => (
              <NoteCard key={note.id} note={note} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
};

const NoteCard: React.FC<{
  note: NoteListItem; selectedId: string | null;
  onSelect: (id: string) => void;
}> = ({ note, selectedId, onSelect }) => {
  const st = TYPE_STYLE[note.contentType] ?? TYPE_STYLE['note'] ?? { color: '#a8a8a8', bg: 'rgba(168,168,168,0.1)', border: 'rgba(168,168,168,0.2)' };
  const preview = (note as NoteListItem & { body?: string }).body ?? '';
  const snippet = preview.replace(/[#*_`>\[\]\n]+/g, ' ').trim().slice(0, 120);

  return (
    <div
      className={`notes-list-item${selectedId === note.id ? ' notes-list-item--active' : ''}`}
      onClick={() => { onSelect(note.id); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { onSelect(note.id); } }}
      role="button" tabIndex={0}
    >
      <div className="notes-list-item-title">{note.title}</div>
      {snippet !== '' && (
        <p className="notes-list-item-preview">{snippet}</p>
      )}
      <div className="notes-list-item-bottom">
        <span className="notes-list-item-date">{formatDate(note.updatedAt)}</span>
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
