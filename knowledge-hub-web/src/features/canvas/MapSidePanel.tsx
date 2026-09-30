/**
 * features/canvas/MapSidePanel.tsx — the Suggestions and Details tabs of the
 * mind map's side panel (Athena is the third tab, in MindMapEditor).
 */
import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Add, Renew, Launch, DocumentAdd, TrashCan } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { CanvasFullApi, CanvasNodeApi, MapSuggestionApi } from '../../services/api';
import { childrenOf, descendantIds } from './mindMap';
import { KIND_LABEL, REF_LABEL, SUGGESTION_DRAG_TYPE, suggestionIcon, refIcon } from './mapVisuals';

// ── Suggestions ───────────────────────────────────────────────────────────────

interface SuggestionsProps {
  canvasId: string;
  node: CanvasNodeApi | undefined;
  parentLabel: string;
  /** Items already on the map (hidden from the list). */
  onMap: Set<string>;
  onAdd: (s: MapSuggestionApi) => void;
}

function formatDate(iso: string | null): string {
  if (iso === null) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const MapSuggestionsTab: React.FC<SuggestionsProps> = ({ canvasId, node, parentLabel, onMap, onAdd }) => {
  const label = node?.label ?? '';
  const body = node?.body ?? '';
  const { data, isFetching, refetch, isError } = useQuery({
    // Keyed on the idea's text, so suggestions refresh when it's renamed — not on every map edit.
    queryKey: ['map-suggestions', canvasId, node?.id ?? 'root', label, body, parentLabel],
    queryFn: async () => {
      const r = await api.getCanvasSuggestions(canvasId, {
        ...(node !== undefined && { nodeId: node.id, label, body, parentLabel }),
      });
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
    enabled: node === undefined || label.trim() !== '',
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const items = (data ?? []).filter((s) => !onMap.has(s.refId));

  return (
    <div className="mm-suggest">
      <div className="mm-suggest__head">
        <p className="mm-suggest__for">Related to <strong>{node?.label !== undefined && node.label !== null && node.label !== '' ? node.label : 'the central idea'}</strong></p>
        <button type="button" className="mm-icon-btn" title="Refresh" aria-label="Refresh suggestions" onClick={() => { void refetch(); }}>
          <Renew size={16} />
        </button>
      </div>
      <p className="mm-suggest__hint">Drag onto an idea, or + to add under the selected idea.</p>
      {isFetching && items.length === 0 && <InlineLoading description="Finding related content…" />}
      {isError && <p className="mm-suggest__empty">Couldn’t load suggestions.</p>}
      {!isFetching && !isError && items.length === 0 && (
        <p className="mm-suggest__empty">Nothing related found yet. Give the idea a more specific label, or select another idea.</p>
      )}
      <ul className="mm-suggest__list">
        {items.map((s) => {
          const Icon = suggestionIcon(s.kind);
          return (
            <li
              key={`${s.refType}:${s.refId}`}
              className="mm-suggest__item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(SUGGESTION_DRAG_TYPE, JSON.stringify(s));
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span className="mm-suggest__icon" title={KIND_LABEL[s.kind]}><Icon size={16} /></span>
              <div className="mm-suggest__body">
                <p className="mm-suggest__title">{s.title}</p>
                <p className="mm-suggest__meta">
                  {KIND_LABEL[s.kind]}{s.date !== null ? ` · ${formatDate(s.date)}` : ''}{s.via === 'graph' ? ' · knowledge graph' : ''}
                </p>
                {s.excerpt !== '' && <p className="mm-suggest__excerpt">{s.excerpt}</p>}
              </div>
              <button type="button" className="mm-icon-btn mm-suggest__add" title="Add under the selected idea" aria-label={`Add ${s.title}`} onClick={() => { onAdd(s); }}>
                <Add size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

// ── Details ───────────────────────────────────────────────────────────────────

interface DetailsProps {
  map: CanvasFullApi;
  node: CanvasNodeApi | undefined;
  onUpdate: (id: string, patch: { label?: string; body?: string }) => void;
  onDelete: (id: string) => void;
  onOpenRef: (node: CanvasNodeApi) => void;
  onBranchToNote: (nodeId: string, noteId?: string) => Promise<void>;
  onDeleteMap: () => void;
}

export const MapDetailsTab: React.FC<DetailsProps> = ({ map, node, onUpdate, onDelete, onOpenRef, onBranchToNote, onDeleteMap }) => {
  const [label, setLabel] = useState(node?.label ?? '');
  const [body, setBody] = useState(node?.body ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { setLabel(node?.label ?? ''); setBody(node?.body ?? ''); setDone(null); }, [node?.id, node?.label, node?.body]);

  if (node === undefined) {
    return (
      <div className="mm-details">
        <p className="mm-details__hint">Select an idea to see and edit its details.</p>
        <MapFacts map={map} />
        <button type="button" className="kb-import-btn kb-import-btn--danger" onClick={onDeleteMap}><TrashCan size={16} /> Delete canvas</button>
      </div>
    );
  }

  const isRoot = node.parentId === null;
  const branchSize = descendantIds(map.nodes, node.id).size;
  const kids = childrenOf(map.nodes, node.id).length;
  const RefIcon = node.refType !== null ? refIcon(node.refType) : null;

  async function run(key: string, fn: () => Promise<void>, doneText: string): Promise<void> {
    setBusy(key);
    try { await fn(); setDone(doneText); } finally { setBusy(null); }
  }

  return (
    <div className="mm-details">
      <label className="mm-field">
        <span className="mm-field__label">{isRoot ? 'Central idea' : 'Idea'}</span>
        <input
          className="mm-field__input"
          value={label}
          onChange={(e) => { setLabel(e.target.value); }}
          onBlur={() => { if (label !== (node.label ?? '')) onUpdate(node.id, { label }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
      <label className="mm-field">
        <span className="mm-field__label">Note</span>
        <textarea
          className="mm-field__input mm-field__textarea"
          rows={4}
          placeholder="Detail, reasoning or a reminder…"
          value={body}
          onChange={(e) => { setBody(e.target.value); }}
          onBlur={() => { if (body !== (node.body ?? '')) onUpdate(node.id, { body }); }}
        />
      </label>

      {node.refType !== null && RefIcon !== null && (
        <div className="mm-details__ref">
          <RefIcon size={16} />
          <span>{REF_LABEL[node.refType]}</span>
          <button type="button" className="kb-import-btn" onClick={() => { onOpenRef(node); }}><Launch size={16} /> Open</button>
        </div>
      )}

      <p className="mm-details__meta">
        {kids === 0 ? 'No sub-ideas' : `${kids.toString()} sub-idea${kids === 1 ? '' : 's'}`}
        {branchSize > kids ? ` · ${branchSize.toString()} in this branch` : ''}
      </p>

      <div className="mm-details__actions">
        <p className="mm-field__label">Turn this {isRoot ? 'canvas' : 'branch'} into a note</p>
        <button
          type="button"
          className="kb-import-btn"
          disabled={busy !== null}
          onClick={() => { void run('new', () => onBranchToNote(node.id), 'New note created and linked to this canvas.'); }}
        >
          <DocumentAdd size={16} /> {busy === 'new' ? 'Creating…' : 'New note'}
        </button>
        {map.linkedNotes.map((n) => (
          <button
            key={n.id}
            type="button"
            className="kb-import-btn"
            disabled={busy !== null}
            onClick={() => { void run(n.id, () => onBranchToNote(node.id, n.id), `Added to “${n.title}”.`); }}
          >
            <Add size={16} /> {busy === n.id ? 'Adding…' : `Add to “${n.title}”`}
          </button>
        ))}
        {done !== null && <p className="mm-details__done">{done}</p>}
      </div>

      {!isRoot && (
        <button type="button" className="kb-import-btn kb-import-btn--danger" onClick={() => { onDelete(node.id); }}>
          <TrashCan size={16} /> Delete {branchSize > 0 ? 'branch' : 'idea'}
        </button>
      )}
    </div>
  );
};

const MapFacts: React.FC<{ map: CanvasFullApi }> = ({ map }) => (
  <dl className="mm-details__facts">
    <dt>Ideas</dt><dd>{map.nodes.length}</dd>
    <dt>Cross-links</dt><dd>{map.edges.length}</dd>
    <dt>Linked notes</dt><dd>{map.linkedNotes.length === 0 ? 'None' : map.linkedNotes.map((n) => n.title).join(', ')}</dd>
    <dt>Updated</dt><dd>{new Date(map.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd>
  </dl>
);
