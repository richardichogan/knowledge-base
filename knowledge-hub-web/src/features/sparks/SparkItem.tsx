/**
 * features/sparks/SparkItem.tsx
 * One spark: text, where it came from, what it was used in, and curation actions
 * (edit, move to a theme / new theme / loose, map, clear used, delete).
 */
import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Diagram, OverflowMenuHorizontal, CheckmarkOutline, Draggable } from '@carbon/icons-react';
import { useGlobalContextMenu } from '../../context/GlobalContextMenu';
import { api, type Spark, type SparkCluster } from '../../services/api';
import { confirmDialog } from '../../services/appDialogs';
import { describeApiError, requireApiSuccess } from '../../services/apiError';
import { SparkMenu } from './SparkMenu';
import { OUTPUT_LABELS, formatSparkDate, openHref, sparkSourceHref } from './sparkUtils';

const LOOSE = '__loose';
const NEW_THEME = '__new';
const LONG_SPARK = 240;

export const SparkItem: React.FC<{
  spark: Spark; themes: SparkCluster[];
  drag?: { disabled: boolean; active: boolean; onStart: (event: React.DragEvent) => void; onEnd: () => void };
}> = ({ spark, themes, drag }) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openMenu } = useGlobalContextMenu();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(spark.body);
  const [moving, setMoving] = useState(false);
  const [newTheme, setNewTheme] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['sparks'] });
    void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] });
  };
  const mutation = useMutation({
    mutationFn: async (action: { kind: 'edit' | 'move' | 'new-theme' | 'clear-used' | 'delete'; value?: string | null }) => {
      if (action.kind === 'edit') requireApiSuccess(await api.updateSpark(spark.id, { body: action.value ?? '' }));
      else if (action.kind === 'move') requireApiSuccess(await api.updateSpark(spark.id, { cluster_id: action.value ?? null }));
      else if (action.kind === 'new-theme') requireApiSuccess(await api.createSparkTheme(action.value ?? '', [spark.id]));
      else if (action.kind === 'clear-used') requireApiSuccess(await api.updateSpark(spark.id, { used: null }));
      else await api.deleteSpark(spark.id);
    },
    onMutate: () => { setError(null); },
    onSuccess: () => { setEditing(false); setMoving(false); setNewTheme(null); refresh(); },
    onError: (e) => { setError(describeApiError(e)); },
  });

  const source = sparkSourceHref(spark);
  const sourceLabel = spark.sourceTitle ?? (spark.sourceType === 'discover_item' ? 'Discover article' : spark.sourceType);
  const preview = spark.body.length > 80 ? `${spark.body.slice(0, 80)}…` : spark.body;
  const otherThemes = themes.filter((t) => t.id !== spark.clusterId && t.status !== 'dismissed');

  function onMoveChange(value: string): void {
    if (value === '') return;
    if (value === NEW_THEME) { setNewTheme(''); return; }
    mutation.mutate({ kind: 'move', value: value === LOOSE ? null : value });
  }

  return (
    <div className={`spark-item${spark.usedAt ? ' spark-item--used' : ''}${drag?.active ? ' spark-item--dragging' : ''}`}
      data-ctx-title={preview} data-ctx-body={spark.body} data-ctx-type="hub_ref"
      data-ctx-ref-id={spark.id} data-ctx-ref-type="spark" data-ctx-source={spark.sourceType ? `Spark · ${spark.sourceType}` : 'Spark'}>
      {editing ? (
        <div className="spark-item__edit">
          <textarea className="spark-item__textarea" value={draft} rows={3} autoFocus aria-label="Spark text"
            onChange={(e) => { setDraft(e.target.value); }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && draft.trim()) mutation.mutate({ kind: 'edit', value: draft.trim() });
              if (e.key === 'Escape') { setEditing(false); setDraft(spark.body); }
            }} />
          <div className="spark-item__edit-actions">
            <button type="button" className="spark-btn spark-btn--primary" disabled={!draft.trim() || mutation.isPending}
              onClick={() => { mutation.mutate({ kind: 'edit', value: draft.trim() }); }}>Save</button>
            <button type="button" className="spark-btn" onClick={() => { setEditing(false); setDraft(spark.body); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="spark-item__text">
          <p className={`spark-item__body${!full && spark.body.length > LONG_SPARK ? ' spark-item__body--clamped' : ''}`}>{spark.body}</p>
          {spark.body.length > LONG_SPARK && (
            <button type="button" className="spark-item__more" aria-expanded={full} onClick={() => { setFull((v) => !v); }}>
              {full ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      <div className="spark-item__meta">
        <span className="spark-item__date">{formatSparkDate(spark.createdAt)}</span>
        {sourceLabel && (source !== null
          ? <button type="button" className="spark-item__link" onClick={() => { openHref(source, (to) => { void navigate(to); }); }}>From: {sourceLabel}</button>
          : <span className="spark-item__date">From: {sourceLabel}</span>)}
        {spark.usedAt && spark.usedType && (
          <span className="spark-item__used" title={`Used in ${OUTPUT_LABELS[spark.usedType]}: ${spark.usedTitle ?? ''}`}>
            <CheckmarkOutline size={12} /> Used in {OUTPUT_LABELS[spark.usedType].toLowerCase()}
          </span>
        )}
      </div>

      {moving && (
        <div className="spark-item__move">
          {newTheme === null ? (
            <>
              <label className="spark-item__move-label" htmlFor={`move-${spark.id}`}>Move to</label>
              <select id={`move-${spark.id}`} className="spark-select" defaultValue="" disabled={mutation.isPending}
                onChange={(e) => { onMoveChange(e.target.value); }}>
                <option value="" disabled>Choose a theme…</option>
                {otherThemes.map((t) => <option key={t.id} value={t.id}>{t.theme}</option>)}
                <option value={NEW_THEME}>New theme…</option>
                {spark.clusterId !== null && <option value={LOOSE}>Loose (no theme)</option>}
              </select>
            </>
          ) : (
            <input className="spark-input" placeholder="New theme name" value={newTheme} autoFocus aria-label="New theme name"
              onChange={(e) => { setNewTheme(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && newTheme.trim()) mutation.mutate({ kind: 'new-theme', value: newTheme.trim() }); }} />
          )}
          {newTheme !== null && (
            <button type="button" className="spark-btn spark-btn--primary" disabled={!newTheme.trim() || mutation.isPending}
              onClick={() => { mutation.mutate({ kind: 'new-theme', value: newTheme.trim() }); }}>Create</button>
          )}
          <button type="button" className="spark-btn" onClick={() => { setMoving(false); setNewTheme(null); }}>Cancel</button>
        </div>
      )}
      {error && <p className="spark-item__error" role="alert">{error}</p>}

      <div className="spark-item__actions">
        {drag && !editing && (
          <button type="button" className="spark-icon-btn spark-item__drag" draggable={!drag.disabled && !mutation.isPending}
            disabled={drag.disabled || mutation.isPending} aria-label="Drag spark to a theme, or click to choose"
            title="Drag into a theme, or click to choose" onDragStart={drag.onStart} onDragEnd={drag.onEnd}
            onClick={() => { setMoving(true); }}>
            <Draggable size={16} />
          </button>
        )}
        <button type="button" className="spark-icon-btn" title="Add to a canvas or connect" aria-label="Map spark"
          onClick={(event) => { openMenu(event, { title: preview, body: spark.body, source: 'Spark', refId: spark.id, refType: 'spark', nodeType: 'hub_ref' }); }}>
          <Diagram size={16} />
        </button>
        <SparkMenu ariaLabel="Spark actions" buttonClassName="spark-icon-btn" label={<OverflowMenuHorizontal size={16} />} items={[
          { label: 'Edit', onSelect: () => { setDraft(spark.body); setEditing(true); } },
          { label: spark.clusterId === null ? 'Add to theme…' : 'Move to…', onSelect: () => { setMoving(true); } },
          ...(spark.usedAt ? [{ label: 'Mark as not used', onSelect: () => { mutation.mutate({ kind: 'clear-used' }); } }] : []),
          { label: 'Delete', danger: true, onSelect: () => {
            void confirmDialog('Delete this spark? This cannot be undone.', { title: 'Delete spark', confirmLabel: 'Delete' })
              .then((ok) => { if (ok) mutation.mutate({ kind: 'delete' }); });
          } },
        ]} />
      </div>
    </div>
  );
};
