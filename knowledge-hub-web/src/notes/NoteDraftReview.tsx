import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { confirmDialog } from '../services/appDialogs';
import { DataNotice } from '../components/DataNotice';
import { AppDialog } from '../components/AppDialog';
import { fromApiNote } from './noteStorage';
import { listNoteDrafts, noteDraftKey, parseNoteDraft, removeNoteDraftIfUnchanged, type NoteDraft } from './noteDraftStorage';
import { NoteRecoveryPreview } from './NoteRecoveryPreview';
import { noteDraftIdentity } from '../services/auth';

export const NoteDraftReview: React.FC<{
  identity: string | null; noteId: string; currentDraftId: string;
  onRestore: (draft: NoteDraft, expectedRaw: string, reviewedRevision: number) => Promise<void>;
}> = ({ identity, noteId, currentDraftId, onRestore }) => {
  useSyncExternalStore(noteDraftIdentity.subscribe, noteDraftIdentity.snapshot);
  const [drafts, setDrafts] = useState<NoteDraft[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<NoteDraft | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);

  function refresh(): void {
    try {
      if (!identity || noteDraftIdentity.get() !== identity) throw new Error('Sign in with the original account to review this note\'s local writing.');
      const result = listNoteDrafts(localStorage, identity);
      setDrafts(result.drafts.filter(draft => draft.noteId === noteId && draft.id !== currentDraftId));
      if (result.errors.length) throw new Error('A local draft is unreadable. Use Recovery to review its storage error.');
      if (result.truncated) throw new Error('Only the first 100 local copies were read. Discard reviewed copies in Recovery, then refresh.');
      setError(null);
    } catch (failure) { setError(failure); }
  }
  useEffect(() => { refresh(); }, [identity, noteId, currentDraftId]); // eslint-disable-line react-hooks/exhaustive-deps
  const server = useQuery({
    queryKey: ['note-recovery-server', identity, noteId, selected?.id],
    enabled: open && selected !== null && identity !== null,
    queryFn: async () => fromApiNote(requireApiData(await api.getNote(noteId))),
    retry: false, refetchOnWindowFocus: false,
  });
  function snapshot(): { draft: NoteDraft; raw: string } {
    if (!identity || noteDraftIdentity.get() !== identity || !selected) throw new Error('The original account and a selected local draft are required.');
    const key = noteDraftKey(identity, noteId, selected.id);
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error('This local copy was already removed. Refresh local copies.');
    const draft = parseNoteDraft(raw, identity, key);
    if (JSON.stringify(draft) !== JSON.stringify(selected)) throw new Error('This local copy changed. Refresh and review the newer writing first.');
    return { draft, raw };
  }
  async function restore(): Promise<void> {
    if (pending.current || !server.data || server.isFetching || previewFailed) return;
    pending.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const local = snapshot();
      const revision = server.data.revision ?? 0;
      const conflict = revision !== local.draft.baseRevision;
      if (!await confirmDialog(
        `${conflict ? 'The saved note changed after this local copy began. ' : ''}Replace reviewed saved revision ${revision} with this local title, content type and body? Current saved writing will be preserved in History, and unsaved open writing as another local copy. Project, tags, links and GitHub settings stay unchanged.`,
        { title: conflict ? 'Resolve local writing conflict' : 'Restore local writing', confirmLabel: 'Restore reviewed writing', ...(conflict ? { tone: 'danger' as const } : {}) },
      )) return;
      await onRestore(local.draft, local.raw, revision);
      setSelected(null); refresh(); setNotice('Local writing restored. Previous saved writing is in History.');
    } catch (failure) { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }
  if (identity === null || noteDraftIdentity.get() !== identity) return <p className="notes-save-status notes-save-status--error" role="alert">Local recovery is paused until the original account returns.</p>;
  return <section className="note-recovery" aria-label="Local writing recovery">
    {(drafts.length > 0 || error != null) && <button type="button" className="note-recovery__draft-launch" aria-haspopup="dialog"
      onClick={() => setOpen(true)}>Review {drafts.length} local {drafts.length === 1 ? 'copy' : 'copies'}</button>}
    {open && <AppDialog title="Local writing recovery" wide onClose={() => { if (!pending.current) setOpen(false); }}
      actions={<button type="button" className="kh-dialog__button" disabled={busy} onClick={() => setOpen(false)}>Close local recovery</button>}>
      <div className="note-recovery note-recovery--comparison">
      <p>These are device-local writing copies, not server saves or backups. Nothing is restored automatically.</p>
      <button type="button" disabled={busy} onClick={refresh}>Refresh local copies</button>
      {error != null && <DataNotice title="Local writing recovery needs attention" error={error} />}
      <div className="note-recovery__entries">{drafts.map(draft => <button type="button" key={draft.id} disabled={busy}
        aria-pressed={selected?.id === draft.id} onClick={() => { setSelected(draft); setPreviewGeneration(value => value + 1); setPreviewFailed(false); setError(null); setNotice(''); }}>
        <strong>{draft.writing.title}</strong><span>Local copy {new Date(draft.updatedAt).toLocaleString('en-GB')} · Based on revision {draft.baseRevision}</span>
      </button>)}</div>
      {selected && server.isPending && <p role="status">Loading saved writing for comparison...</p>}
      {selected && server.isError && <DataNotice title="Saved writing is unavailable; your local copy is unchanged" error={server.error} onRetry={() => { void server.refetch(); }} />}
      {selected && <>
        <div className="note-recovery__comparison">
        <section>
        <h3>Local writing</h3>
        <NoteRecoveryPreview key={`${selected.id}:${previewGeneration}`} writing={selected.writing} onFailure={() => setPreviewFailed(true)} />
        <details><summary>Exact local JSON (available for manual copying)</summary>
          <textarea readOnly aria-label="Exact local writing JSON" value={JSON.stringify(selected.writing, null, 2)} />
        </details>
        </section>
        <section>
        {server.data && !server.isError && <>
          <h3>Current saved writing · revision {server.data.revision ?? 0}</h3>
          {(server.data.revision ?? 0) !== selected.baseRevision && <p role="status">Conflict: the server changed since this local copy began. Review both versions before choosing Restore.</p>}
          <NoteRecoveryPreview key={`saved-${server.data.revision}:${previewGeneration}`} writing={server.data} onFailure={() => setPreviewFailed(true)} />
        </>}
        </section>
        </div>
        <div className="note-recovery__actions">
          <button type="button" disabled={busy || server.isFetching || server.isPending || server.isError || previewFailed}
            onClick={() => { void restore(); }}>Restore local writing</button>
          <button type="button" disabled={busy || server.isFetching} onClick={() => { void server.refetch(); }}>Refresh saved comparison</button>
          <button type="button" disabled={busy} onClick={() => {
            void (async () => {
              try { const local = snapshot(); await navigator.clipboard.writeText(JSON.stringify(local.draft.writing, null, 2)); setNotice('Exact local JSON copied.'); }
              catch (failure) { setError(failure); }
            })();
          }}>Copy exact local JSON</button>
          <button type="button" disabled={busy} onClick={() => {
            void (async () => {
              if (pending.current) return;
              pending.current = true; setBusy(true);
              try {
                const local = snapshot();
                if (!await confirmDialog('Remove this device-local copy? Saved writing and History will not change.', { title: 'Discard local copy', confirmLabel: 'Discard copy', tone: 'danger' })) return;
                if (!removeNoteDraftIfUnchanged(localStorage, local.draft, local.raw)) throw new Error('Local copy changed while you reviewed it. Refresh before discarding.');
                setSelected(null); refresh(); setNotice('Local copy discarded.');
              } catch (failure) { setError(failure); }
              finally { pending.current = false; setBusy(false); }
            })();
          }}>Discard local copy</button>
        </div>
      </>}
      {notice && <p role="status">{notice}</p>}
      </div>
    </AppDialog>}
  </section>;
};
