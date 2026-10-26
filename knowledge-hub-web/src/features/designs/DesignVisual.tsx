import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { announceAthenaJob } from '../../components/athena/AthenaJobNotice';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { noteDraftIdentity } from '../../services/auth';
import { AthenaRibbon } from '../../components/athena/AthenaRibbon';
import { requestCompletionNotifications } from '../../chat/completionNotification';
import type { DesignArtifact, DesignCollaboration, DesignDecision, DesignFeedback } from '../../types/designs';

export interface VisualSelection { artifactId: string; elementId: string; selection: string; choice: string | null }
export interface VisualAnswer { artifactId: string; decisionId: string; question: string; choice: string; consequence: string; note: string }
export interface VisualComment { artifactId: string; elementId: string; selection: string; instruction: string; ref: string }
export type ArtifactMessage =
  | { type: 'annotate'; selection: VisualSelection }
  | { type: 'comment'; comment: VisualComment }
  | { type: 'answer'; answer: VisualAnswer }
  | { type: 'height'; height: number }
  | { type: 'ready' };
const keysAre = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => key in value);
export function readArtifactMessage(data: unknown, artifact: DesignArtifact, token: string): ArtifactMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value['channel'] !== 'athena-design' || value['token'] !== token || value['artifactId'] !== artifact.id || value['revision'] !== artifact.revision) return null;
  const base = ['channel', 'token', 'artifactId', 'revision'];
  const visual = artifact.blueprint;
  if (visual.format !== 'authored-v1') {
    if (typeof value['elementId'] !== 'string' || typeof value['selection'] !== 'string' || value['selection'].length > 8000
      || !(value['choice'] === null || typeof value['choice'] === 'string' && value['choice'].length <= 300)
      || !keysAre(value, [...base, 'elementId', 'selection', 'choice'])) return null;
    const element = visual.elements.find(item => item.id === value['elementId']);
    if (!element || value['choice'] !== null && ![...element.choices, ...element.components.filter(component => component.kind === 'button' && !component.targetId).map(component => component.label)].includes(value['choice'])) return null;
    return { type: 'annotate', selection: { artifactId: artifact.id, elementId: element.id, selection: value['selection'], choice: value['choice'] } };
  }
  switch (value['type']) {
    case 'ready': return keysAre(value, [...base, 'type']) ? { type: 'ready' } : null;
    case 'height': {
      const height = value['height'];
      return keysAre(value, [...base, 'type', 'height']) && typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= 20000 ? { type: 'height', height } : null;
    }
    case 'annotate': {
      if (!keysAre(value, [...base, 'type', 'elementId', 'selection']) || typeof value['selection'] !== 'string' || value['selection'].length > 8000) return null;
      const element = visual.elements.find(item => item.id === value['elementId']);
      return element ? { type: 'annotate', selection: { artifactId: artifact.id, elementId: element.id, selection: value['selection'], choice: null } } : null;
    }
    case 'comment': {
      const { elementId, selection, instruction, ref } = value;
      if (!keysAre(value, [...base, 'type', 'elementId', 'selection', 'instruction', 'ref']) || typeof selection !== 'string' || selection.length > 8000
        || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000 || typeof ref !== 'string' || !/^cm-\d{1,6}$/.test(ref)) return null;
      if (elementId !== 'visual' && !visual.elements.some(item => item.id === elementId)) return null;
      return { type: 'comment', comment: { artifactId: artifact.id, elementId: elementId as string, selection, instruction: instruction.trim(), ref } };
    }
    case 'answer': {
      if (!keysAre(value, [...base, 'type', 'elementId', 'choice', 'note']) || typeof value['note'] !== 'string' || value['note'].length > 2000) return null;
      const decision = visual.decisions.find(item => item.id === value['elementId']);
      const option = decision?.options.find(item => item.label === value['choice']);
      return decision && option ? { type: 'answer', answer: { artifactId: artifact.id, decisionId: decision.id, question: decision.question,
        choice: option.label, consequence: option.consequence, note: value['note'].trim() } } : null;
    }
    default: return null;
  }
}
export const answerInstruction = (answer: VisualAnswer): string =>
  `Decision "${answer.question}": ${answer.choice} — ${answer.consequence}${answer.note ? ` Note: ${answer.note}` : ''}`;
/** Recovers the chosen option of a queued decision answer so the visual can show it again after reload. */
export function answeredChoice(instruction: string, decision: DesignDecision): string | null {
  const prefix = `Decision "${decision.question}": `;
  if (!instruction.startsWith(prefix)) return null;
  return decision.options.find(option => instruction.startsWith(`${prefix}${option.label} — `))?.label ?? null;
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
  onBusyChange: (busy: boolean, status?: string) => void;
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
  const authored = artifact?.blueprint.format === 'authored-v1' ? artifact.blueprint : null;
  const html = useMemo(() => {
    if (!artifact) return '';
    // Seamless embed: content sits on the note column; once the bridge reports height the frame grows and stops scrolling itself.
    const seamless = authored ? '<style>body{padding:0 0 16px;max-width:none}</style><script>addEventListener("load",()=>{document.documentElement.style.overflow="hidden"})</script>' : '';
    return artifact.html.replace('<head>', `<head><meta name="athena-session" content="${token}">${seamless}`);
  }, [artifact, authored, token]);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [focusComposer, setFocusComposer] = useState(0);
  useEffect(() => { setFrameHeight(null); setFrameReady(false); }, [artifact?.id]);
  useEffect(() => { if (focusComposer) composer.current?.focus(); }, [focusComposer]);
  const ack = useCallback((elementId: string, status: string, choice: string | null, message?: string): void => {
    frame.current?.contentWindow?.postMessage({ channel: 'athena-design-ack', token, elementId, status, choice, ...(message ? { message } : {}) }, '*');
  }, [token]);
  const refresh = useCallback(async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['design-collaboration', designId] });
    window.dispatchEvent(new CustomEvent('athena-conversation-updated', { detail: { noteId: parentNoteId } }));
  }, [qc, designId, parentNoteId]);
  const [working, setWorking] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const running = useRef(false);
  // Feedback collects in the queue; Athena applies it only when the user presses Apply. Items added while she works stay queued for the next Apply.
  const applyNow = async (): Promise<void> => {
    if (running.current) return;
    running.current = true; setWorking(true); setApplyError(null);
    requestCompletionNotifications();
    const startedAt = Date.now();
    const here = `${window.location.pathname}${window.location.search}`;
    try {
      requireAccount();
      await prepare();
      const result = requireApiData(await api.applyDesignFeedback(designId));
      await refresh();
      if (result.noteIds.length) await onAccepted();
      announceAthenaJob({ ok: true, tag: `athena-design-${designId}`, startedAt, title: 'Design updated', body: 'Athena has finished your changes to the Blueprint and the spec.', url: here });
    } catch (failure) {
      setApplyError(failure); await refresh().catch(() => undefined);
      announceAthenaJob({ ok: false, tag: `athena-design-${designId}`, startedAt, title: 'Design change failed', body: 'Athena could not finish your changes to the Blueprint. Open it to retry.', url: here });
    }
    finally { running.current = false; setWorking(false); }
  };
  const answer = useMutation({
    mutationFn: async (value: VisualAnswer) => {
      requireAccount();
      const previous = qc.getQueryData<DesignCollaboration>(['design-collaboration', designId])?.feedback
        .filter(item => item.status === 'queued' && item.element_id === value.decisionId) ?? [];
      for (const item of previous) await api.discardDesignFeedback(designId, item.id);
      return requireApiData(await api.queueDesignFeedback(designId, { requestId: crypto.randomUUID(), artifactId: value.artifactId,
        elementId: value.decisionId, selection: '', instruction: answerInstruction(value) }));
    },
    onSuccess: async (_, value) => { ack(value.decisionId, 'queued', value.choice); await refresh(); },
    onError: (failure, value) => { ack(value.decisionId, 'error', value.choice, describeApiError(failure)); },
  });
  const answerRef = useRef(answer.mutate);
  answerRef.current = answer.mutate;
  const comment = useMutation({
    mutationFn: async (value: VisualComment) => {
      requireAccount();
      return requireApiData(await api.queueDesignFeedback(designId, { requestId: crypto.randomUUID(), artifactId: value.artifactId,
        elementId: value.elementId, selection: value.selection, instruction: value.instruction }));
    },
    onSuccess: async (_, value) => { ack(value.ref, 'queued', null); await refresh(); },
    onError: (failure, value) => { ack(value.ref, 'error', null, describeApiError(failure)); },
  });
  const commentRef = useRef(comment.mutate);
  commentRef.current = comment.mutate;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null' || !artifact) return;
      const message = readArtifactMessage(event.data, artifact, token);
      if (!message) return;
      if (message.type === 'ready') setFrameReady(true);
      else if (message.type === 'height') setFrameHeight(Math.max(360, Math.ceil(message.height)));
      else if (message.type === 'answer') answerRef.current(message.answer);
      else if (message.type === 'comment') commentRef.current(message.comment);
      else {
        const { selection } = message;
        setDraft(current => ({ ...current, selection, requestId: crypto.randomUUID(),
          instruction: selection.choice ? `Selected choice: ${selection.choice}` : current.instruction }));
        setFocusComposer(value => value + 1);
      }
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); };
  }, [artifact, token]);
  useEffect(() => {
    if (!frameReady || !authored || !state || !artifact) return;
    const latest = new Map<string, DesignFeedback>();
    for (const item of state.feedback) if (item.artifact_id === artifact.id && authored.decisions.some(decision => decision.id === item.element_id)) latest.set(item.element_id, item);
    for (const [decisionId, item] of latest) {
      const decision = authored.decisions.find(value => value.id === decisionId)!;
      ack(decisionId, item.status, answeredChoice(item.instruction, decision));
    }
  }, [frameReady, authored, state, artifact, ack]);
  const generateStarted = useRef({ at: 0, url: '' });
  const generate = useMutation({
    mutationFn: async () => {
      requireAccount();
      requestCompletionNotifications();
      generateStarted.current = { at: Date.now(), url: `${window.location.pathname}${window.location.search}` };
      setProgress(['Saving current writing before reading the requirements']);
      await prepare();
      return requireApiData(await api.generateDesignArtifact(designId, draft.brief, message => {
        setProgress(current => [...current, message]);
      }));
    },
    onSuccess: async () => {
      await refresh();
      announceAthenaJob({ ok: true, tag: `athena-design-${designId}`, startedAt: generateStarted.current.at, title: 'Blueprint ready', body: 'Athena has finished updating the Blueprint.', url: generateStarted.current.url });
    },
    onError: () => {
      announceAthenaJob({ ok: false, tag: `athena-design-${designId}`, startedAt: generateStarted.current.at, title: 'Blueprint update failed', body: 'Athena could not finish the Blueprint. Open it to retry.', url: generateStarted.current.url });
    },
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
  const [request, setRequest] = useState('');
  const ask = useMutation({
    mutationFn: async () => {
      requireAccount();
      if (!artifact) throw new Error('Create the visual first.');
      return requireApiData(await api.queueDesignFeedback(designId, { requestId: crypto.randomUUID(), artifactId: artifact.id,
        elementId: 'visual', selection: '', instruction: request.trim() }));
    },
    onSuccess: async () => { setRequest(''); await refresh(); },
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
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const edit = useMutation({ mutationFn: async (value: { id: string; text: string }) => {
    requireAccount(); return requireApiData(await api.editDesignFeedback(designId, value.id, value.text.trim()));
  }, onSuccess: async () => { setEditing(null); await refresh(); } });
  const busy = generate.isPending || queue.isPending || ask.isPending || working || resolve.isPending || discard.isPending || edit.isPending;
  const lastStep = progress[progress.length - 1];
  const status = generate.isPending ? `Athena is updating the Blueprint from the latest spec · ${elapsed}s${lastStep ? ` · ${lastStep}` : ''}`
    : working ? 'Athena is applying your changes to the Blueprint and the spec'
      : busy ? 'Saving your Blueprint feedback' : undefined;
  useEffect(() => { onBusyChange(busy, status); }, [busy, status, onBusyChange]);
  useEffect(() => () => { onBusyChange(false); }, [onBusyChange]);
  const error = generate.error ?? queue.error ?? ask.error ?? applyError ?? resolve.error ?? discard.error ?? edit.error;
  if (query.isLoading) return <p className="kh-design-loading" role="status">Loading visual collaboration...</p>;
  if (!state) return <p className="kh-design-loading kh-uc-error" role="alert">{describeApiError(query.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void query.refetch(); }}>Retry</button></p>;
  const waiting = state.feedback.filter(item => item.status === 'queued' || item.status === 'proposed');
  const thread = state.thread ?? [];
  const targetLabel = (elementId: string, instruction: string): string => {
    if (instruction.startsWith('Decision "')) return 'answered a decision';
    if (elementId === 'visual') return 'asked for a change';
    const known = authored ? authored.elements.find(item => item.id === elementId)?.title ?? authored.decisions.find(item => item.id === elementId)?.question : undefined;
    return known ?? (instruction.startsWith('Decision "') ? 'decision' : 'comment');
  };
  const brief = <>
    <label className="kh-uc-field"><span className="kh-uc-field__label">Additional direction (optional)</span>
      <textarea className="kh-uc-input kh-uc-input--area" rows={2} maxLength={8000} value={draft.brief} disabled={busy}
        placeholder="The linked requirements are already included. Add anything Athena should emphasise."
        onChange={event => { setDraft(current => ({ ...current, brief: event.target.value })); }} /></label>
    <button type="button" className={artifact ? 'kh-btn-ghost' : 'kh-btn-accent'} disabled={busy || !!state.proposal}
      onClick={() => { generate.mutate(); }}>{generate.isPending ? 'Athena is writing the Blueprint...' : artifact ? 'Regenerate Blueprint' : 'Create Blueprint'}</button>
  </>;
  return <div className="kh-design-visual">
    <header className="kh-design-visual__intro">
      <h3>Blueprint</h3>
      <p className="kh-design-hint">{artifact
        ? 'Answer the decisions or click any part of the Blueprint to comment. Everything collects in your queue below; nothing changes until you review the queue and press Apply. Every applied change can be undone from note history.'
        : 'Athena explains what this spec does, which steps are automatic and which need you, walks through an example and asks only the decisions the spec leaves open.'}</p>
      {!artifact && brief}
    </header>
    {!!progress.length && (generate.isPending || generate.isError || !artifact) && <section className="kh-design-progress" aria-label="Visual generation progress" aria-busy={generate.isPending}>
      <div className="kh-design-progress__heading">
        {generate.isPending && <AthenaRibbon size={24} mood="thinking" />}
        <strong>{generate.isPending ? `${artifact ? 'Athena is updating the Blueprint from the spec' : 'Athena is writing the Blueprint'} · ${elapsed}s` : generate.isError ? 'Blueprint update stopped' : 'Blueprint updated'}</strong>
      </div>
      <p className="kh-design-hint" role="status" aria-live="polite">{progress[progress.length - 1]}</p>
      <ol>{progress.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ol>
    </section>}
    {state.stale && !generate.isPending && <p className="kh-uc-error" role="alert">{state.sourceError ?? 'The spec has changed since this Blueprint was made. The Blueprint stays as it is until you choose Regenerate Blueprint below.'}</p>}
    {draftError && <p className="kh-uc-error" role="alert">{draftError}</p>}
    {error && <p className="kh-uc-error" role="alert">{describeApiError(error)}</p>}
    {state.proposal && <section className="kh-design-visual__panel kh-design-visual__panel--proposal" aria-label="Athena's proposed spec changes">
      <h3>Athena proposes these spec changes</h3><p>{state.proposal.explanation}</p>
      {state.proposal.changes.map((change, index) => <div className="kh-design-change" key={`${change.noteId}:${index}`}>
        <h4>{artifact?.sources.find(source => source.id === change.noteId)?.title ?? change.noteId} · {change.blockId ? 'replaces a passage' : 'adds a new requirement'}</h4>
        {change.blockId && <details><summary>Current passage</summary><pre>{change.before === null ? '(New writing)' : JSON.stringify(change.before, null, 2)}</pre></details>}
        <h4>Proposed text</h4><pre>{change.markdown}</pre>
      </div>)}
      {state.proposal.previewHtml && <details><summary>Revised visual — not yet accepted</summary>
        <iframe className="kh-design-visual__frame" title="Proposed revised visual" sandbox="allow-scripts" allow="fullscreen" referrerPolicy="no-referrer" srcDoc={state.proposal.previewHtml} /></details>}
      <p className="kh-design-hint">Accepting saves every targeted document with a history checkpoint and replaces the visual, in one step.</p>
      <div className="kh-design-actions"><button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { resolve.mutate(false); }}>Discard proposal</button>
        <button type="button" className="kh-btn-accent" disabled={busy || state.stale} onClick={() => { resolve.mutate(true); }}>{resolve.isPending ? 'Saving...' : 'Accept changes'}</button></div>
    </section>}
    {artifact && <iframe ref={frame} className={`kh-design-visual__frame${authored ? ' kh-design-visual__frame--authored' : ''}`}
      title={`Athena Blueprint: ${artifact.blueprint.title}, revision ${artifact.revision}`} sandbox="allow-scripts" allow="fullscreen" referrerPolicy="no-referrer" srcDoc={html}
      style={frameHeight ? { height: frameHeight } : undefined} />}
    {artifact && <section className="kh-design-thread" aria-label="Conversation with Athena about this visual" aria-busy={working}>
      {!!thread.length && <ol className="kh-design-thread__list">{thread.map(entry => <li key={entry.id} className="kh-design-thread__entry">
        {entry.feedback.map(item => <div key={item.id} className="kh-design-thread__you">
          <p className="kh-design-thread__who">You · {targetLabel(item.element_id, item.instruction)}</p>
          {item.selection && <blockquote>{item.selection}</blockquote>}<p>{item.instruction}</p>
        </div>)}
        <div className="kh-design-thread__athena">
          <p className="kh-design-thread__who">Athena{entry.status === 'accepted' ? ` · saved to ${[...new Set(entry.changes.map(change => change.title))].join(', ')}`
            : entry.changes.length ? ' · not saved' : ' · question'}</p>
          <p>{entry.explanation}</p>
          {entry.status === 'accepted' && !!entry.changes.length && <details><summary>What changed in the spec</summary>
            {entry.changes.map((change, index) => <pre key={`${change.noteId}:${index}`}>{change.markdown}</pre>)}</details>}
        </div>
      </li>)}</ol>}
      {!!waiting.length && <section className="kh-design-queue" aria-label="Your queue for Athena">
        <h4 className="kh-design-queue__title">Your queue · {waiting.length} {waiting.length === 1 ? 'item' : 'items'}</h4>
        <p className="kh-design-hint">{working ? 'Athena is applying these to the spec and the Blueprint.' : 'Review, edit or remove items. Nothing changes until you press Apply.'}</p>
        {waiting.map(item => <div key={item.id} className="kh-design-thread__you kh-design-thread__you--waiting">
          <p className="kh-design-thread__who">You · {targetLabel(item.element_id, item.instruction)}</p>
          {item.selection && <blockquote>{item.selection}</blockquote>}
          {editing?.id === item.id
            ? <>
              <textarea className="kh-uc-input kh-uc-input--area" rows={3} maxLength={8000} value={editing.text} disabled={edit.isPending}
                aria-label="Edit this queued item" autoFocus
                onKeyDown={event => { if (event.key === 'Escape') setEditing(null); else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && editing.text.trim()) { event.preventDefault(); edit.mutate(editing); } }}
                onChange={event => { setEditing({ id: item.id, text: event.target.value }); }} />
              <div className="kh-design-actions">
                <button type="button" className="kh-btn-ghost" disabled={edit.isPending} onClick={() => { setEditing(null); }}>Cancel</button>
                <button type="button" className="kh-btn-accent" disabled={edit.isPending || !editing.text.trim()} onClick={() => { edit.mutate(editing); }}>{edit.isPending ? 'Saving...' : 'Save'}</button>
              </div></>
            : <p>{item.instruction}</p>}
          {!working && item.status === 'queued' && editing?.id !== item.id && <div className="kh-design-actions">
            <button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { setEditing({ id: item.id, text: item.instruction }); }}>Edit</button>
            <button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { discard.mutate(item.id); }}>Remove</button></div>}
        </div>)}
        {working
          ? <p className="kh-design-thread__working" role="status" aria-live="polite"><AthenaRibbon size={24} mood="thinking" />Athena is updating the spec and the Blueprint...</p>
          : <div className="kh-design-actions">
            <button type="button" className="kh-btn-accent" disabled={busy || !!editing || state.stale || !!state.proposal} onClick={() => { void applyNow(); }}>
              Apply {waiting.length} {waiting.length === 1 ? 'change' : 'changes'}</button></div>}
      </section>}
      <form className="kh-design-ask" onSubmit={event => { event.preventDefault(); if (request.trim()) ask.mutate(); }}>
        <label className="kh-uc-field"><span className="kh-uc-field__label">Add to or change this Blueprint</span>
          <textarea className="kh-uc-input kh-uc-input--area" rows={3} maxLength={8000} value={request} disabled={ask.isPending}
            placeholder="For example: add a table of the post scheduling properties, or a mock-up of the publishing queue screen."
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && request.trim()) { event.preventDefault(); ask.mutate(); } }}
            onChange={event => { setRequest(event.target.value); }} /></label>
        <p className="kh-design-hint">Adds the request to your queue. To change one part, click that part of the Blueprint.</p>
        <div className="kh-design-actions"><button type="submit" className="kh-btn-accent" disabled={busy || state.stale || !!state.proposal || !request.trim()}>
          {ask.isPending ? 'Adding...' : 'Add to queue'}</button></div>
      </form>
    </section>}
    {artifact && draft.selection && <section className="kh-design-dock" aria-label="Comment for Athena">
      <div className="kh-design-dock__composer">
        <p className="kh-design-dock__target">Comment on <strong>{targetLabel(draft.selection.elementId, '')}</strong>
          <button type="button" className="kh-btn-ghost" disabled={queue.isPending} onClick={() => { setDraft(current => ({ ...current, selection: null, instruction: '' })); }}>Cancel</button></p>
        {draft.selection.artifactId !== artifact.id && <p className="kh-uc-error" role="alert">This comment points at an older visual. Use Comment on the current visual to retarget it; your text is kept.</p>}
        {draft.selection.selection && <blockquote>{draft.selection.selection}</blockquote>}
        <textarea ref={composer} className="kh-uc-input kh-uc-input--area" rows={2} maxLength={8000} disabled={queue.isPending} value={draft.instruction}
          aria-label="What should Athena change or clarify?" placeholder="What should Athena change or clarify?"
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && draft.instruction.trim()) { event.preventDefault(); queue.mutate(); } }}
          onChange={event => { setDraft(current => ({ ...current, instruction: event.target.value })); }} />
      </div>
      <div className="kh-design-dock__bar">
        <button type="button" className="kh-btn-accent" disabled={queue.isPending || state.stale || !draft.instruction.trim() || draft.selection.artifactId !== artifact.id}
          onClick={() => { queue.mutate(); }}>{queue.isPending ? 'Adding...' : 'Add to queue'}</button>
      </div>
    </section>}
    {artifact && <details className="kh-design-visual__regenerate"><summary>Regenerate the Blueprint</summary>
      <p className="kh-design-hint">Creates a new revision from the current spec. Revision {artifact.revision} stays in history.</p>{brief}</details>}
  </div>;
};
