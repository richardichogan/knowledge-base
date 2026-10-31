import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData } from '../services/apiError';
import { noteDraftIdentity } from '../services/auth';
import { WORK_DRAFT_PREFIX } from './noteDraftStorage';
import type { WorkContent, WorkContentPatch } from '../types/workContent';

export function useWorkContent(noteId: string, enabled: boolean, saveNote: () => Promise<boolean>) {
  const [data, setData] = useState<WorkContent | null>(null);
  const [patch, setPatch] = useState<WorkContentPatch>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryConflict, setRecoveryConflict] = useState(false);
  const current = useRef<WorkContent | null>(null);
  const pending = useRef<WorkContentPatch>({});
  const saveRef = useRef(saveNote);
  const live = useRef(true);
  const draftKey = useRef<string | null>(null);
  const identitySnapshot = useRef<string | null>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const actionInFlight = useRef(false);
  const qc = useQueryClient();
  saveRef.current = saveNote;
  const accept = useCallback((value: WorkContent): void => {
    current.current = value;
    if (live.current) setData(value);
  }, []);
  const report = useCallback((err: unknown): void => {
    console.error('[Think work content]', err);
    if (live.current) setError(err instanceof Error ? err.message : 'Work properties could not be saved. Your draft is retained.');
  }, []);
  const reload = useCallback(async (): Promise<void> => {
    if (Object.keys(pending.current).length) throw new Error('Save or discard the retained properties draft before refreshing.');
    accept(requireApiData(await api.getWorkContent(noteId)));
    if (live.current) setError(null);
  }, [accept, noteId]);
  useEffect(() => {
    live.current = true;
    if (!enabled) { current.current = null; setData(null); return; }
    let cancelled = false;
    setBusy(true);
    void api.getWorkContent(noteId).then(result => {
      if (cancelled) return;
      const loaded = requireApiData(result);
      accept(loaded);
      const identity = noteDraftIdentity.get();
      if (!identity) throw new Error('Sign in before editing work properties.');
      identitySnapshot.current = noteDraftIdentity.snapshot();
      draftKey.current = `${WORK_DRAFT_PREFIX}${identity}:${noteId}`;
      const raw = localStorage.getItem(draftKey.current);
      if (raw) {
        const retained: unknown = JSON.parse(raw);
        if (!retained || typeof retained !== 'object' || !('patch' in retained) || !('revision' in retained)
          || !retained.patch || typeof retained.patch !== 'object' || Array.isArray(retained.patch)) {
          throw new Error('The retained work-properties draft is invalid. Copy or discard it before editing.');
        }
        pending.current = retained.patch as WorkContentPatch;
        setPatch(pending.current);
        if (retained.revision !== loaded.revision) {
          setRecoveryConflict(true);
          throw new Error('Saved properties changed since your retained draft. The draft is displayed; copy it before discarding and refreshing.');
        }
      }
    }).catch(report).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; live.current = false; };
  }, [accept, enabled, noteId, report]);
  useEffect(() => noteDraftIdentity.subscribe(() => {
    if (!identitySnapshot.current || identitySnapshot.current === noteDraftIdentity.snapshot()) return;
    pending.current = {}; current.current = null; draftKey.current = null;
    setPatch({}); setData(null); setRecoveryConflict(true);
    report(new Error('The account or recovery session changed. Reopen this note before editing work properties.'));
  }), [report]);
  const edit = useCallback((change: WorkContentPatch): void => {
    try {
      if (!draftKey.current || !current.current || identitySnapshot.current !== noteDraftIdentity.snapshot()) throw new Error('The original signed-in session is required. Reopen this note before editing.');
      pending.current = { ...pending.current, ...change };
      setPatch(pending.current);
      localStorage.setItem(draftKey.current, JSON.stringify({ revision: current.current.revision, patch: pending.current }));
      setError(null);
    } catch (err) { report(err); }
  }, [report]);
  const saveMetadata = useCallback(async (noteRevision: number): Promise<boolean> => {
    if (!enabled) return true;
    if (saveInFlight.current) return saveInFlight.current;
    if (!current.current || recoveryConflict) return false;
    if (!Object.keys(pending.current).length) return true;
    const operation = (async (): Promise<boolean> => {
      try {
        if (identitySnapshot.current !== noteDraftIdentity.snapshot()) throw new Error('The account or recovery session changed. Reopen before saving properties.');
        if (live.current) setBusy(true);
        while (Object.keys(pending.current).length) {
          const submitted = pending.current;
          const saved = requireApiData(await api.saveWorkContent(noteId, submitted, current.current!.revision, noteRevision));
          accept(saved);
          pending.current = Object.fromEntries(Object.entries(pending.current).filter(([key, value]) =>
            value !== submitted[key as keyof WorkContentPatch]));
          if (draftKey.current) {
            if (Object.keys(pending.current).length) localStorage.setItem(draftKey.current, JSON.stringify({ revision: saved.revision, patch: pending.current }));
            else localStorage.removeItem(draftKey.current);
          }
        }
        if (live.current) { setPatch(pending.current); setError(null); }
        return true;
      } catch (err) { report(err); return false; }
      finally { if (live.current) setBusy(false); }
    })();
    saveInFlight.current = operation;
    try { return await operation; } finally { saveInFlight.current = null; }
  }, [accept, enabled, noteId, recoveryConflict, report]);
  useEffect(() => {
    if (!Object.keys(patch).length || recoveryConflict) return;
    const timer = window.setTimeout(() => { void saveRef.current(); }, 3000);
    return () => { window.clearTimeout(timer); };
  }, [patch, recoveryConflict]);
  const discard = async (): Promise<void> => {
    if (draftKey.current) localStorage.removeItem(draftKey.current);
    pending.current = {}; setPatch({}); setRecoveryConflict(false);
    await reload();
  };
  const action = async (run: (value: WorkContent) => Promise<WorkContent>): Promise<void> => {
    if (actionInFlight.current) throw new Error('A confirmation is already being saved. Please wait.');
    actionInFlight.current = true;
    try {
      if (!await saveRef.current()) throw new Error('Save the note and its properties before continuing.');
      const expected = current.current;
      const loaded = requireApiData(await api.getWorkContent(noteId));
      if (!expected || loaded.revision !== expected.revision || loaded.taskUpdatedAt !== expected.taskUpdatedAt) {
        accept(loaded);
        throw new Error('The properties or linked task changed. Review the refreshed proposal before confirming again.');
      }
      if (live.current) setBusy(true);
      accept(await run(loaded));
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      await qc.invalidateQueries({ queryKey: ['today-tasks'] });
    } finally { actionInFlight.current = false; if (live.current) setBusy(false); }
  };
  const copy = async (): Promise<void> => {
    if (!await saveRef.current()) throw new Error('Save the note and properties before copying.');
    const value = requireApiData(await api.copyEmailDraft(noteId));
    await navigator.clipboard.writeText(value.text);
  };
  return { data, values: data ? { ...data, ...patch } : null, error, busy, recoveryConflict,
    dirty: Object.keys(patch).length > 0, edit, saveMetadata, reload, discard, action, copy, report };
}

export type WorkContentController = ReturnType<typeof useWorkContent>;
export function EmailDraftFields({ work, disabled }: { work: WorkContentController; disabled: boolean }): React.ReactElement {
  const value = work.values;
  return <div className="kh-work-email-fields" aria-label="Email draft fields">
    {(['to', 'cc', 'subject'] as const).map(field => <label key={field}>
      <span>{field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Subject'}</span>
      <input value={value?.[field] ?? ''} disabled={disabled || !value || value.status === 'sent'}
        maxLength={field === 'subject' ? 500 : 2000} autoComplete="off"
        onChange={event => { work.edit({ [field]: event.target.value }); }} />
    </label>)}
    <p>Draft only. Copy and send through IBM yourself.</p>
  </div>;
}

export function WorkContentProperties({ work, disabled }: { work: WorkContentController; disabled: boolean }): React.ReactElement {
  const value = work.values;
  const [confirmSent, setConfirmSent] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = (operation: () => Promise<void>): void => { void operation().catch(work.report); };
  return <section className="kh-work-properties" aria-label="Work deliverable properties">
    <h3>{value?.type === 'email-draft' ? 'Email draft' : 'Deliverable brief'}</h3>
    {work.error && <p className="kh-work-properties__error" role="alert">{work.error}</p>}
    {work.dirty && <p role="status">Properties draft retained{work.busy ? ' · Saving…' : ''}</p>}
    {work.recoveryConflict && <button type="button" className="notes-ghost-btn" onClick={() => { run(work.discard); }}>Discard properties draft and refresh</button>}
    {!value ? <p role="status">{work.busy ? 'Loading properties…' : 'Properties unavailable. Reopen this note to retry.'}</p> : <>
      <p>{value.taskId ? <a href={`/plan?taskId=${encodeURIComponent(value.taskId)}`}>{value.taskTitle ?? 'Linked task'}</a>
        : 'No linked task. Ask Athena to link this item to a Plan task.'}</p>
      {value.type === 'deliverable-brief' ? <>
        <label><span>OneDrive folder</span><input value={value.targetFolder} maxLength={1000}
          disabled={disabled || work.busy || work.recoveryConflict} placeholder="Athena/Project"
          onChange={event => { work.edit({ targetFolder: event.target.value }); }} /></label>
        <label><span>Exact file name</span><input value={value.fileName} maxLength={200}
          disabled={disabled || work.busy || work.recoveryConflict} placeholder="Requirements.docx"
          onChange={event => { work.edit({ fileName: event.target.value }); }} /></label>
        <p role="status">{value.producedFile ? 'File ready for review. Task remains open.' : 'Awaiting the exact file in OneDrive sync.'}</p>
        {value.producedFile && (value.producedFile.url ? <a href={value.producedFile.url}
          target="_blank" rel="noreferrer">{value.producedFile.title || value.fileName}</a>
          : <p>{value.producedFile.title || value.fileName} — original file link unavailable.</p>)}
        {value.sources.length > 0 && <p>{value.sources.length} cited source{value.sources.length === 1 ? '' : 's'} linked for Athena.</p>}
      </> : <>
        <p>Status: <strong>{value.status === 'sent' ? 'Sent' : 'Draft'}</strong>{value.sentAt ? ` · ${new Date(value.sentAt).toLocaleString('en-GB')}` : ''}</p>
        {value.briefId && <a href={`/think?noteId=${value.briefId}`}>Linked deliverable brief</a>}
        {value.status === 'draft' && !confirmSent && <button type="button" className="notes-ghost-btn"
          disabled={disabled || work.busy || !value.to || !value.subject} onClick={() => { setConfirmSent(true); }}>Mark Sent…</button>}
        {confirmSent && value.status === 'draft' && <div className="kh-work-properties__confirmation">
          <p>Confirm you sent this email yourself. Athena has not sent it.</p>
          <button type="button" className="notes-ghost-btn" disabled={disabled || work.busy} onClick={() => {
            run(async () => {
              await work.action(async loaded => requireApiData(await api.markEmailSent(loaded.noteId, loaded.revision, loaded.noteRevision)));
              setConfirmSent(false); setWaiting(true);
            });
          }}>I sent this email</button>
          <button type="button" className="notes-ghost-btn" disabled={work.busy} onClick={() => { setConfirmSent(false); }}>Cancel</button>
        </div>}
        {value.status === 'sent' && value.taskId && !waiting && <button type="button" className="notes-ghost-btn"
          disabled={disabled || work.busy} onClick={() => { setWaiting(true); }}>Review waiting-on proposal</button>}
        {waiting && value.status === 'sent' && value.taskId && <div className="kh-work-properties__confirmation">
          <p>Set the linked task to Waiting on {value.to}?</p>
          <button type="button" className="notes-ghost-btn" disabled={disabled || work.busy} onClick={() => {
            run(async () => {
              await work.action(async loaded => requireApiData(await api.confirmEmailWaiting(loaded.noteId, loaded.revision, loaded.taskUpdatedAt)));
              setWaiting(false);
            });
          }}>Confirm Waiting on</button>
          <button type="button" className="notes-ghost-btn" disabled={work.busy} onClick={() => { setWaiting(false); }}>Not now</button>
        </div>}
      </>}
      <div className="kh-work-properties__actions">
        {value.type === 'email-draft' && <button type="button" className="notes-ghost-btn" disabled={disabled || work.busy || work.recoveryConflict}
          onClick={() => { run(async () => { await work.copy(); setCopied(true); }); }}>
          Copy email
        </button>}
        <button type="button" className="notes-ghost-btn" disabled={disabled || work.busy || work.dirty}
          onClick={() => { run(work.reload); }}>Refresh status</button>
      </div>
      {copied && value.type === 'email-draft' && <p role="status">Copied. Paste into IBM Outlook and review before sending.</p>}
    </>}
  </section>;
}
