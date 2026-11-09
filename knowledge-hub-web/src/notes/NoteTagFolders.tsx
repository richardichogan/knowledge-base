import React, { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from '@carbon/icons-react';
import { useNoteTags, useTaxonomy } from '../hooks/useTaxonomy';
import type { TaxonomyTag } from '../services/api';
import { describeApiError } from '../services/apiError';
import { useAthenaContext } from '../context/AthenaContext';
import { CONTENT_TYPE_GROUPS, CONTENT_TYPE_OPTIONS, type ContentType } from './constants';
import { contentTypeIcon } from '../identity';
import './noteTagFolders.scss';

export function tagFolderPath(tag: Pick<TaxonomyTag, 'name' | 'parentId'>, tree: TaxonomyTag[]): string {
  const parent = tree.find(item => item.id === tag.parentId);
  return parent ? `${parent.name} / ${tag.name}` : tag.name;
}

/**
 * Combined Think list filter: content types and tag folders in one collapsible
 * section. Both selections apply to the list together (type AND tag).
 */
export const NoteFilters: React.FC<{
  selectedTagId: string | null;
  onSelectTag: (id: string | null) => void;
  selectedContentType: ContentType | null;
  onSelectContentType: (id: ContentType | null) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}> = ({ selectedTagId, onSelectTag, selectedContentType, onSelectContentType, collapsed, onToggleCollapsed }) => {
  const taxonomy = useTaxonomy();
  const tree = taxonomy.data ?? [];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openTypeGroups, setOpenTypeGroups] = useState<Set<string>>(new Set());
  const selectedParentId = tree.find(parent => parent.children?.some(child => child.id === selectedTagId))?.id;
  useEffect(() => {
    if (selectedParentId) setExpanded(current => new Set(current).add(selectedParentId));
  }, [selectedParentId]);
  const selectedTypeGroup = CONTENT_TYPE_GROUPS.find(group => group.options.some(option => option.id === selectedContentType))?.label;
  useEffect(() => {
    if (selectedTypeGroup) setOpenTypeGroups(current => new Set(current).add(selectedTypeGroup));
  }, [selectedTypeGroup]);
  const treeId = useId();
  const nothingSelected = selectedTagId === null && selectedContentType === null;
  const selectedTag = tree.flatMap(parent => [parent, ...(parent.children ?? [])]).find(tag => tag.id === selectedTagId);
  const activeLabels = [
    selectedContentType ? CONTENT_TYPE_OPTIONS.find(option => option.id === selectedContentType)?.label : undefined,
    selectedTag ? tagFolderPath(selectedTag, tree) : undefined,
  ].filter(Boolean);
  return (
    <nav className="notes-tag-folders notes-filters" aria-label="Filter notes by content type and tag">
      <h2 className="notes-tag-folders__heading">
        <button type="button" onClick={onToggleCollapsed} aria-expanded={!collapsed} aria-controls={`${treeId}-filters`}
          title={`${collapsed ? 'Expand' : 'Collapse'} filters`} aria-label={`${collapsed ? 'Expand' : 'Collapse'} filters`}>
          <span>Filters{collapsed && activeLabels.length > 0
            ? <span className="notes-filters__active">{activeLabels.join(' · ')}</span> : null}</span>
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
      </h2>
      <div id={`${treeId}-filters`} className="notes-tag-folders__scroll" hidden={collapsed}>
        <div className="notes-tag-folders__row notes-tag-folders__row--all">
          <span className="notes-tag-folders__spacer" aria-hidden="true" />
          <button type="button" className="notes-tag-folders__select" aria-current={nothingSelected ? 'true' : undefined}
            onClick={() => { onSelectContentType(null); onSelectTag(null); }}>
            <FolderOpen size={16} aria-hidden="true" /><span>All notes</span>
          </button>
        </div>
        <p className="notes-filters__section" id={`${treeId}-types-label`}>Content types</p>
        <ul className="notes-tag-folders__tree" aria-labelledby={`${treeId}-types-label`}>
          {CONTENT_TYPE_GROUPS.map(group => {
            const open = openTypeGroups.has(group.label);
            const childrenId = `${treeId}-type-${group.label}`;
            const toggle = (): void => setOpenTypeGroups(current => {
              const next = new Set(current);
              if (open) next.delete(group.label); else next.add(group.label);
              return next;
            });
            return <li key={group.label}>
              <div className="notes-tag-folders__row">
                <button type="button" className="notes-tag-folders__expand"
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${group.label}`} title={`${open ? 'Collapse' : 'Expand'} ${group.label}`}
                  aria-expanded={open} aria-controls={childrenId} onClick={toggle}>
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <button type="button" className="notes-tag-folders__select" title={`${group.label} content types`} onClick={toggle}>
                  {open ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
                  <span>{group.label}</span>
                </button>
              </div>
              <ul id={childrenId} className="notes-tag-folders__children" hidden={!open}>
                {group.options.map(option => {
                  const Icon = contentTypeIcon(option.id);
                  return <li key={option.id}>
                    <button type="button" className="notes-tag-folders__select" title={option.label}
                      aria-current={selectedContentType === option.id ? 'true' : undefined}
                      onClick={() => onSelectContentType(option.id)}>
                      <Icon size={16} aria-hidden="true" /><span>{option.label}</span>
                    </button>
                  </li>;
                })}
              </ul>
            </li>;
          })}
        </ul>
        <p className="notes-filters__section" id={`${treeId}-tags-label`}>Tag folders</p>
        {taxonomy.isPending && <p className="notes-tag-folders__notice" role="status">Loading tag folders...</p>}
        {taxonomy.isError && <p className="notes-tag-folders__notice notes-tag-folders__notice--error" role="alert">
          Tags unavailable: {describeApiError(taxonomy.error)}{' '}
          <button type="button" onClick={() => { void taxonomy.refetch(); }}>Retry</button>
        </p>}
        {!taxonomy.isPending && !taxonomy.isError && tree.length === 0
          && <p className="notes-tag-folders__notice">No tags yet. Add tags in a note's properties to organise it here.</p>}
        <ul className="notes-tag-folders__tree" aria-labelledby={`${treeId}-tags-label`}>
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
                  aria-current={selectedTagId === parent.id ? 'true' : undefined}
                  title={`${parent.name} (includes child tags)`} onClick={() => onSelectTag(parent.id)}>
                  {open ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
                  <span>{parent.name}</span>
                </button>
              </div>
              {children.length > 0 && <ul id={childrenId} className="notes-tag-folders__children" hidden={!open}>
                {children.map(child => <li key={child.id}>
                  <button type="button" className="notes-tag-folders__select" title={tagFolderPath(child, tree)}
                    aria-current={selectedTagId === child.id ? 'true' : undefined} onClick={() => onSelectTag(child.id)}>
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
