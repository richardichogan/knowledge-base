import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { BlockNoteEditor } from '@blocknote/core';
import type { editorSchema } from './editorSchema';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import { rememberAgentJob, useAgentJobFinished, useAgentJobs } from '../services/agentJobStore';
import { requestCompletionNotifications } from '../chat/completionNotification';
import { AppDialog } from '../components/AppDialog';
import { ScriptVisualPreview } from '../features/autocue/ScriptVisualPreview';
import { applyNoteEdits } from '../utils/noteEditApplier';
import { getActiveBlockNoteEditor, getActiveNoteId, runNoteAction } from '../utils/activeBlockNoteEditor';
import { parseScriptVisualJobResult, scriptVisualJobEdits, SCRIPT_VISUAL_SPECIALIST, type ScriptVisualJobResult } from '../../../knowledge-hub-backend/src/utils/scriptVisualJobs';
import { visualSpokenText, readSectionVisuals } from '../../../knowledge-hub-backend/src/utils/scriptVisuals';
import type { AgentJob } from '../types/agentJobs';

type Editor = BlockNoteEditor<typeof editorSchema.blockSchema, typeof editorSchema.inlineContentSchema, typeof editorSchema.styleSchema>;

export function useScriptVisualJobs({ editor, noteId, save, disabled }: {
  editor: Editor; noteId: string; save: () => Promise<boolean>; disabled: boolean;
}) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const linkedId = params.get('visualJobId');
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const applyingRef = useRef(false);
  const [revision, setRevision] = useState(0);
  const live = useAgentJobs(noteId);
  const key = ['script-visual-jobs', noteId, linkedId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const jobs = requireApiData(await api.listScriptVisualJobs(noteId));
      if (linkedId && !jobs.some(job => job.id === linkedId)) jobs.unshift(requireApiData(await api.getAgentJob(linkedId)));
      return jobs;
    },
    refetchInterval: 15_000,
  });
  const refresh = useCallback((job: AgentJob): void => {
    if (job.specialist === SCRIPT_VISUAL_SPECIALIST) void qc.invalidateQueries({ queryKey: ['script-visual-jobs', noteId] });
  }, [qc, noteId]);
  useAgentJobFinished(noteId, refresh);
  useEffect(() => { setReviewId(linkedId); setError(null); }, [noteId, linkedId]);
  useEffect(() => editor.onChange(() => { setRevision(value => value + 1); }), [editor]);
  const merged = new Map((query.data ?? []).map(job => [job.id, job]));
  for (const job of live.jobs) merged.set(job.id, job);
  const jobs = [...merged.values()].filter(job => job.specialist === SCRIPT_VISUAL_SPECIALIST && job.subjectId === noteId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = jobs.find(job => job.status === 'running' || job.status === 'queued');
  const completed = jobs.filter(job => job.status === 'done');
  const selected = jobs.find(job => job.id === reviewId);
  let result: ScriptVisualJobResult | null = null;
  let conflict: string | null = null;
  let editCount = 0;
  try {
    if (selected?.status === 'done') {
      result = parseScriptVisualJobResult(selected.result, noteId);
      editCount = scriptVisualJobEdits(result, editor.document).length;
    }
  } catch (failure) { conflict = describeApiError(failure); }
  useEffect(() => { window.dispatchEvent(new Event('athena:script-visual-context')); }, [reviewId, selected?.status, conflict, revision]);
  useEffect(() => () => { window.dispatchEvent(new Event('athena:script-visual-context')); }, []);
  const close = (): void => {
    if (applyingRef.current) return;
    setReviewId(null); setError(null);
    if (linkedId) {
      const next = new URLSearchParams(params);
      next.delete('visualJobId');
      setParams(next, { replace: true });
    }
  };
  const generate = (): void => {
    if (submittingRef.current || active || disabled) return;
    submittingRef.current = true; setSubmitting(true); setError(null);
    requestCompletionNotifications();
    void (async () => {
      if (!await save()) throw new Error('Save the current script successfully before queuing visuals.');
      if (getActiveNoteId() !== noteId || getActiveBlockNoteEditor() !== editor) throw new Error('The open script changed. No visual job was queued.');
      const queued = requireApiData(await api.queueScriptVisuals(noteId,
        'Design fresh visuals for the requested sections using structured Carbon patterns (cycle, tree, tiers, converge, flow, compare, hub, branch, stack) with drawn graphics, icons, panels or tiered blocks that best explain each section\'s concepts, varying the pattern across sections. Use sparse labels, not the talk track. Do not mix static images into animated scenes. Imagery is optional and only for a purposeful separate full-screen or blended static header. Include a distinct opening title for the first script section only. Preserve the spoken script.'));
      if (queued.status === 'needs_confirmation') throw new Error(queued.message);
      rememberAgentJob(queued.job);
      await qc.invalidateQueries({ queryKey: ['script-visual-jobs', noteId] });
    })().catch(failure => { setError(describeApiError(failure)); })
      .finally(() => { submittingRef.current = false; setSubmitting(false); });
  };
  const apply = (): void => {
    if (!result || applyingRef.current || disabled || conflict || !editCount) return;
    const pending = result;
    applyingRef.current = true; setApplying(true); setError(null);
    void runNoteAction(noteId, true, () => {
      const edits = scriptVisualJobEdits(pending, editor.document);
      const outcome = applyNoteEdits(editor, edits, { script: true });
      if (outcome.failed.length) throw new Error(outcome.failed.join('; '));
    }).then(() => { setRevision(value => value + 1); })
      .catch(failure => { setError(describeApiError(failure)); })
      .finally(() => { applyingRef.current = false; setApplying(false); });
  };
  const last = jobs[0];
  const status = submitting ? 'Saving the script and queuing Ariadne…'
    : active ? `Ariadne is working in Background work. ${active.progress.at(-1) ?? 'Waiting for a worker.'} You can keep editing or leave this screen.`
      : last?.status === 'failed' ? `Ariadne could not finish: ${last.error ?? 'Open Background work for details.'}`
        : completed.length ? 'Ariadne has saved visual results. Review and apply when ready; generation does not change the script.' : null;
  const review = (): void => { setError(null); setReviewId(completed[0]?.id ?? linkedId ?? null); };
  const dialog = reviewId ? <AppDialog title="Review Ariadne visuals" wide onClose={close}
    actions={<>
      <button type="button" className="kh-dialog__button" disabled={applying} onClick={close}>Close</button>
      <button type="button" className="kh-dialog__button kh-dialog__button--primary" disabled={disabled || applying || !result || !!conflict || !editCount}
        onClick={apply}>{applying ? 'Saving visuals…' : result && !conflict && !editCount ? 'Matches current visuals' : 'Apply visuals'}</button>
    </>}>
    <div className="kh-script-visual-review" data-visual-job={reviewId}
      data-visual-job-status={selected?.status ?? 'loading'} data-visual-job-conflict={conflict ?? ''}>
      <p>These are saved results, not changes to your script. Apply replaces only the requested section visuals, after checking the current source. Spoken text and unrelated work are preserved.</p>
      {completed.length > 1 && <label>Saved result
        <select value={selected?.status === 'done' ? selected.id : ''} disabled={applying} onChange={event => { setReviewId(event.target.value); setError(null); }}>
          {selected?.status !== 'done' && <option value="">Choose a completed result</option>}
          {completed.map(job => <option key={job.id} value={job.id}>{new Date(job.createdAt).toLocaleString('en-GB')}</option>)}
        </select>
      </label>}
      {query.isPending && <p role="status">Loading saved visual results…</p>}
      {query.isError && <p role="alert">{describeApiError(query.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void query.refetch(); }}>Retry</button></p>}
      {!query.isPending && !query.isError && !selected && <p role="alert">This result is not available for the open script.</p>}
      {selected && selected.status !== 'done' && <p role={selected.status === 'failed' ? 'alert' : 'status'}>
        {selected.status === 'failed' ? selected.error : selected.progress.at(-1) ?? 'Waiting for Ariadne to finish. You can close this review and keep working.'}</p>}
      {conflict && <p role="alert">{conflict}</p>}
      {error && <p role="alert">{error}</p>}
      {result && !conflict && !editCount && <p role="status">This result already matches the open editor. It will not be applied again.</p>}
      {result && result.sections.map((draft, index) => {
        // Presentation-global numbering: the draft's scene counts stand in for the sections it regenerates,
        // so the closing IBM mark only lands on the true final slide, exactly as it will after Apply.
        const drafts = new Map(result.sections.map(entry => [entry.section.id, entry.visuals.scenes.length]));
        const counts = editor.document.filter(item => item.type === 'heading' && item.props.scriptSection).map(item => {
          if (drafts.has(item.id)) return { id: item.id, count: drafts.get(item.id) ?? 0 };
          try { return { id: item.id, count: readSectionVisuals(item)?.scenes.length ?? 0 }; }
          catch { return { id: item.id, count: 0 }; }
        });
        const position = counts.findIndex(entry => entry.id === draft.section.id);
        const pageOffset = position < 0 ? 0 : counts.slice(0, position).reduce((sum, entry) => sum + entry.count, 0);
        const totalScenes = position < 0 ? 0 : counts.reduce((sum, entry) => sum + entry.count, 0);
        return <section key={draft.section.id} className="kh-script-visual-review__section">
          <h3>{visualSpokenText(draft.section.content) || `Section ${index + 1}`}</h3>
          <ScriptVisualPreview proposed pageOffset={pageOffset} totalScenes={totalScenes}
            section={{ ...draft.section, props: { ...draft.section.props, scriptVisuals: JSON.stringify(draft.visuals) } }} />
        </section>;
      })}
    </div>
  </AppDialog> : null;
  return { generate, review, dialog, active, submitting, error, status, hasResult: completed.length > 0, loading: query.isPending,
    loadError: query.isError ? describeApiError(query.error) : null };
}
