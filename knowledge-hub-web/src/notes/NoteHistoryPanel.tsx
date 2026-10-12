import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { confirmDialog } from '../services/appDialogs';
import { NoteRecoveryPreview } from './NoteRecoveryPreview';

const REASONS = { automatic: 'Automatic checkpoint', before_athena: 'Before Athena changes', before_restore: 'Before restore', before_github: 'Before accepting GitHub version' };
function date(iso: string): string { return new Date(iso).toLocaleString('en-GB'); }

export function NoteHistoryPanel({ noteId, refresh, onRestore }: {
  noteId: string; refresh: number; onRestore: (versionId: string) => Promise<void>;
}): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const history = useQuery({
    queryKey: ['note-history', noteId],
    queryFn: async () => {
      const result = await api.getNoteHistory(noteId);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    retry: false,
  });
  const version = useQuery({
    queryKey: ['note-version', noteId, selected],
    enabled: selected !== null,
    queryFn: async () => {
      if (!selected) throw new Error('Select a checkpoint');
      const result = await api.getNoteVersion(noteId, selected);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    retry: false,
  });
  useEffect(() => { void history.refetch(); }, [refresh, history.refetch]);
  useEffect(() => {
    if (selected && history.data && !history.data.some(item => item.id === selected)) setSelected(null);
  }, [history.data, selected]);
  async function restore(): Promise<void> {
    if (!selected || restoring || previewFailed) return;
    if (!await confirmDialog('Restore this checkpoint\'s title, content type and body? Your current writing will be preserved as a checkpoint. Project, tags, links and GitHub settings will stay unchanged.', {
      title: 'Restore Think writing', confirmLabel: 'Restore writing',
    })) return;
    setRestoring(true);
    setError(null);
    try {
      await onRestore(selected);
      await history.refetch();
    } catch (err) { setError(err instanceof Error ? err.message : 'Restore failed. Your draft is retained; retry.'); }
    finally { setRestoring(false); }
  }
  return <section className="note-history" aria-label="Think recovery checkpoints">
    <p className="note-history__intro">Current writing stays in the editor. Recovery checkpoints are not every save: at most one automatic checkpoint per 30 minutes, plus before Athena replacements and restores. Up to 30 retained.</p>
    <p className="note-history__intro">Intermediate autosaves may not be recoverable. Image references are retained, not copies of the files.</p>
    <button type="button" className="note-history__button" disabled={history.isFetching || restoring} onClick={() => { void history.refetch(); }}>Refresh history</button>
    {history.isPending && <p className="note-history__status" role="status">Loading checkpoints...</p>}
    {history.isError && <p role="alert" className="note-history__error">{history.error.message} Use Refresh history to retry.</p>}
    {history.data?.length === 0 && <p className="note-history__status">No checkpoints yet. The first changed save will preserve the previous writing.</p>}
    <ol className="note-history__list">
      {history.data?.map(item => <li key={item.id}>
        <button type="button" className="note-history__entry" aria-pressed={selected === item.id} disabled={restoring} onClick={() => {
          if (selected !== item.id) { setSelected(item.id); setPreviewFailed(false); }
          setError(null);
        }}>
          <strong>{REASONS[item.reason]}</strong>
          <time dateTime={item.created_at}>{date(item.created_at)}</time>
          <span>Writing saved {date(item.writing_updated_at)}</span>
        </button>
      </li>)}
    </ol>
    {selected && version.isPending && <p role="status" className="note-history__status">Loading preview...</p>}
    {selected && version.isError && <div className="note-history__error" role="alert">{version.error.message}
      <button type="button" className="note-history__button" onClick={() => { void version.refetch(); }}>Retry preview</button>
    </div>}
    {selected && version.data && !version.isError && <>
      <NoteRecoveryPreview key={version.data.id} writing={version.data.writing} variant="history"
        onFailure={() => { setPreviewFailed(true); }} />
      <button type="button" className="note-history__button note-history__button--restore" disabled={restoring || previewFailed} onClick={() => { void restore(); }}>{restoring ? 'Restoring...' : 'Restore writing'}</button>
    </>}
    {error && <p role="alert" className="note-history__error">{error}</p>}
  </section>;
}
