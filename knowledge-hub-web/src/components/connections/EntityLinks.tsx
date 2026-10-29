import React, { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as LinkIcon } from '@carbon/icons-react';
import { AppDialog } from '../AppDialog';
import { api } from '../../services/api';
import type { Relationship, RelationshipScope, RelationshipType } from '../../types/entityRelationships';

const LABELS: Record<string, string> = { note: 'Note', diagram: 'Diagram', task: 'Task', chat: 'Athena chat', document: 'Document' };
const TYPES = ['note', 'diagram', 'task'] as const;
type Candidate = Pick<Relationship, 'type' | 'id' | 'title' | 'href'>;
const relationshipKey = (source: RelationshipScope): string[] => ['entity-relationships', source.type, source.id, source.elementId ?? ''];

export function useEntityRelationships(source: RelationshipScope): ReturnType<typeof useQuery<Relationship[]>> {
  return useQuery({
    queryKey: relationshipKey(source),
    queryFn: async () => {
      const response = await api.getRelationships(source);
      if (!response.success) throw new Error(response.error.message);
      return response.data;
    },
    staleTime: 0,
  });
}

export const EntityLinks: React.FC<{
  source: RelationshipScope;
  title?: string;
  beforeChange?: () => Promise<boolean>;
  onOpenNote?: ((id: string) => void) | undefined;
}> = ({ source, title = 'Linked items', beforeChange, onOpenNote }) => {
  const client = useQueryClient();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filter, setFilter] = useState<RelationshipType | 'document' | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = relationshipKey(source);
  const links = useEntityRelationships(source);
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedQuery(query.trim()); }, 200);
    return () => { clearTimeout(timer); };
  }, [query]);
  const search = useQuery({
    queryKey: ['relationship-search', debouncedQuery, filter],
    enabled: open,
    queryFn: async ({ signal }): Promise<Candidate[]> => {
      if (filter === 'document') {
        if (!debouncedQuery) return [];
        const response = await api.search({ q: debouncedQuery, pageSize: 24 }, signal);
        if (!response.success) throw new Error(response.error.message);
        return response.data.items.filter(item => item.source !== 'note' && item.source !== 'task')
          .map(item => ({ type: 'document', id: item.id, title: item.title, href: item.url ?? '' }));
      }
      const results = await Promise.all((filter ? [filter] : TYPES).map(async type => {
        const response = await api.getLinkTargets(debouncedQuery, type, undefined, undefined, signal);
        if (!response.success) throw new Error(response.error.message);
        return response.data;
      }));
      return results.flat();
    },
    staleTime: 0,
  });
  async function show(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      if (beforeChange && !await beforeChange()) throw new Error('Save the diagram before managing links.');
      setQuery('');
      setFilter('');
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open links.');
    } finally { setBusy(false); }
  }
  async function change(target: Candidate | Relationship, remove: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (beforeChange && !await beforeChange()) throw new Error('Save the diagram before changing links.');
      if (!remove && source.type === 'task' && target.type === 'document') {
        const response = await api.addTaskLink(source.id, { targetType: target.type, targetId: target.id, targetTitle: target.title, targetUrl: target.href });
        if (!response.success) throw new Error(response.error.message);
      } else {
        const response = remove && 'key' in target
          ? await api.removeRelationship(source, target.key)
          : await api.addRelationship(source, { type: target.type, id: target.id });
        if (!response.success) throw new Error(response.error.message);
        client.setQueryData(key, response.data);
      }
      await Promise.all(['entity-relationships', 'task-links', 'canvas', 'canvases', 'connections', 'graph', 'note-maps']
        .map(prefix => client.invalidateQueries({ queryKey: [prefix] })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update link.');
    } finally { setBusy(false); }
  }
  const rows = links.data ?? [];
  function linked(target: Candidate): boolean {
    return rows.some(row => row.type === target.type && row.id === target.id && !row.elementId);
  }
  const candidates = (search.data ?? []).filter(target => !(target.type === source.type && target.id === source.id));
  const waitingForSearch = query.trim() !== debouncedQuery || search.isFetching;
  const renderLinks = (editable: boolean): React.ReactNode => <ul className="entity-links__list" aria-label="Linked items">
    {rows.map(row => <li className="entity-links__row" key={row.key}>
      <div className="entity-links__item">
        {row.href ? <a href={row.href} aria-disabled={busy} onClick={e => {
          if (busy) { e.preventDefault(); return; }
          if (row.type === 'note' && onOpenNote) {
            e.preventDefault();
            if (open) setOpen(false);
            onOpenNote(row.id);
          }
        }}>{row.title}</a> : <span>{row.title}</span>}
        <span className="entity-links__type">{LABELS[row.type] ?? row.type}{row.elementId ? ` · Shape: ${row.elementTitle}` : ''}</span>
      </div>
      {editable && <button type="button" className="entity-links__button" disabled={busy}
        aria-label={`Unlink ${row.title}`} onClick={() => { void change(row, true); }}>Unlink</button>}
    </li>)}
  </ul>;
  const loadState = <>
    {links.isPending && <p role="status">Loading links...</p>}
    {links.isError && <p role="alert" className="entity-links__error">Could not load links: {links.error.message}{' '}
      <button type="button" className="entity-links__button" onClick={() => { void links.refetch(); }}>Retry</button></p>}
    {links.isSuccess && rows.length === 0 && <p className="entity-links__empty">No linked items yet.</p>}
  </>;
  return <section className="entity-links" aria-label={title} aria-busy={busy}>
    <h3 className="entity-links__heading">{title}</h3>
    {loadState}
    {renderLinks(false)}
    <button type="button" className="entity-links__button entity-links__button--manage" disabled={busy} onClick={() => { void show(); }}>
      <LinkIcon size={16} /> Manage links
    </button>
    {error && !open && <p role="alert" className="entity-links__error">{error}</p>}
    {open && <AppDialog title="Manage links" wide onClose={() => { if (!busy) setOpen(false); }}
      actions={<button type="button" className="kh-dialog__button kh-dialog__button--primary" disabled={busy} onClick={() => { setOpen(false); }}>Done</button>}>
      <div className="entity-links entity-links--modal">
        <p className="entity-links__context">{source.elementId ? 'Links for the selected diagram element.' : `Links for this ${LABELS[source.type]?.toLowerCase()}.`} Note, diagram and task links are visible from both items. Changes save immediately.</p>
        <h3 className="entity-links__heading">Linked items</h3>
        {loadState}
        {renderLinks(true)}
        {error && <p role="alert" className="entity-links__error">{error}</p>}
        <h3 className="entity-links__heading">Add a link</h3>
        <div className="entity-links__search">
          <label htmlFor={`${fieldId}-search`}>Search by title
            <input id={`${fieldId}-search`} data-dialog-autofocus value={query} maxLength={200}
              onChange={event => { setQuery(event.target.value); }} placeholder="Find a note, diagram or task" />
          </label>
          <label htmlFor={`${fieldId}-type`}>Type
            <select id={`${fieldId}-type`} value={filter} onChange={event => {
              const value = event.target.value;
              if (value === '' || value === 'note' || value === 'diagram' || value === 'task' || value === 'document') setFilter(value);
            }}>
              <option value="">All types</option>
              {TYPES.map(type => <option key={type} value={type}>{LABELS[type]}s</option>)}
              {source.type === 'task' && <option value="document">Documents</option>}
            </select>
          </label>
        </div>
        {waitingForSearch && <p role="status">Searching...</p>}
        {search.isError && <p role="alert" className="entity-links__error">Could not search: {search.error.message}{' '}
          <button type="button" className="entity-links__button" onClick={() => { void search.refetch(); }}>Retry</button></p>}
        {!waitingForSearch && search.isSuccess && candidates.length === 0 && <p>{filter === 'document' && !debouncedQuery ? 'Enter a title to find documents.' : 'No matching items.'}</p>}
        {!waitingForSearch && !search.isError && <ul className="entity-links__list entity-links__results">
          {candidates.map(target => <li key={`${target.type}:${target.id}`} className="entity-links__row">
            <div className="entity-links__item"><span>{target.title}</span><span className="entity-links__type">{LABELS[target.type]}</span></div>
            <button type="button" className="entity-links__button" disabled={busy || !links.isSuccess || linked(target)}
              aria-label={`${linked(target) ? 'Already linked' : 'Link'} ${target.title}`} onClick={() => { void change(target, false); }}>{linked(target) ? 'Linked' : 'Link'}</button>
          </li>)}
        </ul>}
      </div>
    </AppDialog>}
  </section>;
};
