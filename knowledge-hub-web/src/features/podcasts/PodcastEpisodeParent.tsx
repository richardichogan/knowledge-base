import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { extractNoteBlockText, fetchNote, type NoteContentBlock } from '../../notes/noteStorage';
import { athenaLinkText } from '../../notes/linkLabels';
import { deferredView } from '../../utils/deferredView';
import { setPodcastChatBridge } from '../../utils/activeBlockNoteEditor';
import { parseScriptBullets, SCRIPT_BULLET as BULLET, scriptSentenceLines } from './scriptFormatting';
import { useAthenaContext } from '../../context/AthenaContext';
import { confirmDialog } from '../../services/appDialogs';
import { rememberAgentJob, useAgentJobs } from '../../services/agentJobStore';
import { isActiveAgentJob } from '../../types/agentJobs';
import { requestCompletionNotifications } from '../../chat/completionNotification';
import { AthenaRibbon } from '../../components/athena/AthenaRibbon';
import { PodcastCampaign } from '../../notes/PodcastCampaign';
import type { NoteDocument } from '../../notes/types';
import { PODCAST_EPISODE_TABS, type PodcastEpisode, type PodcastEpisodeTab, type ScriptCard } from '../../types/podcastEpisodes';

const NoteEditor = deferredView('Podcast episode', async () => ({ default: (await import('../../notes/NoteEditor')).NoteEditor }));
const AIChatPage = deferredView('Athena', async () => ({ default: (await import('../../pages/AIChatPage')).AIChatPage }));
const isTab = (value: string | null): value is PodcastEpisodeTab => PODCAST_EPISODE_TABS.some(tab => tab.key === value);
const SHOW_NOTES_PROMPT = 'Draft the show notes for this episode from the attached transcript.';
const HIDDEN = 'cds--visually-hidden';
const newCard = (): ScriptCard => ({ id: crypto.randomUUID(), title: '', synopsis: '', bullets: [] });
const formatDate = (value: string | null): string => value
  ? new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'Not set';

export const PodcastEpisodeParent: React.FC<{
  id: string; actionsSlot: HTMLElement | null; workspaceBusy?: boolean; onOpenNote: (id: string) => void; onOpenMap: (id: string) => void;
  onPresent?: (() => void) | undefined; onStopPresenting?: (() => void) | undefined;
}> = ({ id, actionsSlot, workspaceBusy = false, onOpenNote, onOpenMap, onPresent, onStopPresenting }) => {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const initialTab = params.get('tab');
  const [tab, setTab] = useState<PodcastEpisodeTab>(isTab(initialTab) ? initialTab : 'prep');
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageBusy, setStageBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [scriptChatBusy, setScriptChatBusy] = useState(false);
  const scriptChatBusyRef = useRef(false);
  const [showNotesPrompt, setShowNotesPrompt] = useState<{ prompt: string; sequence: number } | undefined>();
  const noteSave = useRef<(() => Promise<boolean>) | null>(null);
  const scriptSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerSave = useCallback((save: (() => Promise<boolean>) | null) => { noteSave.current = save; }, []);
  const registerScriptSave = useCallback((save: (() => Promise<boolean>) | null) => { scriptSave.current = save; }, []);
  const uid = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const query = useQuery({ queryKey: ['podcast-episode', id], queryFn: async () => requireApiData(await api.getPodcastEpisode(id)) });
  const episode = query.data;
  const { jobs: liveJobs } = useAgentJobs(id);
  const history = useQuery({ queryKey: ['podcast-script-jobs', id],
    queryFn: async () => requireApiData(await api.listPodcastScriptJobs(id)),
    refetchInterval: query => query.state.data?.some(isActiveAgentJob) ? 5_000 : false });
  const scriptJobMap = new Map((history.data ?? []).map(job => [job.id, job]));
  for (const job of liveJobs) {
    const previous = scriptJobMap.get(job.id);
    if (!previous || isActiveAgentJob(previous) || !isActiveAgentJob(job)) scriptJobMap.set(job.id, job);
  }
  const scriptJobs = [...scriptJobMap.values()]
    .filter(job => job.specialist === 'podcast-script-writer')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeScriptJob = scriptJobs.find(isActiveAgentJob);
  const latestScriptJob = activeScriptJob ?? scriptJobs[0];
  const scriptJobId = latestScriptJob?.id;
  const scriptJobStatus = latestScriptJob?.status;
  useEffect(() => {
    if (!scriptJobId || (scriptJobStatus !== 'done' && scriptJobStatus !== 'failed')) return;
    void qc.invalidateQueries({ queryKey: ['podcast-episode', id] });
    void qc.invalidateQueries({ queryKey: ['podcast-script-jobs', id] });
  }, [id, qc, scriptJobId, scriptJobStatus]);
  const setEpisode = useCallback((next: PodcastEpisode) => { qc.setQueryData(['podcast-episode', id], next); }, [id, qc]);
  const showNotesId = episode?.showNotesNoteId ?? null;
  const documentId = (tab === 'show_notes' || tab === 'campaign') && showNotesId ? showNotesId : id;
  const document = useQuery({
    queryKey: ['podcast-episode-document', documentId],
    queryFn: async () => { const doc = await fetchNote(documentId); if (!doc) throw new Error('The document is unavailable.'); return doc; },
    enabled: !!episode, refetchOnWindowFocus: false, staleTime: 30_000,
  });
  const busy = stageBusy || chatBusy || scriptChatBusy || workspaceBusy;
  const { pageContext, setAthenaContext } = useAthenaContext();
  useEffect(() => {
    if (!document.data || !episode) return;
    const note = document.data;
    let detail = '';
    try {
      const blocks: unknown = JSON.parse(note.contentJson);
      if (Array.isArray(blocks)) detail = extractNoteBlockText(blocks as NoteContentBlock[], athenaLinkText);
    } catch { /* an unreadable body stays out of the context */ }
    const scriptContext = `Podcast episode: ${episode.title}\nActive stage: ${tab}\nEpisode ID: ${id}\nScript revision: ${episode.revision}\n`
      + `Intro:\n${episode.scriptIntro}\nTopic cards (IDs and titles):\n${episode.scriptCards.map(card => `${card.id}: ${card.title}`).join('\n')}\n`
      + `Use read_podcast_script for current complete card text and duration estimates; the parent note body is not the script.\n`
      + `Script worker: ${activeScriptJob ? `${activeScriptJob.status}: ${activeScriptJob.progress.at(-1) ?? 'Waiting for a worker'}` : 'No active script worker'}\n`;
    setAthenaContext({ type: 'note', id: note.id, conversationId: id, podcastEpisodeId: id, podcastTab: tab,
      title: note.title, detail: `${scriptContext}\nActive document body:\n${detail}`, ...(note.projectId ? { projectId: note.projectId } : {}) });
  }, [document.data, episode, tab, id, activeScriptJob, setAthenaContext]);
  useEffect(() => () => { setAthenaContext(null); }, [setAthenaContext]);

  const prepare = useCallback(async (): Promise<void> => {
    if (noteSave.current && !await noteSave.current()) throw new Error('The document could not be saved. Your draft remains available; retry before continuing.');
    if (scriptSave.current && !await scriptSave.current()) throw new Error('The script could not be saved. Your cards remain available; retry before continuing.');
  }, []);
  useEffect(() => setPodcastChatBridge(id, async () => {
    if (scriptChatBusyRef.current || stageBusy) {
      throw new Error('Finish the current episode operation before sending another script request.');
    }
    scriptChatBusyRef.current = true;
    setScriptChatBusy(true);
    try { await prepare(); }
    catch (err) { scriptChatBusyRef.current = false; setScriptChatBusy(false); throw err; }
    return async () => {
      try {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['podcast-episode', id] }),
          qc.invalidateQueries({ queryKey: ['podcast-script-jobs', id] }),
        ]);
      } finally { scriptChatBusyRef.current = false; setScriptChatBusy(false); }
    };
  }), [id, prepare, qc, stageBusy]);
  const switchTo = async (next: PodcastEpisodeTab): Promise<void> => {
    if (switching || busy || next === tab) return;
    setSwitching(true); setError(null);
    try {
      await prepare();
      setTab(next);
      setParams(previous => { const updated = new URLSearchParams(previous); updated.set('episode', id); updated.set('tab', next); return updated; }, { replace: true });
    } catch (err) { setError(describeApiError(err)); }
    finally { setSwitching(false); }
  };
  const runStage = async (action: () => Promise<PodcastEpisode>, failure: string): Promise<PodcastEpisode | null> => {
    setStageBusy(true); setError(null);
    try { const next = await action(); setEpisode(next); return next; }
    catch (err) { setError(`${failure} ${describeApiError(err)}`); return null; }
    finally { setStageBusy(false); }
  };
  const saved = (note: NoteDocument): void => {
    qc.setQueryData(['podcast-episode-document', note.id], note);
    void qc.invalidateQueries({ queryKey: ['notes-list'] });
    if (note.id === id) {
      void qc.invalidateQueries({ queryKey: ['podcast-episode', id] });
      if (note.contentType !== 'podcast-episode') onOpenNote(note.id);
    }
  };

  if (query.isLoading) return <p className="kh-design-loading" role="status">Loading episode...</p>;
  if (!episode) return <p className="kh-design-loading kh-uc-error" role="alert">{describeApiError(query.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void query.refetch(); }}>Retry</button></p>;

  const stages: Array<{ label: string; done: boolean }> = [
    { label: 'Prep', done: !!episode.prepSessionId },
    { label: 'Script', done: episode.scriptCards.length > 0 || !!episode.scriptIntro },
    { label: 'Transcript', done: !!episode.transcript },
    { label: 'Show Notes', done: !!episode.showNotesNoteId },
  ];
  const episodePanel = <div className="kh-design-work">
    <section aria-label="Episode details">
      <h3>Episode</h3>
      <dl className="kh-episode-facts">
        <dt>Number</dt><dd>{episode.episodeNumber ?? 'Not set'}</dd>
        <dt>Recording</dt><dd>{formatDate(episode.recordingDate)}</dd>
      </dl>
      <p>Edit the title to change the episode number or name.</p>
    </section>
    <section aria-label="Episode progress">
      <h3>Progress</h3>
      <ul className="kh-episode-stages">{stages.map(stage => <li key={stage.label} data-done={stage.done}>
        <span className="kh-episode-stages__dot" aria-hidden="true" />{stage.label}<span className={HIDDEN}>{stage.done ? ', complete' : ', not started'}</span>
      </li>)}</ul>
    </section>
  </div>;

  const chrome = <div className="kh-design-chrome">
    <div className="kh-design-tabs" role="tablist" aria-label="Episode stages" ref={tabsRef} onKeyDown={event => {
      const count = PODCAST_EPISODE_TABS.length;
      const index = PODCAST_EPISODE_TABS.findIndex(item => item.key === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % count : event.key === 'ArrowLeft' ? (index + count - 1) % count
        : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
      if (next === null) return;
      event.preventDefault(); void switchTo(PODCAST_EPISODE_TABS[next]!.key);
      tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{PODCAST_EPISODE_TABS.map(item => <button key={item.key} type="button" role="tab" id={`${uid}-${item.key}`} aria-selected={tab === item.key}
      aria-controls={`${uid}-document`} tabIndex={tab === item.key ? 0 : -1} disabled={switching || busy}
      onClick={() => { void switchTo(item.key); }}>{item.label}</button>)}</div>
    {stageBusy && <p className="kh-design-hint kh-design-hint--busy" role="status"><AthenaRibbon size={20} mood="thinking" />Athena is working on this episode...</p>}
    {activeScriptJob && <p className="kh-design-hint kh-design-hint--busy" role="status"><AthenaRibbon size={20} mood="thinking" />
      {activeScriptJob.progress.at(-1) ?? 'Script generation is queued.'} You can leave this episode; Athena will notify you when it finishes.</p>}
    {latestScriptJob?.status === 'failed' && <p role="alert" className="kh-uc-error">{latestScriptJob.error ?? 'The script worker could not finish. Retry Draft script from prep.'}</p>}
    {history.isError && <p role="alert" className="kh-uc-error">Script job status is unavailable. {describeApiError(history.error)}{' '}
      <button type="button" className="kh-btn-ghost" onClick={() => { void history.refetch(); }}>Retry</button></p>}
    {error && <p role="alert" className="kh-uc-error">{error}</p>}
  </div>;

  let body: React.ReactNode;
  if (tab === 'prep') {
    body = episode.prepSessionId
      ? <div className="kh-episode-chat"><AIChatPage compact fixedSessionId={episode.prepSessionId} initialPersona="podcast_prep"
        pageContext={pageContext?.podcastEpisodeId === id ? pageContext : undefined} onBusyChange={setChatBusy} /></div>
      : <section className="kh-design-diagram-empty" aria-label="Prep"><h3>No prep conversation</h3>
        <p>This episode was not created from a Thursday prep run, so there is no prep conversation to show.</p></section>;
  } else if (tab === 'script') {
    body = <ScriptEditor key={episode.noteId} episode={episode} busy={busy || switching || !!activeScriptJob} draftUnavailable={history.isPending || history.isError}
      onSaved={setEpisode} registerSave={registerScriptSave} onPresent={onPresent}
      onDraft={async () => {
        if ((episode.scriptCards.length || episode.scriptIntro) && !await confirmDialog('Drafting from prep replaces the intro and every card in the current script.',
          { title: 'Replace the script?', confirmLabel: 'Replace script', tone: 'danger' })) return;
        requestCompletionNotifications();
        setStageBusy(true); setError(null);
        try {
          await prepare();
          const result = requireApiData(await api.draftPodcastScript(id, episode.revision, true));
          if (result.status === 'needs_confirmation') throw new Error(result.message);
          rememberAgentJob(result.job);
          void qc.invalidateQueries({ queryKey: ['podcast-script-jobs', id] });
        } catch (err) { setError(`The script job was not started. ${describeApiError(err)}`); }
        finally { setStageBusy(false); }
      }} />;
  } else if (tab === 'transcript') {
    body = <TranscriptPanel episode={episode} busy={busy || switching}
      onUpload={file => { void runStage(async () => requireApiData(await api.uploadPodcastTranscript(id, file, episode.revision)), 'The transcript was not uploaded.'); }} />;
  } else if (tab === 'show_notes' && !showNotesId) {
    body = !episode.transcript
      ? <section className="kh-design-diagram-empty" aria-label="Show notes"><h3>Upload the transcript first</h3>
        <p>Show notes are drafted from the Riverside transcript only. Upload it on the Transcript tab.</p></section>
      : !episode.showNotesSessionId
        ? <section className="kh-design-diagram-empty" aria-label="Show notes"><h3>Draft show notes</h3>
          <p>Athena drafts the show notes from the transcript in a conversation you can refine before saving them to this episode.</p>
          <button type="button" className="kh-btn-accent" disabled={busy} onClick={() => {
            void runStage(async () => requireApiData(await api.startPodcastShowNotes(id)), 'The show notes conversation was not started.')
              .then(next => { if (next) setShowNotesPrompt({ prompt: SHOW_NOTES_PROMPT, sequence: Date.now() }); });
          }}>Draft show notes</button></section>
        : <div className="kh-episode-chat">
          <div className="kh-episode-chat__bar">
            <p className="kh-design-hint">Refine the draft with Athena, then save it to this episode.</p>
            <button type="button" className="kh-btn-accent" disabled={busy} onClick={() => {
              void runStage(async () => requireApiData(await api.savePodcastShowNotes(id, episode.revision)), 'The show notes were not saved.')
                .then(next => { if (next) void qc.invalidateQueries({ queryKey: ['notes-list'] }); });
            }}>Save show notes to this episode</button>
          </div>
          <AIChatPage compact fixedSessionId={episode.showNotesSessionId} initialPersona="podcast_show_notes"
            pageContext={{ type: 'document', title: episode.transcriptFilename ?? 'Episode transcript', detail: episode.transcript }}
            promptRequest={showNotesPrompt}
            onBusyChange={value => { setChatBusy(value); if (value) setShowNotesPrompt(undefined); }} />
        </div>;
  } else if (tab === 'campaign') {
    body = showNotesId && document.data?.id === showNotesId
      ? <div className="kh-episode-campaign"><PodcastCampaign key={showNotesId} noteId={showNotesId} noteRevision={document.data.revision ?? 0}
        beforePrepare={async () => noteSave.current ? noteSave.current() : true} /></div>
      : <section className="kh-design-diagram-empty" aria-label="Campaign"><h3>Save show notes first</h3>
        <p>The campaign is built from this episode's show notes. Draft and save them on the Show Notes tab.</p></section>;
  }

  return <div className="kh-design-parent" role="tabpanel" id={`${uid}-document`} aria-labelledby={`${uid}-${tab}`}>
    {!document.data ? <>{chrome}<p className="kh-design-loading" role={document.isError ? 'alert' : 'status'}>
      {document.isError ? describeApiError(document.error) : 'Loading episode...'}
      {document.isError && <button className="kh-btn-ghost" type="button" onClick={() => { void document.refetch(); }}>Retry</button>}</p></>
      : <NoteEditor key={document.data.id} doc={document.data} onSaved={saved} actionsSlot={actionsSlot} externalBusy={busy || switching} loading={switching}
        onOpenMap={onOpenMap} onSaveReady={registerSave} onBeforeViewChange={prepare} headerContent={chrome}
        designPanel={episodePanel} designPanelLabel="Episode" bodyContent={body} onPresent={onPresent} onStopPresenting={onStopPresenting} />}
  </div>;
};

/** Grows to fit its content so the whole field is always visible. */
const AutoTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement> & { inputRef?: React.MutableRefObject<HTMLTextAreaElement | null> }> = ({ inputRef, className, ...props }) => {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fit = useCallback((): void => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, []);
  useLayoutEffect(fit, [fit, props.value]);
  useEffect(() => {
    const el = own.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; fit(); } });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, [fit]);
  return <textarea {...props} rows={1} className={`kh-uc-input kh-uc-input--area kh-episode-autosize${className ? ` ${className}` : ''}`}
    ref={el => { own.current = el; if (inputRef) inputRef.current = el; }} />;
};

interface ScriptPassage { text: string; start: number; end: number; original: string }
type PassageAction = 'Rewrite' | 'Rephrase' | 'Add specific content';
type AskPassage = (passage: ScriptPassage, action: PassageAction, instruction: string) => Promise<void>;

const PassageTextarea: React.FC<React.ComponentProps<typeof AutoTextarea> & { onAsk: AskPassage }> = ({ onAsk, ...props }) => {
  const [selection, setSelection] = useState<ScriptPassage | null>(null);
  const [adding, setAdding] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = typeof props.value === 'string' ? props.value : '';
  const selected = selection && scriptSentenceLines(selection.original) === scriptSentenceLines(value) ? selection : null;
  const ask = async (action: PassageAction): Promise<void> => {
    if (!selected || pending || props.disabled) return;
    setPending(true); setError(null);
    try { await onAsk(selected, action, instruction.trim()); setSelection(null); setAdding(false); setInstruction(''); }
    catch (err) { setError(describeApiError(err)); }
    finally { setPending(false); }
  };
  return <div className="kh-episode-passage" aria-busy={pending}
    onKeyDown={event => { if (event.key === 'Escape') { setSelection(null); setAdding(false); } }}>
    <AutoTextarea {...props} onSelect={event => {
      props.onSelect?.(event);
      const el = event.currentTarget;
      const text = el.value.slice(el.selectionStart, el.selectionEnd);
      setSelection(text.trim() ? { text, start: el.selectionStart, end: el.selectionEnd, original: el.value } : null);
      setAdding(false); setError(null);
    }} />
    {selected && <div className="kh-episode-passage__actions" role="group" aria-label="Ask Athena about selected text">
      <span className="kh-episode-passage__label">Selected text</span>
      {(['Rewrite', 'Rephrase'] as const).map(action => <button key={action} type="button" className="kh-btn-ghost"
        disabled={props.disabled || pending} onMouseDown={event => { event.preventDefault(); }}
        onClick={() => { void ask(action); }}>{action}</button>)}
      <button type="button" className="kh-btn-ghost" disabled={props.disabled || pending}
        onMouseDown={event => { event.preventDefault(); }} onClick={() => { setAdding(true); }}>Add specific content</button>
      {adding && <div className="kh-episode-passage__instruction">
        <label className="kh-uc-field"><span className="kh-uc-field__label">What should Athena add?</span>
          <input className="kh-uc-input" value={instruction} maxLength={2000} disabled={pending || props.disabled}
            onChange={event => { setInstruction(event.target.value); }} /></label>
        <button type="button" className="kh-btn-accent" disabled={pending || props.disabled || !instruction.trim()}
          onClick={() => { void ask('Add specific content'); }}>Ask Athena</button>
      </div>}
      <span className="kh-episode-passage__hint" role="status">{pending ? 'Saving script and preparing Athena...' : 'Opens a request in Athena for you to send.'}</span>
    </div>}
    {error && <p role="alert" className="kh-uc-error">{error}</p>}
  </div>;
};

const BulletsField: React.FC<{ bullets: string[]; disabled: boolean; label: string; onChange: (bullets: string[]) => void; onAsk: AskPassage }> = ({ bullets, disabled, label, onChange, onAsk }) => {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const caret = useRef<number | null>(null);
  const value = bullets.map(item => BULLET + item).join('\n\n');
  useLayoutEffect(() => {
    if (caret.current !== null && input.current && document.activeElement === input.current) input.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  const edit = (raw: string, position: number): void => {
    const parsed = parseScriptBullets(raw, position);
    caret.current = parsed.caret;
    onChange(parsed.bullets);
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = event.currentTarget;
    const pos = el.selectionStart;
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const inserted = event.shiftKey ? '\n' : `\n\n${BULLET}`;
      edit(value.slice(0, pos) + inserted + value.slice(el.selectionEnd), pos + inserted.length);
      return;
    }
    if (pos !== el.selectionEnd || (event.key !== 'Backspace' && event.key !== 'Delete')) return;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = value.indexOf('\n', pos) === -1 ? value.length : value.indexOf('\n', pos);
    // Deleting across a bullet marker joins the two bullet points instead of leaving a stray marker in the text.
    if (event.key === 'Backspace' && value.startsWith(BULLET, lineStart) && pos === lineStart + BULLET.length) {
      event.preventDefault();
      if (lineStart === 0) { if (bullets.length === 1 && !bullets[0]) onChange([]); return; }
      const previousEnd = value.slice(0, lineStart).replace(/\n+$/, '').length;
      edit(value.slice(0, previousEnd) + value.slice(pos), previousEnd);
    } else if (event.key === 'Delete' && pos === lineEnd && /^\n+• /.test(value.slice(pos))) {
      event.preventDefault();
      edit(value.slice(0, pos) + value.slice(pos).replace(/^\n+• /, ''), pos);
    }
  };
  const fieldId = useId();
  return <div className="kh-uc-field"><label htmlFor={fieldId} className="kh-uc-field__label">{label}</label>
    <PassageTextarea id={fieldId} inputRef={input} value={value} disabled={disabled} onAsk={onAsk}
      placeholder={`${BULLET}Add a bullet point`} onKeyDown={keyDown}
      onChange={event => { edit(event.target.value, event.target.selectionStart); }} />
    <span className="kh-episode-passage__hint">Enter starts a bullet; Shift+Enter adds a line within it.</span>
  </div>;
};

function formatCards(cards: ScriptCard[]): ScriptCard[] {
  return cards.map(card => ({ ...card, synopsis: scriptSentenceLines(card.synopsis), bullets: card.bullets.map(scriptSentenceLines) }));
}

const ScriptEditor: React.FC<{
  episode: PodcastEpisode; busy: boolean; draftUnavailable: boolean; onSaved: (episode: PodcastEpisode) => void;
  registerSave: (save: (() => Promise<boolean>) | null) => void; onDraft: () => Promise<void>; onPresent?: (() => void) | undefined;
}> = ({ episode, busy, draftUnavailable, onSaved, registerSave, onDraft, onPresent }) => {
  const [intro, setIntro] = useState(() => scriptSentenceLines(episode.scriptIntro));
  const [cards, setCards] = useState<ScriptCard[]>(() => formatCards(episode.scriptCards));
  const { openAthena, pageContext } = useAthenaContext();
  const introId = useId();
  const synopsisId = useId();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [cardDragAllowed, setCardDragAllowed] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const edits = useRef(0);
  const revision = useRef(episode.revision);
  const persisted = useRef({ intro: episode.scriptIntro, cards: episode.scriptCards });
  const inFlight = useRef<Promise<boolean> | null>(null);
  const ownSave = useRef(false);
  const state = useRef({ intro, cards, dirty });
  state.current = { intro, cards, dirty };
  useEffect(() => { revision.current = Math.max(revision.current, episode.revision); }, [episode.revision]);
  useEffect(() => {
    if (ownSave.current) { ownSave.current = false; return; }
    persisted.current = { intro: episode.scriptIntro, cards: episode.scriptCards };
    if (!dirty) { setIntro(scriptSentenceLines(episode.scriptIntro)); setCards(formatCards(episode.scriptCards)); }
  }, [episode.scriptIntro, episode.scriptCards, dirty]);
  const touch = (): void => { edits.current += 1; setDirty(true); };
  const save = useCallback(async (): Promise<boolean> => {
    while (inFlight.current) { const ok = await inFlight.current; if (!ok) return false; }
    if (!state.current.dirty && state.current.intro === persisted.current.intro
      && JSON.stringify(state.current.cards) === JSON.stringify(persisted.current.cards)) return true;
    const run = (async (): Promise<boolean> => {
      const version = edits.current;
      setSaving(true); setError(null);
      try {
        const cleaned = formatCards(state.current.cards).map(card => ({ ...card, bullets: card.bullets.filter(Boolean) }));
        const next = requireApiData(await api.savePodcastScript(episode.noteId, scriptSentenceLines(state.current.intro), cleaned, revision.current));
        revision.current = next.revision;
        persisted.current = { intro: next.scriptIntro, cards: next.scriptCards };
        ownSave.current = true;
        if (edits.current === version) { setIntro(scriptSentenceLines(next.scriptIntro)); setCards(formatCards(next.scriptCards)); setDirty(false); }
        onSaved(next); return true;
      } catch (err) { setError(`The script was not saved. ${describeApiError(err)}`); return false; }
      finally { setSaving(false); }
    })();
    inFlight.current = run;
    try { return await run; } finally { inFlight.current = null; }
  }, [episode.noteId, onSaved]);
  useEffect(() => { registerSave(save); return () => { registerSave(null); }; }, [registerSave, save]);
  useEffect(() => {
    if (!dirty || error) return;
    const timer = window.setTimeout(() => { void save(); }, 3000);
    return () => { window.clearTimeout(timer); };
  }, [intro, cards, dirty, error, save]);
  const update = (index: number, patch: Partial<ScriptCard>): void => {
    setCards(previous => previous.map((card, i) => i === index ? { ...card, ...patch } : card)); touch();
  };
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= cards.length || from === to) return;
    setCards(previous => { const next = [...previous]; const [card] = next.splice(from, 1); next.splice(to, 0, card!); return next; });
    touch();
    setAnnouncement(`${cards[from]?.title || 'Card'} moved to position ${to + 1} of ${cards.length}.`);
  };
  const locked = busy;
  const askPassage = (field: 'intro' | 'synopsis' | 'bullets', cardId?: string): AskPassage => async (passage, action, instruction) => {
    if (!await save()) throw new Error('Save the script successfully before asking Athena to change this passage.');
    const request = `${action === 'Add specific content' ? 'Add the following specific content to' : action} only the selected passage in this Podcast script's ${field} field.`
      + `\nEpisode ID: ${episode.noteId}${cardId ? `\nCard ID: ${cardId}` : ''}`
      + `\nSelected passage: ${JSON.stringify(passage.text)}`
      + `\nSelection offsets in the displayed field: ${passage.start}–${passage.end}.`
      + (field === 'bullets' ? '\nThe displayed field includes bullet markers; use the actual saved bullet array when editing.' : '')
      + (instruction ? `\nRequested addition: ${instruction}` : '')
      + '\nRead the current script first. Locate this exact passage; if it is ambiguous or has changed, ask rather than guessing.'
      + '\nKeep all other text, cards and fields unchanged. Preserve conversational British English and the enterprise angle.'
      + '\nLeave a blank line between every sentence (two newline characters). Keep continuation sentences in the same bullet array item.'
      + '\nSave the requested change directly with update_podcast_script; do not generate a new script or a separate note.';
    openAthena(request, { ...(pageContext?.podcastEpisodeId === episode.noteId ? pageContext : {}),
      type: 'note', id: episode.noteId, conversationId: episode.noteId, podcastEpisodeId: episode.noteId, podcastTab: 'script',
      title: episode.title });
  };
  return <section className="kh-episode-script" aria-label="Script">
    <div className="kh-design-actions kh-episode-script__actions">
      <button type="button" className="kh-btn-accent" disabled={locked || saving || !dirty} onClick={() => { setError(null); void save(); }}>{saving ? 'Saving...' : dirty ? 'Save script' : 'Saved'}</button>
      <button type="button" className="kh-btn-ghost" disabled={locked || dirty || draftUnavailable || !episode.prepSessionId}
        title={!episode.prepSessionId ? 'This episode has no prep conversation' : dirty ? 'Save your changes first' : undefined}
        onClick={() => { void onDraft(); }}>Draft script from prep</button>
      <button type="button" className="kh-btn-ghost" disabled={locked} onClick={() => { setCards(previous => [...previous, newCard()]); touch(); }}>Add card</button>
      <button type="button" className="kh-btn-ghost" disabled={locked || !onPresent || (!intro.trim() && !cards.length)}
        title={!onPresent ? 'Open Athena Desktop to present on the Elgato display' : undefined}
        onClick={() => { void (async () => { if (await save()) onPresent?.(); })(); }}>Present</button>
    </div>
    {error && <p role="alert" className="kh-uc-error">{error}</p>}
    <p className={HIDDEN} aria-live="polite">{announcement}</p>
    <div className="kh-uc-field kh-episode-intro"><label htmlFor={introId} className="kh-uc-field__label">Intro</label>
      <PassageTextarea id={introId} value={intro} maxLength={4000} disabled={locked} placeholder="How you open the episode"
        onAsk={askPassage('intro')}
        onChange={event => { setIntro(event.target.value); touch(); }} /></div>
    {!cards.length ? <div className="kh-design-diagram-empty"><h3>No topic cards yet</h3>
      <p>Draft the script from the prep conversation, or add cards yourself. Each card is a short synopsis with a few bullet points.</p></div>
      : <ol className="kh-episode-cards">{cards.map((card, index) => <li key={card.id} className="kh-episode-card" data-dragging={dragging === index || undefined}
        draggable={!locked && cardDragAllowed}
        onPointerDownCapture={event => { setCardDragAllowed(!(event.target instanceof HTMLElement && event.target.closest('textarea, input, button'))); }}
        onDragStart={event => {
          if (!cardDragAllowed || (event.target instanceof HTMLElement && event.target.closest('textarea, input, button'))) { event.preventDefault(); return; }
          setDragging(index); event.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => { setDragging(null); }} onDragOver={event => { if (dragging !== null) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); if (dragging !== null) move(dragging, index); setDragging(null); }}>
        <div className="kh-episode-card__head">
          <label className="kh-uc-field kh-episode-card__title"><span className={HIDDEN}>Card {index + 1} title</span>
            <input className="kh-uc-input kh-uc-input--title" value={card.title} maxLength={200} disabled={locked} placeholder="Card title"
              onChange={event => { update(index, { title: event.target.value }); }} /></label>
          <div className="kh-episode-card__tools">
            <button type="button" className="kh-btn-ghost" aria-label={`Move card ${index + 1} up`} disabled={locked || index === 0} onClick={() => { move(index, index - 1); }}>↑</button>
            <button type="button" className="kh-btn-ghost" aria-label={`Move card ${index + 1} down`} disabled={locked || index === cards.length - 1} onClick={() => { move(index, index + 1); }}>↓</button>
            <button type="button" className="kh-btn-ghost" aria-label={`Delete card ${index + 1}`} disabled={locked} onClick={() => {
              setCards(previous => previous.filter((_, i) => i !== index)); touch();
            }}>Delete</button>
          </div>
        </div>
        <div className="kh-uc-field"><label htmlFor={`${synopsisId}-${card.id}`} className="kh-uc-field__label">Synopsis</label>
          <PassageTextarea id={`${synopsisId}-${card.id}`} value={card.synopsis} maxLength={6000} disabled={locked} onAsk={askPassage('synopsis', card.id)}
            onChange={event => { update(index, { synopsis: event.target.value }); }} /></div>
        <BulletsField label="Bullet points" bullets={card.bullets} disabled={locked} onAsk={askPassage('bullets', card.id)}
          onChange={bullets => { update(index, { bullets }); }} />
      </li>)}</ol>}
  </section>;
};

const TranscriptPanel: React.FC<{ episode: PodcastEpisode; busy: boolean; onUpload: (file: File) => void }> = ({ episode, busy, onUpload }) => {
  const input = useRef<HTMLInputElement>(null);
  return <section className="kh-episode-transcript" aria-label="Transcript">
    <div className="kh-design-actions">
      <button type="button" className="kh-btn-accent" disabled={busy} onClick={() => { input.current?.click(); }}>
        {episode.transcript ? 'Replace transcript' : 'Upload transcript'}</button>
      <input ref={input} type="file" hidden accept=".txt,.srt,.docx"
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onUpload(file); }} />
      {episode.transcriptFilename && <span className="kh-episode-transcript__meta">{episode.transcriptFilename}
        {episode.transcriptUploadedAt && `, uploaded ${new Date(episode.transcriptUploadedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`}</span>}
    </div>
    {episode.transcript
      ? <pre className="kh-episode-transcript__text" tabIndex={0} aria-label="Transcript text">{episode.transcript}</pre>
      : <div className="kh-design-diagram-empty"><h3>No transcript yet</h3>
        <p>Export the transcript from Riverside as .txt, .srt or .docx and upload it here. Show notes are drafted from it.</p></div>}
  </section>;
};
