/**
 * AthenaJobNotice — an in-app notice with a chime when a long Athena job finishes. It is broadcast to every open
 * Athena tab and window, so it pops up in whichever one you are using, alongside the desktop notification.
 */
import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LONG_PROMPT_MS, notifyAthenaJobFinished } from '../../chat/completionNotification';

interface Notice { id: string; ok: boolean; title: string; body: string; url: string }
type Message = { type: 'notice'; notice: Notice } | { type: 'played'; id: string };
let current: Notice | null = null;
const listeners = new Set<(notice: Notice | null) => void>();
const played = new Set<string>();
/** Notices already shown, so a job reported by several sources appears once. */
const announced = new Set<string>();
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('athena-job-notice');
// Node keeps an open BroadcastChannel alive; browsers have no unref.
(channel as { unref?: () => void } | null)?.unref?.();
const publish = (notice: Notice | null): void => { current = notice; for (const listener of listeners) listener(notice); };

let audio: AudioContext | null = null;
/** Unlocks audio during a user gesture so the chime can play when a job finishes later. */
export function primeAthenaChime(): void {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    if (audio.state === 'suspended') void audio.resume();
  } catch { /* Sound is optional; the visual notice still shows. */ }
}

function chime(ok: boolean): void {
  if (!audio) return;
  if (audio.state === 'suspended') void audio.resume();
  const start = audio.currentTime + 0.02;
  const notes = ok ? [659.25, 987.77] : [440, 349.23];
  notes.forEach((frequency, index) => {
    const at = start + index * 0.16;
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain).connect(audio!.destination);
    osc.start(at);
    osc.stop(at + 0.55);
  });
}

/** Plays once across windows: a visible window plays at once; a hidden one only if no visible window did. */
function sound(notice: Notice): void {
  const play = (): void => {
    if (played.has(notice.id)) return;
    played.add(notice.id);
    channel?.postMessage({ type: 'played', id: notice.id } satisfies Message);
    chime(notice.ok);
  };
  if (document.visibilityState === 'visible') play();
  else window.setTimeout(play, 400);
}

channel?.addEventListener('message', (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === 'played') { played.add(message.id); return; }
  if (announced.has(message.notice.id)) return;
  announced.add(message.notice.id);
  publish(message.notice);
  if (document.visibilityState === 'visible') sound(message.notice);
});

/** Announces a finished job in every Athena window. Jobs shorter than 30s stay quiet unless `always` is set. */
export function announceAthenaJob(input: { ok: boolean; title: string; body: string; url: string; startedAt: number; tag: string; always?: boolean; id?: string }): void {
  if (!input.always && Date.now() - input.startedAt <= LONG_PROMPT_MS) return;
  if (input.id && announced.has(input.id)) return;
  const notice: Notice = { id: input.id ?? crypto.randomUUID(), ok: input.ok, title: input.title, body: input.body, url: input.url };
  announced.add(notice.id);
  publish(notice);
  channel?.postMessage({ type: 'notice', notice } satisfies Message);
  sound(notice);
  notifyAthenaJobFinished(input.tag, input.always ? 0 : input.startedAt, `Athena — ${input.title}`, input.body, input.url);
}

export const AthenaJobNotice: React.FC = () => {
  const [notice, setNotice] = useState<Notice | null>(current);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => { listeners.add(setNotice); return () => { listeners.delete(setNotice); }; }, []);
  useEffect(() => {
    window.addEventListener('pointerdown', primeAthenaChime);
    window.addEventListener('keydown', primeAthenaChime);
    return () => { window.removeEventListener('pointerdown', primeAthenaChime); window.removeEventListener('keydown', primeAthenaChime); };
  }, []);
  if (!notice) return null;
  const here = `${location.pathname}${location.search}` === notice.url;
  return <aside key={notice.id} className={`kh-job-notice${notice.ok ? '' : ' kh-job-notice--error'}`} role={notice.ok ? 'status' : 'alert'} aria-live="polite">
    <p className="kh-job-notice__title">{notice.title}</p>
    <p className="kh-job-notice__body">{notice.body}</p>
    <div className="kh-job-notice__actions">
      {!here && <button type="button" className="kh-btn-accent" onClick={() => { publish(null); void navigate(notice.url); }}>Open</button>}
      <button type="button" className="kh-btn-ghost" onClick={() => { publish(null); }}>Dismiss</button>
    </div>
  </aside>;
};
