/**
 * components/library/LocalFoldersPanel.tsx — Athena Desktop only: the folders
 * on this PC Athena indexes and can read/write, sync status, and every file it
 * could not index (nothing is skipped silently).
 */
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { desktopErrorMessage, getDesktop, type DesktopFolder } from '../../types/desktop';
import { getLocalSyncStatus, startLocalSync, subscribeLocalSync, syncLocalFolders } from '../../services/localSync';

function ago(iso: string | null): string {
  if (iso === null) return 'not yet';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins.toString()}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours.toString()}h ago` : `${Math.round(hours / 24).toString()}d ago`;
}

export function useLocalSyncStatus(): ReturnType<typeof getLocalSyncStatus> {
  return useSyncExternalStore(subscribeLocalSync, getLocalSyncStatus);
}

/** Mounted once at the app root: keeps local folders indexed while Athena Desktop is open. */
export const LocalFolderSync: React.FC = () => {
  const qc = useQueryClient();
  useEffect(() => startLocalSync(() => { void qc.invalidateQueries({ queryKey: ['documents-library'] }); }), [qc]);
  return null;
};

export const LocalFoldersPanel: React.FC = () => {
  const desktop = getDesktop();
  const status = useLocalSyncStatus();
  const [folders, setFolders] = useState<DesktopFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const reload = useCallback(async () => {
    if (desktop === null) return;
    try {
      setFolders(await desktop.listFolders());
    } catch (err) {
      setError(desktopErrorMessage(err));
    }
  }, [desktop]);

  useEffect(() => { void reload(); }, [reload]);

  if (desktop === null) return null;

  async function add(): Promise<void> {
    if (desktop === null) return;
    setError(null);
    try {
      const added = await desktop.addFolder();
      if (added === null) return;
      await reload();
      void syncLocalFolders();
    } catch (err) {
      setError(desktopErrorMessage(err));
    }
  }

  async function remove(folder: DesktopFolder): Promise<void> {
    if (desktop === null) return;
    setError(null);
    try {
      await desktop.removeFolder(folder.id);
      await reload();
      // The next sync removes that folder's files from Athena.
      void syncLocalFolders();
    } catch (err) {
      setError(desktopErrorMessage(err));
    }
  }

  const issueCount = status.problems.length + status.skipped.length;
  const summary = status.running
    ? status.progress ?? 'Syncing…'
    : status.error !== null
      ? `Sync failed: ${status.error}`
      : `${status.indexed.toString()} file${status.indexed === 1 ? '' : 's'} indexed · synced ${ago(status.lastSyncAt)}`;

  return (
    <section className={`local-folders${status.error !== null ? ' local-folders--error' : ''}`} aria-label="Folders on this PC">
      <div className="local-folders__head">
        <span className={`local-folders__dot${status.running ? ' local-folders__dot--busy' : status.error === null ? ' local-folders__dot--ok' : ''}`} aria-hidden="true" />
        <span className="local-folders__label">Folders on this PC</span>
        <span className="local-folders__detail" role="status">{summary}</span>
        {issueCount > 0 && !status.running && (
          <button type="button" className="local-folders__issues" onClick={() => { setDetailsOpen((v) => !v); }} aria-expanded={detailsOpen}>
            {issueCount.toString()} file{issueCount === 1 ? '' : 's'} not indexed {detailsOpen ? '▴' : '▾'}
          </button>
        )}
        <span className="local-folders__spacer" />
        <button type="button" className="kb-import-btn" disabled={status.running || folders === null || folders.length === 0} onClick={() => { void syncLocalFolders(); }}>
          {status.running ? 'Syncing…' : 'Sync now'}
        </button>
        <button type="button" className="kb-import-btn" onClick={() => { void add(); }}>Add folder</button>
      </div>

      {error !== null && <p className="local-folders__error" role="alert">{error}</p>}

      {folders !== null && folders.length === 0 && (
        <p className="local-folders__empty">Add a folder and Athena will index its PDF, Word, PowerPoint, Excel, CSV, Markdown and text files, read them in chat, and propose changes you can apply.</p>
      )}

      {folders !== null && folders.length > 0 && (
        <ul className="local-folders__list">
          {folders.map((f) => (
            <li key={f.id} className="local-folders__folder">
              <span className="local-folders__name">{f.name}</span>
              <code className="local-folders__path" title={f.path}>{f.path}</code>
              <button type="button" className="local-folders__remove" onClick={() => { void remove(f); }} aria-label={`Stop using ${f.name}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      {detailsOpen && issueCount > 0 && (
        <ul className="local-folders__problems">
          {status.problems.map((p, i) => (
            <li key={`p${i.toString()}`} className="local-folders__problem local-folders__problem--error">
              <code className="local-folders__path" title={p.path}>{p.path}</code>
              <span>{p.message}</span>
            </li>
          ))}
          {status.skipped.map((s, i) => (
            <li key={`s${i.toString()}`} className="local-folders__problem">
              <code className="local-folders__path" title={s.path}>{s.path}</code>
              <span>{s.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
