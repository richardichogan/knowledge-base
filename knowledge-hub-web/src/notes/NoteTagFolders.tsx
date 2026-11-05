import React, { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from '@carbon/icons-react';
import { useNoteTags, useTaxonomy } from '../hooks/useTaxonomy';
import type { TaxonomyTag } from '../services/api';
import { describeApiError } from '../services/apiError';
import { useAthenaContext } from '../context/AthenaContext';
import './noteTagFolders.scss';

export function tagFolderPath(tag: Pick<TaxonomyTag, 'name' | 'parentId'>, tree: TaxonomyTag[]): string {
  const parent = tree.find(item => item.id === tag.parentId);
  return parent ? `${parent.name} / ${tag.name}` : tag.name;
}

export const NoteTagFolders: React.FC<{
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}> = ({ selectedId, onSelect, collapsed, onToggleCollapsed }) => {
  const taxonomy = useTaxonomy();
  const tree = taxonomy.data ?? [];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selectedParentId = tree.find(parent => parent.children?.some(child => child.id === selectedId))?.id;
  useEffect(() => {
    if (selectedParentId) setExpanded(current => new Set(current).add(selectedParentId));
  }, [selectedParentId]);
  const treeId = useId();
  return (
    <nav className="notes-tag-folders" aria-label="Browse notes by tag">
      <h2 className="notes-tag-folders__heading">
        <button type="button" onClick={onToggleCollapsed} aria-expanded={!collapsed} aria-controls={`${treeId}-folders`}
          title={`${collapsed ? 'Expand' : 'Collapse'} tag section`} aria-label={`${collapsed ? 'Expand' : 'Collapse'} tag section`}>
          <span>Tag folders</span>
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
      </h2>
      <div id={`${treeId}-folders`} className="notes-tag-folders__scroll" hidden={collapsed}>
        <div className="notes-tag-folders__row notes-tag-folders__row--all">
          <span className="notes-tag-folders__spacer" aria-hidden="true" />
          <button type="button" className="notes-tag-folders__select" aria-current={selectedId === null ? 'true' : undefined}
            onClick={() => onSelect(null)}>
            <FolderOpen size={16} aria-hidden="true" /><span>All notes</span>
          </button>
        </div>
        {taxonomy.isPending && <p className="notes-tag-folders__notice" role="status">Loading tag folders...</p>}
        {taxonomy.isError && <p className="notes-tag-folders__notice notes-tag-folders__notice--error" role="alert">
          Tags unavailable: {describeApiError(taxonomy.error)}{' '}
          <button type="button" onClick={() => { void taxonomy.refetch(); }}>Retry</button>
        </p>}
        {!taxonomy.isPending && !taxonomy.isError && tree.length === 0
          && <p className="notes-tag-folders__notice">No tags yet. Add tags in a note's properties to organise it here.</p>}
        <ul className="notes-tag-folders__tree">
          {tree.map(parent => {
            const children = parent.children ?? [];
            const open = expanded.has(parent.id);
            const childrenId = `${treeId}-${parent.id}`;
            return <li key={parent.id}>
              <div className="notes-tag-folders__row">
                {children.length > 0 ? <button type="button" className="notes-tag-folders__expand"
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${parent.name}`} title={`${open ? 'Collapse' : 'Expand'} ${parent.name}`}
                  aria-expanded={open} aria-controls={childrenId}
                  onClick={() => setExpanded(current => {
                    const next = new Set(current);
                    if (open) next.delete(parent.id); else next.add(parent.id);
                    return next;
                  })}>
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button> : <span className="notes-tag-folders__spacer" />}
                <button type="button" className="notes-tag-folders__select"
                  aria-current={selectedId === parent.id ? 'true' : undefined}
                  title={`${parent.name} (includes child tags)`} onClick={() => onSelect(parent.id)}>
                  {open ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
                  <span>{parent.name}</span>
                </button>
              </div>
              {children.length > 0 && <ul id={childrenId} className="notes-tag-folders__children" hidden={!open}>
                {children.map(child => <li key={child.id}>
                  <button type="button" className="notes-tag-folders__select" title={tagFolderPath(child, tree)}
                    aria-current={selectedId === child.id ? 'true' : undefined} onClick={() => onSelect(child.id)}>
                    <Folder size={16} aria-hidden="true" /><span>{child.name}</span>
                  </button>
                </li>)}
              </ul>}
            </li>;
          })}
        </ul>
      </div>
    </nav>
  );
};

/** Publishes saved filing to Athena without rendering a second tag location in the editor. */
export function useNoteFilingContext(noteId: string): void {
  const taxonomy = useTaxonomy();
  const tags = useNoteTags(noteId);
  const error = tags.error ?? taxonomy.error;
  const { setNoteFiling } = useAthenaContext();
  useEffect(() => {
    setNoteFiling({
      noteId,
      status: error ? 'error' : tags.isPending || taxonomy.isPending ? 'loading' : 'ready',
      tags: (tags.data ?? []).map(tag => ({ id: tag.id, path: tagFolderPath(tag, taxonomy.data ?? []), parentId: tag.parentId ?? null })),
      ...(error ? { error: describeApiError(error) } : {}),
    });
    return () => setNoteFiling(null);
  }, [noteId, tags.data, taxonomy.data, tags.isPending, taxonomy.isPending, error, setNoteFiling]);
}
