/**
 * features/canvas/CanvasSidePanel.tsx — the Preview, Suggestions and Details
 * tabs beside a canvas (Athena is the fourth tab, in CanvasEditor).
 */
import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Add, Renew, Launch, DocumentAdd, TrashCan, Close, ArrowRight, ArrowLeft } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { CanvasFullApi, CanvasNodeApi, MapSuggestionApi } from '../../services/api';
import { renderMarkdown } from '../../utils/markdown';
import { LINK_TYPES, linkStyle, connectedIds } from './canvasGraph';
import { KIND_LABEL, SUGGESTION_DRAG_TYPE, suggestionIcon, cardKindLabel } from './mapVisuals';

function formatDate(iso: string | null): string {
  if (iso === null) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Preview ───────────────────────────────────────────────────────────────────

interface PreviewProps {
  canvasId: string;
  node: CanvasNodeApi | undefined;
  onOpen: (node: CanvasNodeApi) => void;
}

export const CanvasPreviewTab: React.FC<PreviewProps> = ({ canvasId, node, onOpen }) => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas-card-content', canvasId, node?.id ?? ''],
    queryFn: async () => {
      if (node === undefined) return null;
      const r = await api.getCanvasCardContent(canvasId, node.id);
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
    enabled: node !== undefined,
    staleTime: 60_000,
  });

  if (node === undefined) return <p className="cv-side__hint">Select a card to read it here.</p>;
  return (
    <div className="cv-preview">
      <div className="cv-preview__head">
        <p className="cv-preview__kind">{data?.kind ?? cardKindLabel(node)}{data?.date != null ? ` · ${formatDate(data.date)}` : ''}</p>
        <h3 className="cv-preview__title">{node.label !== null && node.label !== '' ? node.label : data?.title ?? 'Untitled'}</h3>
        {node.refType !== null && (
          <button type="button" className="kb-import-btn" onClick={() => { onOpen(node); }}><Launch size={16} /> Open</button>
        )}
      </div>
      {node.body !== null && node.body.trim() !== '' && (
        <p className="cv-preview__annotation"><span>Your note:</span> {node.body}</p>
      )}
      {isLoading && <InlineLoading description="Loading content…" />}
      {isError && <p className="cv-side__hint">Couldn’t load the content.</p>}
      {data != null && node.refType !== null && (
        data.text.trim() === ''
          ? <p className="cv-side__hint">No text content for this item.</p>
          : (
            <div
              className="cv-preview__body ai-bubble-text--md"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: renderMarkdown(data.text) }}
            />
          )
      )}
    </div>
  );
};

// ── Suggestions ───────────────────────────────────────────────────────────────

interface SuggestionsProps {
  canvasId: string;
  node: CanvasNodeApi | undefined;
  contextLabels: string;
  /** Items already on the canvas (hidden from the list). */
  onCanvas: Set<string>;
  onAdd: (s: MapSuggestionApi) => void;
}

export const CanvasSuggestionsTab: React.FC<SuggestionsProps> = ({ canvasId, node, contextLabels, onCanvas, onAdd }) => {
  const label = node?.label ?? '';
  const body = node?.body ?? '';
  const { data, isFetching, refetch, isError } = useQuery({
    // Keyed on the card's text, so suggestions refresh when it changes — not on every canvas edit.
    queryKey: ['canvas-suggestions', canvasId, node?.id ?? 'first', label, body, contextLabels],
    queryFn: async () => {
      const r = await api.getCanvasSuggestions(canvasId, node !== undefined ? { nodeId: node.id, label, body, contextLabels } : {});
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
    enabled: node === undefined || label.trim() !== '',
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const items = (data ?? []).filter((s) => !onCanvas.has(s.refId));

  return (
    <div className="mm-suggest">
      <div className="mm-suggest__head">
        <p className="mm-suggest__for">Related to <strong>{label !== '' ? label : 'this canvas'}</strong></p>
        <button type="button" className="mm-icon-btn" title="Refresh" aria-label="Refresh suggestions" onClick={() => { void refetch(); }}>
          <Renew size={16} />
        </button>
      </div>
      <p className="mm-suggest__hint">Drag onto the canvas (onto a card to connect to it), or + to add it connected to the selected card.</p>
      {isFetching && items.length === 0 && <InlineLoading description="Finding related content…" />}
      {isError && <p className="mm-suggest__empty">Couldn’t load suggestions.</p>}
      {!isFetching && !isError && items.length === 0 && (
        <p className="mm-suggest__empty">Nothing related found. Select another card, or give an idea card a more specific title.</p>
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
              <button type="button" className="mm-icon-btn mm-suggest__add" title="Add, connected to the selected card" aria-label={`Add ${s.title}`} onClick={() => { onAdd(s); }}>
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
  onSelect: (id: string) => void;
  onRetype: (edgeId: string, type: string) => void;
  onUnlink: (edgeId: string) => void;
  onOpen: (node: CanvasNodeApi) => void;
  onToNote: (nodeId: string, noteId?: string) => Promise<void>;
  onDeleteCanvas: () => void;
}

const PRESET_TYPES = Object.keys(LINK_TYPES);

export const CanvasDetailsTab: React.FC<DetailsProps> = ({ map, node, onUpdate, onDelete, onSelect, onRetype, onUnlink, onOpen, onToNote, onDeleteCanvas }) => {
  const [label, setLabel] = useState(node?.label ?? '');
  const [body, setBody] = useState(node?.body ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { setLabel(node?.label ?? ''); setBody(node?.body ?? ''); setDone(null); }, [node?.id, node?.label, node?.body]);

  if (node === undefined) {
    return (
      <div className="mm-details">
        <p className="mm-details__hint">Select a card to see and edit its details and connections.</p>
        <dl className="mm-details__facts">
          <dt>Cards</dt><dd>{map.nodes.length}</dd>
          <dt>Connections</dt><dd>{map.edges.length}</dd>
          <dt>Pinned to</dt><dd>{map.linkedNotes.length === 0 ? 'No notes yet' : map.linkedNotes.map((n) => n.title).join(', ')}</dd>
          <dt>Updated</dt><dd>{new Date(map.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd>
        </dl>
        <button type="button" className="kb-import-btn kb-import-btn--danger" onClick={onDeleteCanvas}><TrashCan size={16} /> Delete canvas</button>
      </div>
    );
  }

  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const connections = map.edges.filter((e) => e.sourceId === node.id || e.targetId === node.id);

  async function run(key: string, fn: () => Promise<void>, doneText: string): Promise<void> {
    setBusy(key);
    try { await fn(); setDone(doneText); } finally { setBusy(null); }
  }

  return (
    <div className="mm-details">
      <label className="mm-field">
        <span className="mm-field__label">{cardKindLabel(node)} — title</span>
        <input
          className="mm-field__input"
          value={label}
          onChange={(e) => { setLabel(e.target.value); }}
          onBlur={() => { if (label.trim() !== '' && label !== (node.label ?? '')) onUpdate(node.id, { label }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
      <label className="mm-field">
        <span className="mm-field__label">Your note on this card</span>
        <textarea
          className="mm-field__input mm-field__textarea"
          rows={4}
          placeholder="Why it’s here, what it shows, questions it raises…"
          value={body}
          onChange={(e) => { setBody(e.target.value); }}
          onBlur={() => { if (body !== (node.body ?? '')) onUpdate(node.id, { body }); }}
        />
      </label>
      {node.refType !== null && (
        <button type="button" className="kb-import-btn cv-details__open" onClick={() => { onOpen(node); }}><Launch size={16} /> Open {cardKindLabel(node).toLowerCase()}</button>
      )}

      <div className="cv-details__connections">
        <p className="mm-field__label">Connections ({connections.length})</p>
        {connections.length === 0 && <p className="mm-details__hint">None yet — drag from the dot on the card’s edge to another card.</p>}
        <ul className="cv-conn-list">
          {connections.map((e) => {
            const outgoing = e.sourceId === node.id;
            const other = byId.get(outgoing ? e.targetId : e.sourceId);
            const style = linkStyle(e.type);
            return (
              <li key={e.id} className="cv-conn">
                <span className="cv-conn__dir" title={outgoing ? 'From this card' : 'To this card'}>{outgoing ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}</span>
                <input
                  className="cv-conn__type"
                  list="cv-link-types"
                  defaultValue={e.type}
                  key={`${e.id}:${e.type}`}
                  style={{ color: style.colour, borderColor: style.colour }}
                  aria-label="Connection type"
                  onBlur={(ev) => { const t = ev.target.value.trim(); if (t !== '' && t !== e.type) onRetype(e.id, t); }}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }}
                />
                <button type="button" className="cv-conn__other" onClick={() => { if (other !== undefined) onSelect(other.id); }}>
                  {other?.label ?? 'Untitled'}
                </button>
                <button type="button" className="mm-icon-btn" title="Remove connection" aria-label="Remove connection" onClick={() => { onUnlink(e.id); }}><Close size={14} /></button>
              </li>
            );
          })}
        </ul>
        <datalist id="cv-link-types">{PRESET_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
      </div>

      <div className="mm-details__actions">
        <p className="mm-field__label">Summarise this card and its connections into a note</p>
        <button type="button" className="kb-import-btn" disabled={busy !== null}
          onClick={() => { void run('new', () => onToNote(node.id), 'New note created and pinned to this canvas.'); }}>
          <DocumentAdd size={16} /> {busy === 'new' ? 'Creating…' : 'New note'}
        </button>
        {map.linkedNotes.map((n) => (
          <button key={n.id} type="button" className="kb-import-btn" disabled={busy !== null}
            onClick={() => { void run(n.id, () => onToNote(node.id, n.id), `Added to “${n.title}”.`); }}>
            <Add size={16} /> {busy === n.id ? 'Adding…' : `Add to “${n.title}”`}
          </button>
        ))}
        {done !== null && <p className="mm-details__done">{done}</p>}
      </div>

      <button type="button" className="kb-import-btn kb-import-btn--danger" onClick={() => { onDelete(node.id); }}>
        <TrashCan size={16} /> Remove card from canvas
      </button>
      <p className="mm-details__hint">{connectedIds(map.edges, node.id).length > 0 ? 'Removing a card also removes its connections. ⌘Z undoes it.' : '⌘Z undoes it.'}</p>
    </div>
  );
};
