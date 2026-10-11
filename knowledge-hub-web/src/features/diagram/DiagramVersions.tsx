import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InProgress, TrashCan } from '@carbon/icons-react';
import { api, type DiagramVersionApi } from '../../services/api';
import type { DiagramDocument } from './diagramTypes';
import { diffDocuments, type VersionChange } from './diagramAnnotations';
import { diagramSvg } from './diagramExport';

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Named snapshots of the diagram: save, preview, compare with now, restore, delete. */
export function DiagramVersions({ canvasId, doc, assets, flush, onRestore, notify }: {
  canvasId: string;
  doc: DiagramDocument;
  assets: Map<string, Blob>;
  /** Saves pending edits; resolves false if the diagram could not be saved. */
  flush: () => Promise<boolean>;
  onRestore: (version: DiagramVersionApi) => void;
  notify: (message: string) => void;
}): React.ReactElement {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const versions = useQuery({
    queryKey: ['diagram-versions', canvasId],
    queryFn: async () => {
      const r = await api.listDiagramVersions(canvasId);
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
  });
  const detail = useQuery({
    queryKey: ['diagram-version', canvasId, openId],
    enabled: openId !== null,
    staleTime: Infinity,
    queryFn: async () => {
      const r = await api.getDiagramVersion(canvasId, openId!);
      if (!r.success) throw new Error(r.error.message);
      return r.data;
    },
  });

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setBusy(true);
    setError(null);
    try {
      if (!(await flush())) throw new Error('Save your latest edits first (see the message above the diagram).');
      const r = await api.createDiagramVersion(canvasId, trimmed);
      if (!r.success) throw new Error(r.error.message);
      setName('');
      notify(`Saved version “${r.data.name}”.`);
      await client.invalidateQueries({ queryKey: ['diagram-versions', canvasId] });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the version'); }
    finally { setBusy(false); }
  }

  async function remove(id: string, label: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.deleteDiagramVersion(canvasId, id);
      if (openId === id) setOpenId(null);
      notify(`Deleted version “${label}”.`);
      await client.invalidateQueries({ queryKey: ['diagram-versions', canvasId] });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete the version'); }
    finally { setBusy(false); }
  }

  return <div className="dg-versions">
    <form className="dg-versions__save" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input aria-label="Version name" placeholder="Name this version, e.g. “Before SteerCo”" maxLength={120} value={name}
        onChange={(e) => { setName(e.target.value); }} />
      <button type="submit" className="dg-text-btn" disabled={busy || name.trim() === ''}>{busy ? <InProgress size={16} className="dg-spin" /> : null}Save</button>
    </form>
    {error !== null && <p role="alert" className="dg-versions__error">{error}</p>}
    {versions.isLoading && <p role="status" className="dg-popover__hint">Loading versions…</p>}
    {versions.isError && <p role="alert" className="dg-versions__error">Could not load versions. <button type="button" className="dg-text-btn" onClick={() => { void versions.refetch(); }}>Retry</button></p>}
    {versions.data?.length === 0 && <p className="dg-popover__hint">No saved versions yet. Name one before a big change so you can compare or go back.</p>}
    <ul className="dg-versions__list">
      {versions.data?.map((v) => <li key={v.id} className={`dg-versions__row${openId === v.id ? ' dg-versions__row--open' : ''}`}>
        <button type="button" className="dg-versions__name" aria-expanded={openId === v.id} onClick={() => { setOpenId(openId === v.id ? null : v.id); }}>
          <span>{v.name}</span><small>{when(v.createdAt)}</small>
        </button>
        <button type="button" className="dg-btn" aria-label={`Delete version ${v.name}`} title="Delete version" disabled={busy}
          onClick={() => { void remove(v.id, v.name); }}><TrashCan size={14} /></button>
        {openId === v.id && (detail.isLoading
          ? <p role="status" className="dg-popover__hint">Loading…</p>
          : detail.data !== undefined
            ? <VersionDetail version={detail.data} current={doc} assets={assets} onRestore={() => { onRestore(detail.data); }} />
            : <p role="alert" className="dg-versions__error">Could not load this version.</p>)}
      </li>)}
    </ul>
  </div>;
}

function VersionDetail({ version, current, assets, onRestore }: {
  version: DiagramVersionApi; current: DiagramDocument; assets: Map<string, Blob>; onRestore: () => void;
}): React.ReactElement {
  const [preview, setPreview] = useState<string | null>(null);
  const changes = useMemo(() => diffDocuments(version.document, current), [version.document, current]);
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    diagramSvg(version.document, assets, 'transparent', false, { tolerateMissingAssets: true, legend: false, footnotes: true })
      .then((svg) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        setPreview(url);
      })
      .catch(() => { if (alive) setPreview(null); });
    return () => { alive = false; if (url !== null) URL.revokeObjectURL(url); };
  }, [version.document, assets]);
  const count = (c: VersionChange['change']): number => changes.filter((x) => x.change === c).length;
  return <div className="dg-versions__detail">
    {preview !== null && <img className="dg-versions__preview" src={preview} alt={`Preview of ${version.name}`} />}
    <p className="dg-versions__summary">
      {changes.length === 0 ? 'Same as the current diagram.'
        : `Since this version: ${count('added')} added · ${count('removed')} removed · ${count('changed')} edited · ${count('moved')} moved`}
    </p>
    {changes.length > 0 && <ul className="dg-versions__changes">
      {changes.filter((c) => c.change !== 'moved').slice(0, 12).map((c) => <li key={`${c.change}-${c.id}`}><span className={`dg-versions__tag dg-versions__tag--${c.change}`}>{c.change}</span>{c.label}</li>)}
    </ul>}
    <button type="button" className="dg-text-btn" disabled={changes.length === 0} onClick={onRestore}>Restore this version</button>
  </div>;
}
