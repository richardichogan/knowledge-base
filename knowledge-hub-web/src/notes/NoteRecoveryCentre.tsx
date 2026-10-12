import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog } from '../components/AppDialog';
import { DataNotice } from '../components/DataNotice';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { confirmDialog } from '../services/appDialogs';
import { noteDraftIdentity } from '../services/auth';
import { fromApiNote } from './noteStorage';
import { listNoteDrafts, noteDraftKey, parseNoteDraft, removeNoteDraftIfUnchanged, type NoteDraft } from './noteDraftStorage';
import { NoteRecoveryPreview } from './NoteRecoveryPreview';

export const NoteRecoveryCentre: React.FC<{ onClose: () => void; onOpenNote: (id: string) => void }> = ({ onClose, onOpenNote }) => {
  useSyncExternalStore(noteDraftIdentity.subscribe, noteDraftIdentity.snapshot);
  const [identity] = useState(() => noteDraftIdentity.get());
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<NoteDraft | null>(null);
  const [local, setLocal] = useState<ReturnType<typeof listNoteDrafts> | null>(null);
  const [localError, setLocalError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const archives = useInfiniteQuery({
    queryKey: ['notes-archive', search],
    queryFn: async ({ pageParam }) => requireApiData(await api.getNoteSummaries(pageParam, 25, { status: 'archived', q: search, sort: 'modified' })),
    initialPageParam: 1, getNextPageParam: page => page.hasMore ? page.page + 1 : undefined,
    retry: false,
  });
  const preview = useQuery({
    queryKey: ['archived-note-preview', selectedId], enabled: selectedId !== null,
    queryFn: async () => {
      if (!selectedId) throw new Error('Select an archived note.');
      return fromApiNote(requireApiData(await api.getNote(selectedId, 'archived')));
    }, retry: false, refetchOnWindowFocus: false,
  });
  function refreshLocal(): void {
    try {
      if (!identity || noteDraftIdentity.get() !== identity) throw new Error('Return to the original account to review device-local writing.');
      setLocal(listNoteDrafts(localStorage, identity)); setLocalError(null);
    } catch (failure) { setLocalError(failure); }
  }
  useEffect(() => { refreshLocal(); }, [identity]); // eslint-disable-line react-hooks/exhaustive-deps
  async function restoreArchive(): Promise<void> {
    if (pending.current || !preview.data || previewFailed) return;
    const reviewed = preview.data;
    pending.current = true; setBusy(true); setError(null); setNotice('');
    try {
      if (!await confirmDialog('Restore this archived note to Think? Writing, History, project, tags, links and GitHub settings stay unchanged. Normal indexing resumes; this does not publish anything.', {
        title: 'Restore archived note', confirmLabel: 'Restore note',
      })) return;
      const result = requireApiData(await api.restoreArchivedNote(reviewed.id, reviewed.revision ?? 0));
      setNotice(result.restored ? 'Note restored. Indexing is queued; linked views may take a little time to update.' : 'This note is already active. No writing or metadata was changed.');
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      await archives.refetch({ throwOnError: true });
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }
  function draftSnapshot(): { draft: NoteDraft; raw: string } {
    if (!identity || noteDraftIdentity.get() !== identity || !selectedDraft) throw new Error('The original account and a selected local copy are required.');
    const key = noteDraftKey(identity, selectedDraft.noteId, selectedDraft.id);
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error('This copy was already removed. Refresh local copies.');
    const draft = parseNoteDraft(raw, identity, key);
    if (JSON.stringify(draft) !== JSON.stringify(selectedDraft)) throw new Error('The local writing changed. Refresh and review it again.');
    return { draft, raw };
  }
  async function discardDraft(): Promise<void> {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const current = draftSnapshot();
      if (!await confirmDialog('Discard this device-local writing copy? Server writing and History are unchanged. Further editing can create a new local copy.', {
        title: 'Discard local writing', confirmLabel: 'Discard copy', tone: 'danger',
      })) return;
      if (!removeNoteDraftIfUnchanged(localStorage, current.draft, current.raw)) throw new Error('The copy changed while you reviewed it. Refresh before discarding.');
      setSelectedDraft(null); refreshLocal(); setNotice('Local copy discarded.');
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }
  const owned = identity !== null && noteDraftIdentity.get() === identity;
  const seen = new Set<string>();
  const rows = archives.data?.pages.flatMap(page => page.items).filter(row => !seen.has(row.id) && Boolean(seen.add(row.id))) ?? [];
  return <AppDialog title="Think recovery" wide onClose={() => { if (!pending.current) onClose(); }}
    actions={<button type="button" className="kh-dialog__button" disabled={busy} onClick={onClose}>Close recovery</button>}>
    <div className="note-recovery note-recovery--centre">
      <p>Recovery is separate from backups. Opening this centre keeps your current editor mounted.</p>
      <section aria-label="Recently archived notes">
        <h3>Recently archived notes</h3>
        <label className="note-recovery__search">Search archived writing
          <input value={search} disabled={busy} maxLength={300} onChange={event => { setSearch(event.target.value); setSelectedId(null); }} />
        </label>
        <button type="button" disabled={busy || archives.isFetching} onClick={() => { void archives.refetch(); }}>Refresh archive</button>
        {archives.isPending && <p role="status">Loading archived notes...</p>}
        {archives.isError && <DataNotice title="Archive list is unavailable" error={archives.error} onRetry={() => { void archives.refetch(); }} />}
        {archives.data && <p>{rows.length} of {archives.data.pages[0]?.total ?? 0} archived notes loaded.</p>}
        {!archives.isPending && !archives.isError && rows.length === 0 && <p>No archived notes match this search.</p>}
        <div className="note-recovery__entries">{rows.map(row => <button type="button" key={row.id} disabled={busy}
          aria-pressed={selectedId === row.id} onClick={() => { setSelectedId(row.id); setPreviewGeneration(value => value + 1); setPreviewFailed(false); setError(null); }}>
          <strong>{row.title}</strong><span>{row.contentType} · Last updated {new Date(row.updatedAt).toLocaleString('en-GB')}</span>
        </button>)}</div>
        {archives.hasNextPage && <button type="button" disabled={busy || archives.isFetching} onClick={() => { void archives.fetchNextPage(); }}>
          {archives.isFetchingNextPage ? 'Loading...' : 'Load more archived notes'}</button>}
        {selectedId && preview.isPending && <p role="status">Loading archived writing...</p>}
        {selectedId && preview.isError && <DataNotice title="Archived writing is unavailable" error={preview.error} onRetry={() => { void preview.refetch(); }} />}
        {selectedId && preview.data && !preview.isError && <>
          <NoteRecoveryPreview key={`${selectedId}:${previewGeneration}`} writing={preview.data} onFailure={() => setPreviewFailed(true)} />
          <button type="button" disabled={busy || previewFailed || preview.isFetching} onClick={() => { void restoreArchive(); }}>Restore archived note</button>
        </>}
      </section>
      <section aria-label="Device-local writing copies">
        <h3>Device-local writing copies</h3>
        <p>Plain-text copies for this account on this browser only. Title, content type and rich body are retained; project changes, tags, links, publication settings and image files are not backed up. Sign-out removes local copies.</p>
        {!owned && <p role="alert">Return to the original account to review these local copies.</p>}
        {owned && <>
          <button type="button" disabled={busy} onClick={() => { setSelectedDraft(null); refreshLocal(); }}>Refresh local copies</button>
          {localError != null && <DataNotice title="Local copies could not be read" error={localError} />}
          {local?.truncated && <p role="alert">Only the first 100 copies were read. Discard reviewed copies and refresh to see more.</p>}
          {local?.drafts.length === 0 && <p>No local writing copies for this account.</p>}
          <div className="note-recovery__entries">{local?.drafts.map(draft => <button type="button" key={draft.id} disabled={busy}
            aria-pressed={selectedDraft?.id === draft.id} onClick={() => { setSelectedDraft(draft); setError(null); }}>
            <strong>{draft.writing.title}</strong><span>Note {draft.noteId} · Revision {draft.baseRevision} · {new Date(draft.updatedAt).toLocaleString('en-GB')}</span>
          </button>)}</div>
          {local?.errors.map(item => <div key={item.key} className="note-recovery__invalid">
            <DataNotice title="A local copy is unreadable; it has not been changed" error={item.error} />
            <code>{item.key}</code>
            <button type="button" disabled={busy} onClick={() => {
              void (async () => {
                if (pending.current) return;
                pending.current = true; setBusy(true);
                try {
                  const raw = localStorage.getItem(item.key);
                  if (!await confirmDialog('Discard this unreadable local record? Its writing cannot be previewed. This does not change server data.', { title: 'Discard unreadable local copy', confirmLabel: 'Discard record', tone: 'danger' })) return;
                  if (noteDraftIdentity.get() !== identity || localStorage.getItem(item.key) !== raw) throw new Error('The account or local record changed. Nothing was discarded.');
                  localStorage.removeItem(item.key); refreshLocal();
                } catch (failure) { setError(failure); }
                finally { pending.current = false; setBusy(false); }
              })();
            }}>Discard unreadable copy</button>
          </div>)}
          {selectedDraft && <>
            <NoteRecoveryPreview key={selectedDraft.id} writing={selectedDraft.writing} onFailure={() => { setError(new Error('Preview unavailable. Use exact JSON or open the source note; nothing was restored.')); }} />
            <details><summary>Exact local JSON (available for manual copying)</summary><textarea readOnly aria-label="Exact local writing JSON" value={JSON.stringify(selectedDraft.writing, null, 2)} /></details>
            <div className="note-recovery__actions">
              <button type="button" disabled={busy} onClick={() => {
                try { const current = draftSnapshot(); onOpenNote(current.draft.noteId); onClose(); } catch (failure) { setError(failure); }
              }}>Open source note to compare or restore</button>
              <button type="button" disabled={busy} onClick={() => {
                void (async () => {
                  try { const current = draftSnapshot(); await navigator.clipboard.writeText(JSON.stringify(current.draft.writing, null, 2)); setNotice('Exact local JSON copied.'); }
                  catch (failure) { setError(failure); }
                })();
              }}>Copy exact local JSON</button>
              <button type="button" disabled={busy} onClick={() => { void discardDraft(); }}>Discard local copy</button>
            </div>
          </>}
        </>}
      </section>
      {busy && <p role="status">Recovery operation in progress...</p>}
      {notice && <p role="status">{notice}</p>}
      {error != null && <DataNotice title="Recovery needs attention" error={error} />}
    </div>
  </AppDialog>;
};
