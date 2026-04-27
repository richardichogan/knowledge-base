/**
 * notes/NoteList.tsx — left panel: note list with taxonomy tag filter chips.
 * Tags filter at top. Notes show preview snippets and colour-coded type labels.
 */

import React, { useState } from 'react';
import { TextInput } from '@carbon/react';
import type { NoteListItem } from './types';
import { useTaxonomy } from '../hooks/useTaxonomy';
import { expandTagIds } from '../hooks/useTaxonomy';
import type { TaxonomyTag } from '../services/api';

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
  const [expandedParent, setExpandedParent] = useState<string | null>(null);

  const { data: parents = [] } = useTaxonomy();

  function handleParentChip(id: string) {
    if (activeTagId === id) { setActiveTagId(null); setExpandedParent(null); return; }
    setActiveTagId(id);
    setExpandedParent(expandedParent === id ? null : id);
  }

  function handleChildChip(id: string) {
    setActiveTagId(activeTagId === id ? null : id);
  }

  const filteredNotes = notes.filter((n) => {
    const textOk = n.title.toLowerCase().includes(filter.toLowerCase());
    if (!textOk) return false;
    if (!activeTagId) return true;
    const matchIds = expandTagIds(activeTagId, parents);
    return (n.tagIds ?? []).some((id) => matchIds.has(id));
  });

  return (
    <>
      <div className="notes-list-search">
        <TextInput id="notes-search" labelText="Search" hideLabel placeholder="Search…" value={filter} onChange={(e) => { setFilter(e.target.value); }} size="sm" />
      </div>

      <div className="notes-tag-filter">
        <button className={`notes-tag-chip${activeTagId === null ? ' notes-tag-chip--active' : ''}`} onClick={() => { setActiveTagId(null); setExpandedParent(null); }}>
          All notes
        </button>
        {parents.map((parent) => (
          <React.Fragment key={parent.id}>
            <button
              className={`notes-tag-chip${activeTagId === parent.id ? ' notes-tag-chip--active' : ''}`}
              onClick={() => { handleParentChip(parent.id); }}
              ref={(el) => { if (el && parent.colour) el.style.setProperty('--chip-colour', parent.colour); }}
            >
              {parent.name}
            </button>
            {expandedParent === parent.id && (parent.children ?? []).map((child) => (
              <button
                key={child.id}
                className={`notes-tag-chip notes-tag-chip--child${activeTagId === child.id ? ' notes-tag-chip--active' : ''}`}
                onClick={() => { handleChildChip(child.id); }}
                ref={(el) => { if (el && child.colour) el.style.setProperty('--chip-colour', child.colour); }}
              >
                {child.name}
              </button>
            ))}
          </React.Fragment>
        ))}
      </div>

      <div className="notes-list">
        {filteredNotes.map((note) => (
          <NoteCard key={note.id} note={note} selectedId={selectedId} onSelect={onSelect} />
        ))}
        {filteredNotes.length === 0 && <div className="notes-list-empty">No documents found</div>}
      </div>
    </>
  );
};

const NoteCard: React.FC<{
  note: NoteListItem; selectedId: string | null;
  onSelect: (id: string) => void;
}> = ({ note, selectedId, onSelect }) => {
  const st = TYPE_STYLE[note.contentType] ?? TYPE_STYLE['note'] ?? { color: '#a8a8a8', bg: 'rgba(168,168,168,0.1)', border: 'rgba(168,168,168,0.2)' };
  // Preview text from note — use body field if available, else empty
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
