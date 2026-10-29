import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../services/api';
import { describeApiError, requireApiData } from '../../services/apiError';
import { extractNoteBlockText, fetchNote, type NoteContentBlock } from '../../notes/noteStorage';
import { athenaLinkText } from '../../notes/linkLabels';
import { deferredView } from '../../utils/deferredView';
import { useAthenaContext } from '../../context/AthenaContext';
import { confirmDialog } from '../../services/appDialogs';
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
  const [showNotesPrompt, setShowNotesPrompt] = useState<{ prompt: string; sequence: number } | undefined>();
  const noteSave = useRef<(() => Promise<boolean>) | null>(null);
  const scriptSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerSave = useCallback((save: (() => Promise<boolean>) | null) => { noteSave.current = save; }, []);
  const registerScriptSave = useCallback((save: (() => Promise<boolean>) | null) => { scriptSave.current = save; }, []);
  const uid = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const query = useQuery({ queryKey: ['podcast-episode', id], queryFn: async () => requireApiData(await api.getPodcastEpisode(id)) });
  const episode = query.data;
  const setEpisode = useCallback((next: PodcastEpisode) => { qc.setQueryData(['podcast-episode', id], next); }, [id, qc]);
  const showNotesId = episode?.showNotesNoteId ?? null;
  const documentId = (tab === 'show_notes' || tab === 'campaign') && showNotesId ? showNotesId : id;
  const document = useQuery({
    queryKey: ['podcast-episode-document', documentId],
    queryFn: async () => { const doc = await fetchNote(documentId); if (!doc) throw new Error('The document is unavailable.'); return doc; },
    enabled: !!episode, refetchOnWindowFocus: false, staleTime: 30_000,
  });
  const busy = stageBusy || chatBusy || workspaceBusy;
  const { setAthenaContext } = useAthenaContext();
  useEffect(() => {
    if (!document.data) return;
    const note = document.data;
    let detail = '';
    try {
      const blocks: unknown = JSON.parse(note.contentJson);
      if (Array.isArray(blocks)) detail = extractNoteBlockText(blocks as NoteContentBlock[], athenaLinkText);
    } catch { /* an unreadable body stays out of the context */ }
    setAthenaContext({ type: 'note', id: note.id, title: note.title, detail, ...(note.projectId ? { projectId: note.projectId } : {}) });
  }, [document.data, setAthenaContext]);
  useEffect(() => () => { setAthenaContext(null); }, [setAthenaContext]);

  const prepare = useCallback(async (): Promise<void> => {
    if (noteSave.current && !await noteSave.current()) throw new Error('The document could not be saved. Your draft remains available; retry before continuing.');
    if (scriptSave.current && !await scriptSave.current()) throw new Error('The script could not be saved. Your cards remain available; retry before continuing.');
  }, []);
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
    {error && <p role="alert" className="kh-uc-error">{error}</p>}
  </div>;

  let body: React.ReactNode;
  if (tab === 'prep') {
    body = episode.prepSessionId
      ? <div className="kh-episode-chat"><AIChatPage compact fixedSessionId={episode.prepSessionId} initialPersona="podcast_prep" onBusyChange={setChatBusy} /></div>
      : <section className="kh-design-diagram-empty" aria-label="Prep"><h3>No prep conversation</h3>
        <p>This episode was not created from a Thursday prep run, so there is no prep conversation to show.</p></section>;
  } else if (tab === 'script') {
    body = <ScriptEditor key={episode.noteId} episode={episode} busy={busy || switching} onSaved={setEpisode} registerSave={registerScriptSave} onPresent={onPresent}
      onDraft={async () => {
        if ((episode.scriptCards.length || episode.scriptIntro) && !await confirmDialog('Drafting from prep replaces the intro and every card in the current script.',
          { title: 'Replace the script?', confirmLabel: 'Replace script', tone: 'danger' })) return;
        await runStage(async () => requireApiData(await api.draftPodcastScript(id, episode.revision)), 'The script was not drafted.');
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

const BULLET = '• ';
const BULLET_PREFIX = /^\s*(?:•|[-*](?=\s))\s?/;

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

/** Maps an edited bullet box back to bullet text, keeping the caret beside the character the user typed. */
function parseBullets(raw: string, caret: number): { bullets: string[]; caret: number } {
  if (!raw.trim()) return { bullets: [], caret: 0 };
  const bullets: string[] = [];
  let offset = 0;
  let output = 0;
  let next: number | null = null;
  for (const line of raw.split('\n')) {
    const prefix = BULLET_PREFIX.exec(line)?.[0].length ?? 0;
    const content = line.slice(prefix);
    if (next === null && caret <= offset + line.length) next = output + BULLET.length + Math.max(0, caret - offset - prefix);
    bullets.push(content);
    offset += line.length + 1;
    output += BULLET.length + content.length + 1;
  }
  return { bullets, caret: next ?? output - 1 };
}

const BulletsField: React.FC<{ bullets: string[]; disabled: boolean; label: string; onChange: (bullets: string[]) => void }> = ({ bullets, disabled, label, onChange }) => {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const caret = useRef<number | null>(null);
  const value = bullets.map(item => BULLET + item).join('\n');
  useLayoutEffect(() => {
    if (caret.current !== null && input.current && document.activeElement === input.current) input.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = event.currentTarget;
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd || (event.key !== 'Backspace' && event.key !== 'Delete')) return;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = value.indexOf('\n', pos) === -1 ? value.length : value.indexOf('\n', pos);
    const line = value.slice(0, lineStart).split('\n').length - 1;
    // Deleting across a bullet marker joins the two bullet points instead of leaving a stray marker in the text.
    if (event.key === 'Backspace' && pos === lineStart + BULLET.length) {
      event.preventDefault();
      if (line === 0) { if (bullets.length === 1 && !bullets[0]) onChange([]); return; }
      caret.current = lineStart - 1;
      onChange([...bullets.slice(0, line - 1), `${bullets[line - 1] ?? ''}${bullets[line] ?? ''}`, ...bullets.slice(line + 1)]);
    } else if (event.key === 'Delete' && pos === lineEnd && line < bullets.length - 1) {
      event.preventDefault();
      caret.current = pos;
      onChange([...bullets.slice(0, line), `${bullets[line] ?? ''}${bullets[line + 1] ?? ''}`, ...bullets.slice(line + 2)]);
    }
  };
  return <label className="kh-uc-field"><span className="kh-uc-field__label">{label}</span>
    <AutoTextarea inputRef={input} value={value} disabled={disabled} placeholder={`${BULLET}Add a bullet point`} onKeyDown={keyDown}
      onChange={event => { const parsed = parseBullets(event.target.value, event.target.selectionStart); caret.current = parsed.caret; onChange(parsed.bullets); }} /></label>;
};

const ScriptEditor: React.FC<{
  episode: PodcastEpisode; busy: boolean; onSaved: (episode: PodcastEpisode) => void;
  registerSave: (save: (() => Promise<boolean>) | null) => void; onDraft: () => Promise<void>; onPresent?: (() => void) | undefined;
}> = ({ episode, busy, onSaved, registerSave, onDraft, onPresent }) => {
  const [intro, setIntro] = useState(episode.scriptIntro);
  const [cards, setCards] = useState<ScriptCard[]>(episode.scriptCards);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const edits = useRef(0);
  const revision = useRef(episode.revision);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const ownSave = useRef(false);
  const state = useRef({ intro, cards, dirty });
  state.current = { intro, cards, dirty };
  useEffect(() => { revision.current = Math.max(revision.current, episode.revision); }, [episode.revision]);
  useEffect(() => {
    if (ownSave.current) { ownSave.current = false; return; }
    if (!dirty) { setIntro(episode.scriptIntro); setCards(episode.scriptCards); }
  }, [episode.scriptIntro, episode.scriptCards, dirty]);
  const touch = (): void => { edits.current += 1; setDirty(true); };
  const save = useCallback(async (): Promise<boolean> => {
    while (inFlight.current) { const ok = await inFlight.current; if (!ok) return false; }
    if (!state.current.dirty) return true;
    const run = (async (): Promise<boolean> => {
      const version = edits.current;
      setSaving(true); setError(null);
      try {
        const cleaned = state.current.cards.map(card => ({ ...card, bullets: card.bullets.map(item => item.trim()).filter(Boolean) }));
        const next = requireApiData(await api.savePodcastScript(episode.noteId, state.current.intro.trim(), cleaned, revision.current));
        revision.current = next.revision;
        ownSave.current = true;
        if (edits.current === version) setDirty(false);
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
  return <section className="kh-episode-script" aria-label="Script">
    <div className="kh-design-actions kh-episode-script__actions">
      <button type="button" className="kh-btn-accent" disabled={locked || saving || !dirty} onClick={() => { setError(null); void save(); }}>{saving ? 'Saving...' : dirty ? 'Save script' : 'Saved'}</button>
      <button type="button" className="kh-btn-ghost" disabled={locked || dirty || !episode.prepSessionId}
        title={!episode.prepSessionId ? 'This episode has no prep conversation' : dirty ? 'Save your changes first' : undefined}
        onClick={() => { void onDraft(); }}>Draft script from prep</button>
      <button type="button" className="kh-btn-ghost" disabled={locked} onClick={() => { setCards(previous => [...previous, newCard()]); touch(); }}>Add card</button>
      <button type="button" className="kh-btn-ghost" disabled={locked || !onPresent || (!intro.trim() && !cards.length)}
        title={!onPresent ? 'Open Athena Desktop to present on the Elgato display' : undefined}
        onClick={() => { void (async () => { if (await save()) onPresent?.(); })(); }}>Present</button>
    </div>
    {error && <p role="alert" className="kh-uc-error">{error}</p>}
    <p className={HIDDEN} aria-live="polite">{announcement}</p>
    <label className="kh-uc-field kh-episode-intro"><span className="kh-uc-field__label">Intro</span>
      <AutoTextarea value={intro} maxLength={4000} disabled={locked} placeholder="How you open the episode"
        onChange={event => { setIntro(event.target.value); touch(); }} /></label>
    {!cards.length ? <div className="kh-design-diagram-empty"><h3>No topic cards yet</h3>
      <p>Draft the script from the prep conversation, or add cards yourself. Each card is a short synopsis with a few bullet points.</p></div>
      : <ol className="kh-episode-cards">{cards.map((card, index) => <li key={card.id} className="kh-episode-card" data-dragging={dragging === index || undefined}
        draggable={!locked} onDragStart={event => { setDragging(index); event.dataTransfer.effectAllowed = 'move'; }}
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
        <label className="kh-uc-field"><span className="kh-uc-field__label">Synopsis</span>
          <AutoTextarea value={card.synopsis} maxLength={6000} disabled={locked}
            onChange={event => { update(index, { synopsis: event.target.value }); }} /></label>
        <BulletsField label="Bullet points" bullets={card.bullets} disabled={locked} onChange={bullets => { update(index, { bullets }); }} />
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
