/**
 * notes/NoteList.tsx — left panel: grouped tree view.
 *
 * Layout:
 *   - Search box at top
 *   - Collapsible section per parent taxonomy tag  (e.g. "IBM", "Azure")
 *     - Child sub-sections if the parent has children and notes within them
 *   - "Uncategorised" section for notes with no tag
 *
 * When the search box is non-empty the tree collapses and a flat filtered
 * list is shown instead, matching the old behaviour.
 */

import React, { useMemo, useState } from 'react';
import { TextInput } from '@carbon/react';
import { ChevronDown, ChevronRight } from '@carbon/icons-react';
import type { NoteListItem } from './types';
import { useTaxonomy, expandTagIds } from '../hooks/useTaxonomy';
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

// ── helpers ──────────────────────────────────────────────────────────────────

/** All tag IDs that belong to a parent (including itself and all its children). */
function parentTagIds(parent: TaxonomyTag): Set<string> {
  const ids = new Set<string>([parent.id]);
  for (const child of parent.children ?? []) ids.add(child.id);
  return ids;
}

// ── sub-components ────────────────────────────────────────────────────────────

const NoteCard: React.FC<{
  note: NoteListItem;
  selectedId: string | null;
  onSelect: (id: string) => void;
  indent?: boolean;
}> = ({ note, selectedId, onSelect, indent = false }) => {
  const st = TYPE_STYLE[note.contentType] ?? TYPE_STYLE['note']!;
  const preview = (note as NoteListItem & { body?: string }).body ?? '';
  const snippet = preview.replace(/[#*_`>\[\]\n]+/g, ' ').trim().slice(0, 100);

  return (
    <div
      className={`notes-list-item${selectedId === note.id ? ' notes-list-item--active' : ''}${indent ? ' notes-list-item--indented' : ''}`}
      onClick={() => { onSelect(note.id); }}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(note.id); }}
      role="button"
      tabIndex={0}
    >
      <div className="notes-list-item-title">{note.title}</div>
      {snippet !== '' && <p className="notes-list-item-preview">{snippet}</p>}
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

/** A collapsible section with a coloured header. */
const NoteSection: React.FC<{
  label: string;
  colour?: string | null;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ label, colour, count, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="notes-section">
      <button
        className="notes-section-header"
        onClick={() => { setOpen((o) => !o); }}
        aria-expanded={open}
        ref={(el) => { if (el && colour) el.style.setProperty('--section-colour', colour); }}
      >
        <span className="notes-section-chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {colour && <span className="notes-section-dot" />}
        <span className="notes-section-label">{label}</span>
        <span className="notes-section-count">{count}</span>
      </button>
      {open && <div className="notes-section-body">{children}</div>}
    </div>
  );
};

/** A collapsible child sub-section (indented, smaller header). */
const NoteSubSection: React.FC<{
  label: string;
  colour?: string | null;
  count: number;
  children: React.ReactNode;
}> = ({ label, colour, count, children }) => {
  const [open, setOpen] = useState(true);

  return (
    <div className="notes-subsection">
      <button
        className="notes-subsection-header"
        onClick={() => { setOpen((o) => !o); }}
        aria-expanded={open}
        ref={(el) => { if (el && colour) el.style.setProperty('--section-colour', colour); }}
      >
        <span className="notes-section-chevron">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        {colour && <span className="notes-section-dot notes-section-dot--sm" />}
        <span className="notes-subsection-label">{label}</span>
        <span className="notes-section-count">{count}</span>
      </button>
      {open && <div className="notes-subsection-body">{children}</div>}
    </div>
  );
};

// ── main component ────────────────────────────────────────────────────────────

export const NoteList: React.FC<NoteListProps> = ({ notes, selectedId, onSelect }) => {
  const [filter, setFilter] = useState('');
  const { data: parents = [] } = useTaxonomy();

  // ── grouped structure (only used when not searching) ─────────────────────
  const grouped = useMemo(() => {
    // Build a map: noteId → set of all its tag IDs
    const noteTagMap = new Map<string, Set<string>>();
    for (const n of notes) {
      noteTagMap.set(n.id, new Set(n.tagIds ?? []));
    }

    // For each parent tag, collect the notes that belong to it (or its children).
    // A note can appear under multiple parent sections.
    const sections: Array<{
      parent: TaxonomyTag;
      allNotes: NoteListItem[];
      byChild: Array<{ child: TaxonomyTag; notes: NoteListItem[] }>;
      uncategorisedUnderParent: NoteListItem[];
    }> = [];

    const claimedIds = new Set<string>();

    for (const parent of parents) {
      const childIds = new Set((parent.children ?? []).map((c) => c.id));
      const allParentTagIds = parentTagIds(parent);

      const parentNotes = notes.filter((n) =>
        (noteTagMap.get(n.id) ?? new Set()).has(parent.id) ||
        [...(noteTagMap.get(n.id) ?? new Set())].some((id) => allParentTagIds.has(id)),
      );

      if (parentNotes.length === 0) continue;

      // Sub-group by child tag
      const byChild: Array<{ child: TaxonomyTag; notes: NoteListItem[] }> = [];
      for (const child of parent.children ?? []) {
        const childNotes = parentNotes.filter((n) =>
          (noteTagMap.get(n.id) ?? new Set()).has(child.id),
        );
        if (childNotes.length > 0) byChild.push({ child, notes: childNotes });
      }

      // Notes tagged with the parent itself (not just a child)
      const uncategorisedUnderParent = parentNotes.filter(
        (n) => !(noteTagMap.get(n.id) ?? new Set()).has(parent.id)
          ? false
          : true,
      ).filter((n) => {
        const tags = noteTagMap.get(n.id) ?? new Set();
        // Show directly under parent only if NOT also assigned a child tag
        return ![...(tags)].some((id) => childIds.has(id));
      });

      parentNotes.forEach((n) => claimedIds.add(n.id));
      sections.push({ parent, allNotes: parentNotes, byChild, uncategorisedUnderParent });
    }

    const uncategorised = notes.filter((n) => !claimedIds.has(n.id));
    return { sections, uncategorised };
  }, [notes, parents]);

  // ── search mode: flat filtered list ──────────────────────────────────────
  const isSearching = filter.trim() !== '';
  const searchResults = isSearching
    ? notes.filter((n) => n.title.toLowerCase().includes(filter.toLowerCase()))
    : [];

  return (
    <>
      <div className="notes-list-search">
        <TextInput
          id="notes-search"
          labelText="Search"
          hideLabel
          placeholder="Search notes…"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); }}
          size="sm"
        />
      </div>

      <div className="notes-list">
        {isSearching ? (
          <>
            {searchResults.map((note) => (
              <NoteCard key={note.id} note={note} selectedId={selectedId} onSelect={onSelect} />
            ))}
            {searchResults.length === 0 && (
              <div className="notes-list-empty">No notes match "{filter}"</div>
            )}
          </>
        ) : (
          <>
            {grouped.sections.map(({ parent, allNotes, byChild, uncategorisedUnderParent }) => (
              <NoteSection
                key={parent.id}
                label={parent.name}
                colour={parent.colour}
                count={allNotes.length}
              >
                {/* Notes with only the parent tag (no child) */}
                {uncategorisedUnderParent.map((note) => (
                  <NoteCard key={note.id} note={note} selectedId={selectedId} onSelect={onSelect} />
                ))}

                {/* Child sub-sections */}
                {byChild.map(({ child, notes: childNotes }) => (
                  <NoteSubSection
                    key={child.id}
                    label={child.name}
                    colour={child.colour ?? parent.colour}
                    count={childNotes.length}
                  >
                    {childNotes.map((note) => (
                      <NoteCard key={note.id} note={note} selectedId={selectedId} onSelect={onSelect} indent />
                    ))}
                  </NoteSubSection>
                ))}
              </NoteSection>
            ))}

            {grouped.uncategorised.length > 0 && (
              <NoteSection
                label="Uncategorised"
                colour={null}
                count={grouped.uncategorised.length}
                defaultOpen={grouped.sections.length === 0}
              >
                {grouped.uncategorised.map((note) => (
                  <NoteCard key={note.id} note={note} selectedId={selectedId} onSelect={onSelect} />
                ))}
              </NoteSection>
            )}

            {notes.length === 0 && (
              <div className="notes-list-empty">No notes yet</div>
            )}
          </>
        )}
      </div>
    </>
  );
};
