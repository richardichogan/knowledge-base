import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { fetchNote, fetchNotesPage } from '../../notes/noteStorage';
import { nextNotesPage } from '../../notes/noteListState';
import { desktopErrorMessage, getDesktop, type DesktopCommand, type DesktopCommandState } from '../../types/desktop';
import type { PresentationDisplay } from '../../../../athena-desktop/src/elgatoProtocol';
import { presentationScript } from './presentationScript';
import { authSession } from '../../services/authSession';
import { api } from '../../services/api';
import { requireApiData } from '../../services/apiError';
import { episodeScriptText } from '../../types/podcastEpisodes';
import { annotatedPresentation } from '../podcasts/scriptAnnotations';
import './presenter.scss';

export function Presenter(): React.JSX.Element {
  const desktop = getDesktop()?.presentation;
  const expired = useSyncExternalStore(authSession.subscribe, authSession.isExpired);
  const [state, setState] = useState<DesktopCommandState | null>(null);
  const [displays, setDisplays] = useState<(PresentationDisplay & { preferred?: boolean })[]>([]);
  const [displayId, setDisplayId] = useState('');
  const [noteId, setNoteId] = useState(new URLSearchParams(window.location.search).get('noteId') ?? '');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opacity, setOpacity] = useState(100);
  const busyRef = useRef(false);
  const [pairing, setPairing] = useState<{ enabled: boolean; error: string | null } | null>(null);
  const notes = useInfiniteQuery({
    queryKey: ['presentation-notes', search], queryFn: ({ pageParam }) => fetchNotesPage(pageParam, { q: search }),
    initialPageParam: 1, getNextPageParam: nextNotesPage, enabled: desktop !== undefined,
  });
  const note = useQuery({ queryKey: ['presentation-note', noteId], queryFn: () => fetchNote(noteId), enabled: !!noteId && !!desktop });
  const episode = useQuery({
    queryKey: ['presentation-episode', noteId],
    queryFn: async () => requireApiData(await api.getPodcastEpisode(noteId)),
    enabled: !!desktop && note.data?.contentType === 'podcast-episode',
  });
  const { script, scriptError } = useMemo(() => {
    try {
      if (note.data?.contentType === 'podcast-episode') {
        return { script: episode.data ? { ...annotatedPresentation(episodeScriptText(episode.data.scriptIntro, episode.data.scriptCards)), warnings: [] } : null,
          scriptError: episode.error?.message ?? null };
      }
      return { script: note.data ? presentationScript(note.data.contentJson) : null, scriptError: null };
    }
    catch (err) { return { script: null, scriptError: err instanceof Error ? err.message : 'Could not read this script.' }; }
  }, [note.data, episode.data, episode.error]);
  const annotationUnsupported = !!script?.runs.some(run => run.styles.some(style => style.startsWith('colour-') || style.startsWith('cue-')))
    && !desktop?.scriptAnnotations;

  async function action(fn: () => Promise<unknown>, message?: string): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); if (message) setNotice(message); }
    catch (err) { setError(desktopErrorMessage(err)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function refreshDisplays(): Promise<void> {
    if (!desktop) return;
    const available = await desktop.displays();
    setDisplays(available);
    setDisplayId(previous => available.some(d => String(d.id) === previous) ? previous : '');
  }
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const off = desktop.onState(value => { if (active) setState(value); });
    const offNote = desktop.onNote(value => { if (active) setNoteId(value); });
    void Promise.all([desktop.state(), desktop.displays(), desktop.pairingStatus()]).then(([value, available, paired]) => {
      if (!active) return;
      setState(value); setDisplays(available); setPairing(paired);
      const preferred = available.find(display => display.preferred && !display.primary);
      if (preferred) setDisplayId(String(preferred.id));
      if (!new URLSearchParams(window.location.search).has('noteId') && value.presentation.noteId) setNoteId(value.presentation.noteId);
    }).catch(err => { if (active) setError(desktopErrorMessage(err)); });
    return () => {
      active = false; off(); offNote();
      void (desktop.release ? desktop.release() : desktop.close()).catch(err => { console.error('[Presentation] Could not close output:', err); });
    };
  }, [desktop]);
  useEffect(() => {
    if (!expired || !desktop) return;
    setError('Sign in again before presenting. The output has been closed.');
    void desktop.close().catch(err => { setError(desktopErrorMessage(err)); });
  }, [desktop, expired]);
  const command = (value: DesktopCommand): void => {
    if (desktop) void action(() => desktop.command({ id: crypto.randomUUID(), command: value, issuedAt: Date.now() }));
  };
  const playback = state?.presentation;
  useEffect(() => { setOpacity(playback?.opacity ?? 100); }, [playback?.opacity]);
  const connected = playback?.displayId !== null && !!playback?.sessionId && playback?.status !== 'disconnected';
  const rows = notes.data?.pages.flatMap(page => page.items) ?? [];
  const selected = note.data;
  const currentListed = rows.some(item => item.id === noteId);
  const canStart = !expired && !!selected && !!script?.text && !!displayId && !note.isFetching && !episode.isFetching && !annotationUnsupported;
  const play = (): void => {
    if (!desktop || !canStart || !selected || !script) return;
    void action(async () => {
      if (!connected || (desktop.present && playback?.noteId !== selected.id) || playback?.displayId !== Number(displayId)) {
        await desktop.start({ noteId: selected.id, title: selected.title, text: script.text, runs: script.runs, displayId: Number(displayId) });
      }
      await desktop.command({ id: crypto.randomUUID(), command: 'play', issuedAt: Date.now() });
    });
  };
  const saveOpacity = (value: number): void => {
    if (desktop && value !== (playback?.opacity ?? 100)) {
      void action(() => desktop.options({ mirror: playback?.mirror ?? false, flip: playback?.flip ?? false, opacity: value }));
    }
  };
  if (!desktop) return <main className="kh-presenter"><h1>Presentation</h1><p>Open this view in an updated Athena Desktop to use a separate display and Stream Deck.</p><a href="/think">Return to Think</a></main>;
  return <main className="kh-presenter">
    <header className="kh-presenter__header">
      <div><h1>Presentation</h1><p>Keep your controls here. Put your words on the Prompter.</p></div>
      <span className="kh-presenter__status" role="status">{playback?.status ?? 'Connecting'}</span>
    </header>
    {(error || state?.error || playback?.error) && <p className="kh-presenter__error" role="alert">{error ?? state?.error ?? playback?.error}</p>}
    {notice && <p className="kh-presenter__notice" role="status">{notice}</p>}
    <div className="kh-presenter__layout">
      <section className="kh-presenter__script" aria-labelledby="script-title">
        <h2 id="script-title">Script</h2>
        <label>Find a Think note<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search notes" /></label>
        <label>Note<select value={noteId} onChange={e => setNoteId(e.target.value)}>
          <option value="">Choose a note</option>
          {selected && !currentListed && <option value={selected.id}>{selected.title}</option>}
          {rows.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        {notes.isPending && <p role="status">Loading notes...</p>}
        {notes.error && <p className="kh-presenter__error" role="alert">{notes.error.message} <button onClick={() => { void notes.refetch(); }}>Retry</button></p>}
        {notes.hasNextPage && <button disabled={notes.isFetchingNextPage} onClick={() => { void notes.fetchNextPage(); }}>Load more notes</button>}
        {notes.isFetchNextPageError && <p className="kh-presenter__error" role="alert">Could not load more notes. Retry Load more notes.</p>}
        {(note.isFetching || episode.isFetching) && <p role="status">Loading script...</p>}
        {(note.error || scriptError) && <p className="kh-presenter__error" role="alert">{note.error?.message ?? scriptError}</p>}
        {script?.warnings.map(warning => <p key={warning}>{warning}</p>)}
        <h3>{selected?.title ?? 'No note selected'}</h3>
        <p className="kh-presenter__preview">{script?.text ? script.runs.map((run, index) =>
          <span key={index} className={run.styles.map(style => `kh-presenter__text--${style}`).join(' ')}>{run.text}</span>)
          : 'Choose a saved note with text to see its script here.'}</p>
        <p>The output uses a saved snapshot. Edits will not change a live presentation.</p>
        {annotationUnsupported && <p className="kh-presenter__error" role="alert">Update Athena Desktop to present script colours and visual delivery cues.</p>}
      </section>
      <aside className="kh-presenter__controls" aria-label="Presenter controls">
        <section>
          <h2>Output display</h2>
          <label>Display<select value={displayId} onChange={e => setDisplayId(e.target.value)}>
            <option value="">Confirm your output display</option>
            {displays.map(display => <option key={display.id} value={display.id} disabled={display.primary}>{display.label} - {display.width} x {display.height}{display.primary ? ' (presenter controls)' : ''}{display.preferred ? ' (previous)' : ''}</option>)}
          </select></label>
          <div className="kh-presenter__row">
            <button disabled={busy} onClick={() => { void action(refreshDisplays); }}>Refresh displays</button>
            <button disabled={!displayId || busy} onClick={() => { void action(() => desktop.identify(Number(displayId))); }}>Identify</button>
          </div>
          <button className="kh-presenter__primary" disabled={!canStart || busy} onClick={() => {
            if (!selected || !script) return;
            void action(() => desktop.start({ noteId: selected.id, title: selected.title, text: script.text, runs: script.runs, displayId: Number(displayId) }), 'Script opened, paused and ready.');
          }}>Open script on display</button>
          <button disabled={!selected || busy} onClick={() => { void action(async () => {
            if (connected) await desktop.command({ id: crypto.randomUUID(), command: 'pause', issuedAt: Date.now() });
            const refreshed = await note.refetch();
            if (refreshed.error) throw refreshed.error;
            if (refreshed.data?.contentType === 'podcast-episode') {
              const nextEpisode = await episode.refetch();
              if (nextEpisode.error) throw nextEpisode.error;
            }
          }, 'Preview reloaded. Open script on display to replace the paused output.'); }}>Reload saved script</button>
        </section>
        <section>
          <h2>Playback</h2>
          <p>{playback?.title || 'No output script loaded'}</p>
          <div className="kh-presenter__row">
            <button disabled={!canStart || busy || (playback?.status === 'playing' && playback.noteId === noteId)} onClick={play}>Play</button>
            <button disabled={!connected || busy || playback?.status !== 'playing'} onClick={() => command('pause')}>Pause</button>
            <button disabled={!connected || busy} onClick={() => command('stop')}>Stop &amp; reset</button>
          </div>
          <label>Reading progress<progress value={playback?.progress ?? 0} max={1} /></label>
          <div className="kh-presenter__adjust">
            <span>Speed <strong>{playback?.speed ?? 80} px/s</strong></span>
            <button disabled={!connected || busy || (playback?.speed ?? 80) <= 10} onClick={() => command('slower')} aria-label="Slower">-</button>
            <button disabled={!connected || busy || (playback?.speed ?? 80) >= 300} onClick={() => command('faster')} aria-label="Faster">+</button>
          </div>
          <div className="kh-presenter__adjust">
            <span>Text size <strong>{playback?.fontSize ?? 64} px</strong></span>
            <button disabled={!connected || busy || (playback?.fontSize ?? 64) <= 24} onClick={() => command('text-smaller')} aria-label="Smaller text">-</button>
            <button disabled={!connected || busy || (playback?.fontSize ?? 64) >= 96} onClick={() => command('text-larger')} aria-label="Larger text">+</button>
          </div>
          <label className="kh-presenter__check"><input type="checkbox" checked={playback?.mirror ?? false} disabled={busy} onChange={e => {
            void action(() => desktop.options({ mirror: e.target.checked, flip: playback?.flip ?? false }));
          }} />Mirror horizontally</label>
          <label className="kh-presenter__check"><input type="checkbox" checked={playback?.flip ?? false} disabled={busy} onChange={e => {
            void action(() => desktop.options({ mirror: playback?.mirror ?? false, flip: e.target.checked }));
          }} />Flip vertically</label>
          {desktop.present && <label>Output opacity ({opacity}%)
            <input type="range" min={20} max={100} step={5} value={opacity} disabled={busy}
              onChange={e => setOpacity(Number(e.target.value))}
              onPointerUp={e => saveOpacity(Number(e.currentTarget.value))}
              onKeyUp={e => saveOpacity(Number(e.currentTarget.value))}
              onBlur={e => saveOpacity(Number(e.currentTarget.value))} />
          </label>}
          <p>The passage at the reading guide is highlighted; surrounding text is dimmed. Pause and Beat are visual reminders only.
            No presentation microphone is used.</p>
        </section>
        <section>
          <h2>Stream Deck</h2>
          <p>{pairing?.enabled ? 'Local connection enabled. Pair the Athena plugin using your key.' : 'Enable the local connection, then paste the copied key into the Athena plugin in Stream Deck.'}</p>
          {pairing?.error && <p className="kh-presenter__error" role="alert">{pairing.error}</p>}
          <div className="kh-presenter__row">
            <button disabled={busy} onClick={() => { void action(async () => setPairing(await desktop.pair()), 'New pairing key copied. Paste it into the Athena plugin; previous keys are revoked.'); }}>{pairing?.enabled ? 'Replace pairing key' : 'Enable & copy pairing key'}</button>
            {pairing?.enabled && <>
              <button disabled={busy} onClick={() => { void action(() => desktop.copyKey(), 'Pairing key copied.'); }}>Copy key</button>
              <button disabled={busy} onClick={() => { void action(async () => setPairing(await desktop.revoke()), 'Stream Deck connection disabled.'); }}>Disable</button>
            </>}
          </div>
          <p>Athena Desktop must be running. Press Speak to Athena once to record; press it again to transcribe and send your message, including any existing draft.</p>
        </section>
      </aside>
    </div>
  </main>;
}
