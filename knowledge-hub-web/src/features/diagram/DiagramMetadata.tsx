import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useProjects } from '../../hooks/useProjects';
import { ProjectOptions } from '../../components/ProjectOptions';
import { api, type CanvasFullApi, type CanvasSummaryApi } from '../../services/api';
import { DiagramDescriptionEditor } from './DiagramDescriptionEditor';
import { TagPicker } from '../../components/TagPicker';
import { EntityChip } from '../../identity';
import { metadataDraft, metadataPatch, reconcileMetadata, type DiagramMetadataDraft } from './diagramMetadataState';
import { isAxiosError } from 'axios';

export function DiagramMetadata({ canvas, onSaved, onSaveReady, expanded = true, disabled = false }: {
  canvas: CanvasFullApi;
  onSaved: (summary: CanvasSummaryApi) => void;
  onSaveReady?: (save: (() => Promise<boolean>) | null) => void;
  expanded?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  const [draft, setDraft] = useState(() => metadataDraft(canvas));
  const { title, description, project, usedIn, tagIds } = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseline = useRef(metadataDraft(canvas));
  const pending = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const conflicted = useRef(false);
  const callbacks = useRef({ onSaved });
  callbacks.current = { onSaved };
  const live = useRef(draft);
  const update = (patch: Partial<DiagramMetadataDraft>): void => {
    live.current = { ...live.current, ...patch };
    setDraft(live.current);
    if (!conflicted.current) { blocked.current = false; setError(null); }
  };
  const mounted = useRef(true);
  useEffect(() => {
    const saved = metadataDraft(canvas);
    const merged = reconcileMetadata(live.current, baseline.current, saved);
    baseline.current = saved;
    live.current = merged.draft;
    setDraft(merged.draft);
    if (merged.conflicts.length) {
      blocked.current = true;
      conflicted.current = true;
      setError('Saved diagram properties changed elsewhere. Your property draft is retained. Review it before retrying.');
    }
  }, [canvas]);
  const projects = useProjects();
  const changed = Object.keys(metadataPatch(draft, metadataDraft(canvas))).length > 0;
  const usedInChoices = (projects.data ?? []).filter(item => item.id !== project);
  const save = useCallback(async (): Promise<boolean> => {
    while (pending.current) { if (!await pending.current) return false; }
    if (disabled || blocked.current) return false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = live.current;
      if (!current.title.trim()) { setError('Enter a diagram title. Your other property edits are retained.'); return false; }
      const patch = metadataPatch(current, baseline.current);
      const expected = baseline.current;
      if (!Object.keys(patch).length) return true;
      setSaving(true); setError(null);
      const request = (async (): Promise<boolean> => {
        try {
          const response = await api.updateCanvas(canvas.id, { ...patch, expectedMetadata: {
            title: expected.title, description: expected.description, project: expected.project, usedInProjectIds: expected.usedIn, tagIds: expected.tagIds,
          } });
          if (!response.success) {
            if (response.error.code === 'CANVAS_METADATA_CONFLICT') conflicted.current = true;
            throw new Error(response.error.message);
          }
          const accepted = response.data;
          baseline.current = metadataDraft(accepted);
          live.current = reconcileMetadata(live.current, current, baseline.current).draft;
          if (mounted.current) {
            setDraft(live.current);
          }
          callbacks.current.onSaved(accepted);
          return true;
        } catch (cause) {
          blocked.current = true;
          if (isAxiosError(cause) && cause.response?.status === 409) conflicted.current = true;
          if (conflicted.current) {
            const refreshed = await api.getCanvas(canvas.id).catch(refreshError => {
              console.error('[Diagram metadata refresh]', refreshError); return null;
            });
            if (refreshed?.success) callbacks.current.onSaved(refreshed.data);
          }
          console.error('[Diagram metadata save]', cause);
          if (mounted.current) setError(conflicted.current
            ? 'Diagram properties changed elsewhere. Your draft is retained. Retry saves your reviewed draft over those fields.'
            : `Could not save diagram properties: ${cause instanceof Error ? cause.message : String(cause)}. Your edits are retained.`);
          return false;
        } finally { if (mounted.current) setSaving(false); }
      })();
      pending.current = request;
      try { if (!await request) return false; } finally { pending.current = null; }
      if (!Object.keys(metadataPatch(live.current, baseline.current)).length) return true;
    }
    return false;
  }, [canvas.id, disabled]);
  useEffect(() => {
    if (!changed || error || disabled) return;
    const timer = window.setTimeout(() => { void save(); }, 750);
    return () => { window.clearTimeout(timer); };
  }, [title, description, project, usedIn, tagIds, changed, error, disabled, save]);
  useEffect(() => { onSaveReady?.(save); return () => { onSaveReady?.(null); }; }, [onSaveReady, save]);
  const saveOnExit = useRef(save);
  saveOnExit.current = save;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void saveOnExit.current(); };
  }, []);
  return <details className="dg-section dg-section--diagram" open={expanded}>
  <summary className="dg-section__summary">Diagram properties</summary>
  <div className="dg-metadata" aria-label="Diagram metadata">
    <label className="dg-properties__field">Title
      <input aria-label="Diagram title property" maxLength={200} value={title} disabled={disabled}
        onChange={(event) => { update({ title: event.target.value }); }} />
    </label>
    <DiagramDescriptionEditor label="Diagram description" rows={3} value={description} disabled={disabled}
      onChange={value => { update({ description: value }); }} />
    <label className="dg-properties__field">Workstream
      <select aria-label="Diagram workstream" value={project} disabled={disabled || projects.isPending}
        onChange={(event) => { update({ project: event.target.value }); }}>
        <option value="">No workstream</option>
        {project !== '' && !projects.data?.some(item => item.id === project) && <option value={project}>{project}</option>}
        <ProjectOptions projects={projects.data ?? []} selected={project} />
      </select>
    </label>
    <fieldset className="dg-properties__field dg-metadata__used-in" disabled={disabled || projects.isPending}>
      <legend>Also used in</legend>
      {usedInChoices.length === 0 && <p className="dg-properties__hint">No other workstreams.</p>}
      {usedInChoices.map(item => <label key={item.id} className="dg-metadata__check">
        <input type="checkbox" checked={usedIn.includes(item.id)}
          onChange={(event) => { update({ usedIn: event.target.checked ? [...usedIn, item.id] : usedIn.filter(id => id !== item.id) }); }} />
        {item.name}
      </label>)}
    </fieldset>
    <div className="dg-properties__field">
      <span>Tags</span>
      <div className="notes-meta-tags-chips">
        {tagIds.length === 0 && <span className="dg-properties__hint">No tags.</span>}
        {tagIds.map(id => <EntityChip key={id} tagId={id} fallbackLabel="Unknown tag"
          removeTitle="Remove this tag" onRemove={() => { if (!disabled) update({ tagIds: tagIds.filter(item => item !== id) }); }} />)}
        <TagPicker selectedIds={tagIds} onChange={ids => { update({ tagIds: ids }); }} disabled={disabled}
          trigger={<button type="button" className="notes-tag-picker-trigger" disabled={disabled}>+ Add tag</button>} />
      </div>
      <p className="dg-properties__hint">Tags are added automatically after the diagram settles, just like notes. Tags you remove are not reapplied automatically.</p>
    </div>
    <p className="dg-properties__hint">Workstream grounds this diagram's Athena conversation. Choose No workstream to remove that restriction on the next message.</p>
    {projects.error !== null && <div className="dg-metadata__error" role="alert">
      Could not load workstreams: {projects.error.message}
      <button type="button" className="dg-text-btn" onClick={() => { void projects.refetch(); }}>Retry workstreams</button>
    </div>}
    {error !== null && <div className="dg-metadata__error" role="alert">{error}
      <button type="button" className="dg-text-btn" disabled={disabled || saving} onClick={() => { blocked.current = false; conflicted.current = false; void save(); }}>Retry saving properties</button>
    </div>}
    <p className="dg-metadata__status" role="status">{saving ? 'Saving properties…' : error ? 'Properties not saved' : changed ? 'Property changes pending' : 'Properties saved automatically'}</p>
  </div>
  </details>;
}
