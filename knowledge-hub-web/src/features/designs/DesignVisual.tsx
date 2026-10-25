import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { noteDraftIdentity } from '../../services/auth';
import type { DesignArtifact } from '../../types/designs';

export interface VisualSelection { artifactId: string; elementId: string; selection: string; choice: string | null }
export function readArtifactMessage(data: unknown, artifact: DesignArtifact, token: string): VisualSelection | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value['channel'] !== 'athena-design' || value['token'] !== token || value['artifactId'] !== artifact.id || value['revision'] !== artifact.revision
    || typeof value['elementId'] !== 'string' || typeof value['selection'] !== 'string' || value['selection'].length > 8000
    || !(value['choice'] === null || typeof value['choice'] === 'string' && value['choice'].length <= 300)
    || Object.keys(value).length !== 7) return null;
  const element = artifact.blueprint.elements.find(item => item.id === value['elementId']);
  if (!element || value['choice'] !== null && ![...element.choices, ...element.components.filter(component => component.kind === 'button' && !component.targetId).map(component => component.label)].includes(value['choice'])) return null;
  return { artifactId: artifact.id, elementId: element.id, selection: value['selection'], choice: value['choice'] };
}
interface Draft { instruction: string; selection: VisualSelection | null; requestId: string; brief: string }
const emptyDraft = (): Draft => ({ instruction: '', selection: null, requestId: crypto.randomUUID(), brief: '' });
function readDraft(key: string): Draft {
  const raw = sessionStorage.getItem(key);
  if (!raw) return emptyDraft();
  if (raw.length > 30000) throw new Error('The retained visual feedback draft is too large.');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('The retained visual feedback draft is malformed.');
  const draft = value as Draft;
  if (typeof draft.instruction !== 'string' || typeof draft.brief !== 'string' || typeof draft.requestId !== 'string'
    || draft.instruction.length > 8000 || draft.brief.length > 8000
    || draft.selection !== null && (!draft.selection || typeof draft.selection.artifactId !== 'string' || typeof draft.selection.elementId !== 'string'
      || typeof draft.selection.selection !== 'string' || draft.selection.selection.length > 8000
      || !(draft.selection.choice === null || typeof draft.selection.choice === 'string'))) throw new Error('The retained visual feedback draft is malformed.');
  return draft;
}
export const DesignVisual: React.FC<{
  designId: string; parentNoteId: string; prepare: () => Promise<void>; onAccepted: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}> = ({ designId, parentNoteId, prepare, onAccepted, onBusyChange }) => {
  const qc = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const [identity] = useState(() => noteDraftIdentity.get());
  const key = `athena-design-feedback:${identity ?? 'signed-out'}:${designId}`;
  const requireAccount = (): void => {
    if (noteDraftIdentity.get() !== identity) throw new Error('The account changed. This feedback draft is retained under its original account; reopen the Design before continuing.');
  };
  const [restored] = useState((): { draft: Draft; error: string | null } => {
    try { return { draft: readDraft(key), error: null }; } catch (error) {
      console.error('[Design] Could not restore visual draft.', error);
      return { draft: emptyDraft(), error: 'The existing local feedback draft could not be restored. Its stored data has not been overwritten. Queue any new feedback before leaving.' };
    }
  });
  const [draftError, setDraftError] = useState<string | null>(restored.error);
  const [draft, setDraft] = useState<Draft>(restored.draft);
  const [progress, setProgress] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (restored.error) return;
    try { sessionStorage.setItem(key, JSON.stringify(draft)); setDraftError(null); }
    catch (error) { console.error('[Design] Could not retain visual draft.', error); setDraftError('This feedback draft could not be retained locally. Send it to the queue before leaving.'); }
  }, [draft, key, restored.error]);
  const query = useQuery({ queryKey: ['design-collaboration', designId], queryFn: async () => requireApiData(await api.designCollaboration(designId)), refetchOnWindowFocus: true });
  const state = query.data;
  const artifact = state?.artifact;
  const [token] = useState(() => crypto.randomUUID());
  const html = useMemo(() => artifact?.html.replace('<head>', `<head><meta name="athena-session" content="${token}">`) ?? '', [artifact, token]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || !artifact) return;
      const selection = readArtifactMessage(event.data, artifact, token);
      if (!selection) return;
      setDraft(current => ({ ...current, selection, requestId: crypto.randomUUID(),
        instruction: selection.choice ? `Selected choice: ${selection.choice}` : current.instruction }));
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); };
  }, [artifact, token]);
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['design-collaboration', designId] });
    window.dispatchEvent(new CustomEvent('athena-conversation-updated', { detail: { noteId: parentNoteId } }));
  };
  const generate = useMutation({
    mutationFn: async () => {
      requireAccount();
      setProgress(['Saving current writing before reading the requirements']);
      await prepare();
      return requireApiData(await api.generateDesignArtifact(designId, draft.brief, message => {
        setProgress(current => [...current, message]);
      }));
    },
    onSuccess: refresh,
  });
  useEffect(() => {
    if (!generate.isPending) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => { setElapsed(Math.floor((Date.now() - started) / 1000)); }, 1000);
    return () => { clearInterval(timer); };
  }, [generate.isPending]);
  const queue = useMutation({
    mutationFn: async () => {
      requireAccount();
      if (!draft.selection) throw new Error('Select an element or passage in the visual first.');
      return requireApiData(await api.queueDesignFeedback(designId, { requestId: draft.requestId, artifactId: draft.selection.artifactId,
        elementId: draft.selection.elementId, selection: draft.selection.selection, instruction: draft.instruction }));
    },
    onSuccess: async () => { setDraft(current => ({ ...current, instruction: '', selection: null, requestId: crypto.randomUUID() })); await refresh(); },
  });
  const propose = useMutation({
    mutationFn: async () => { requireAccount(); await prepare(); return requireApiData(await api.proposeDesignFeedback(designId)); },
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: async (accept: boolean) => {
      requireAccount();
      if (!state?.proposal) throw new Error('No pending proposal.');
      if (accept) await prepare();
      return requireApiData(await api.resolveDesignProposal(designId, state.proposal.id, accept));
    },
    onSuccess: async (_, accepted) => { await refresh(); if (accepted) await onAccepted(); },
  });
  const discard = useMutation({ mutationFn: async (feedbackId: string) => {
    requireAccount(); return requireApiData(await api.discardDesignFeedback(designId, feedbackId));
  }, onSuccess: refresh });
  const busy = generate.isPending || queue.isPending || propose.isPending || resolve.isPending || discard.isPending;
  useEffect(() => { onBusyChange(busy); return () => { onBusyChange(false); }; }, [busy, onBusyChange]);
  const error = generate.error ?? queue.error ?? propose.error ?? resolve.error ?? discard.error;
  if (query.isLoading) return <p className="kh-design-loading" role="status">Loading visual collaboration...</p>;
  if (!state) return <p className="kh-design-loading kh-uc-error" role="alert">{describeApiError(query.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void query.refetch(); }}>Retry</button></p>;
  const pending = state.feedback.filter(item => item.status === 'queued' || item.status === 'proposed');
  return <div className="kh-design-visual">
    <div className="kh-design-visual__controls">
      <h3>Visual collaboration with Athena</h3>
      <p className="kh-design-hint">Athena turns the linked requirements into an interactive visual. Explore it, select text or controls and develop changes with Athena, then accept the proposed updates to the original Markdown.</p>
      <label className="kh-uc-field"><span className="kh-uc-field__label">Additional direction (optional)</span>
        <textarea className="kh-uc-input kh-uc-input--area" rows={2} maxLength={8000} value={draft.brief} disabled={busy}
          placeholder="The linked requirements are already included. Add a particular screen, journey or question to focus on."
          onChange={event => { setDraft(current => ({ ...current, brief: event.target.value })); }} /></label>
      <button type="button" className="kh-btn-accent" disabled={busy || !!state.proposal}
        onClick={() => { generate.mutate(); }}>{generate.isPending ? 'Creating interactive visual...' : artifact ? 'Regenerate interactive visual' : 'Create interactive visual'}</button>
      {!!progress.length && <section className="kh-design-progress" aria-label="Visual generation progress" aria-busy={generate.isPending}>
        <div className="kh-design-progress__heading">
          {generate.isPending && <span className="kh-design-progress__animation" aria-hidden="true" />}
          <strong>{generate.isPending ? `Athena is creating the visual · ${elapsed}s` : generate.isError ? 'Visual creation stopped' : 'Interactive visual created'}</strong>
        </div>
        <p className="kh-design-hint" role="status" aria-live="polite">{progress[progress.length - 1]}</p>
        <ol>{progress.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ol>
      </section>}
      {state.stale && <p className="kh-uc-error" role="alert">{state.sourceError ?? 'Sources changed. This artifact is stale; regenerate before applying feedback or exporting.'}</p>}
      {draftError && <p className="kh-uc-error" role="alert">{draftError}</p>}
      {error && <p className="kh-uc-error" role="alert">{describeApiError(error)}</p>}
    </div>
    {artifact && <iframe ref={frame} className="kh-design-visual__frame" title={`Interactive design: ${artifact.blueprint.title}, revision ${artifact.revision}`}
      sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} />}
    {draft.selection && <section className="kh-design-visual__controls" aria-label="Visual feedback">
      <h3>Feedback on {draft.selection.elementId}</h3>
      {draft.selection.artifactId !== artifact?.id && <p className="kh-uc-error" role="alert">This target belongs to an older artifact. Select its current element to retarget; your instruction is retained.</p>}
      {draft.selection.selection && <blockquote>{draft.selection.selection}</blockquote>}
      <label className="kh-uc-field"><span className="kh-uc-field__label">What should Athena change or clarify?</span>
        <textarea className="kh-uc-input kh-uc-input--area" rows={3} maxLength={8000} disabled={busy} value={draft.instruction}
          onChange={event => { setDraft(current => ({ ...current, instruction: event.target.value })); }} /></label>
      <button type="button" className="kh-btn-accent" disabled={busy || state.stale || !draft.instruction.trim() || draft.selection.artifactId !== artifact?.id}
        onClick={() => { queue.mutate(); }}>{queue.isPending ? 'Queueing...' : 'Queue for Athena'}</button>
    </section>}
    {!!pending.length && <section className="kh-design-visual__controls" aria-label="Queued visual feedback">
      <h3>Feedback queue</h3>
      <ul className="kh-design-feedback">{pending.map(item => <li key={item.id}>
        <p><strong>{item.element_id}</strong> · {item.status}{item.artifact_id !== artifact?.id ? ' · older artifact — unresolved target' : ''}</p>
        {item.selection && <blockquote>{item.selection}</blockquote>}<p>{item.instruction}</p>
        {item.status === 'queued' && <button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { discard.mutate(item.id); }}>Discard feedback</button>}
      </li>)}</ul>
      <button type="button" className="kh-btn-accent" disabled={busy || state.stale || !!state.proposal || !pending.some(item => item.status === 'queued' && item.artifact_id === artifact?.id)}
        onClick={() => { propose.mutate(); }}>{propose.isPending ? 'Athena is preparing changes...' : 'Ask Athena to propose Markdown changes'}</button>
    </section>}
    {state.proposal && <section className="kh-design-visual__controls" aria-label="Athena Markdown proposal">
      <h3>Review Markdown changes</h3><p>{state.proposal.explanation}</p>
      {state.proposal.changes.map((change, index) => <div className="kh-design-change" key={`${change.noteId}:${index}`}>
        <h4>{artifact?.sources.find(source => source.id === change.noteId)?.title ?? change.noteId}</h4>
        <p>{change.blockId ? 'Replace the anchored block' : 'Append a new requirement'}</p>
        <details><summary>Original block</summary><pre>{change.before === null ? '(New writing)' : JSON.stringify(change.before, null, 2)}</pre></details>
        <h4>Proposed Markdown</h4><pre>{change.markdown}</pre>
      </div>)}
      {state.proposal.previewHtml && <details><summary>Revised visual — not yet accepted</summary>
        <iframe className="kh-design-visual__frame" title="Proposed revised visual" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={state.proposal.previewHtml} /></details>}
      <p className="kh-design-hint">Acceptance saves all targeted originals with history checkpoints and the revised shared visual in one transaction.</p>
      <div className="kh-design-actions"><button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { resolve.mutate(false); }}>Discard proposal</button>
        <button type="button" className="kh-btn-accent" disabled={busy || state.stale} onClick={() => { resolve.mutate(true); }}>{resolve.isPending ? 'Saving...' : 'Accept all changes'}</button></div>
    </section>}
  </div>;
};
