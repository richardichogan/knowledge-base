/**
 * components/athena/AthenaLauncher.tsx — the floating bottom-right Athena button, on every page.
 * A badge counts things Athena has for Richard that he hasn't seen: proposals visible in peak hours,
 * work Athena paused after repeated failures, and answers that finished while no chat showed them.
 * The badge pulses once when the count rises. Opening Athena from a badged launcher shows "What's new".
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AthenaMark } from './AthenaMark';
import { useAthenaContext, type AthenaNewsItem } from '../../context/AthenaContext';
import { useProactive } from '../today/Proactive';
import { followChatTurn, type LiveTurnHandlers } from '../../services/chatTurns';
import { dismissReplies, isViewed, useAthenaReplies } from '../../services/athenaReplies';
import type { ProactiveOverview } from '../../types/goals';

const SEEN_KEY = 'kh_athena_seen_news';
const IDLE_POLL_MS = 5 * 60_000;
const QUIET: LiveTurnHandlers = { onActivity: () => undefined, onText: () => undefined };

function loadSeen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function proactiveNews(data: ProactiveOverview | undefined): AthenaNewsItem[] {
  if (!data) return [];
  const items: AthenaNewsItem[] = (data.paused ?? []).filter((p) => p.status === 'open').map((p) => ({
    id: `paused:${p.key}`, tone: 'paused', label: `Paused: ${p.subjectTitle}`, detail: p.question, to: '/?item=goal-scorecard' }));
  if (!data.timing?.peak) return items;
  const prep = data.meetingPrep;
  const live = <T extends { held?: boolean }>(xs: T[]): T[] => xs.filter((x) => !x.held);
  for (const p of live(prep.promises).filter((x) => x.status === 'proposed')) {
    items.push({ id: `promise:${p.id}`, tone: 'proposal', label: p.owner === 'richard' ? 'A promise you made' : `A promise from ${p.who}`, detail: p.text, to: '/?item=today-meetings' });
  }
  for (const c of live(prep.chases).filter((x) => x.status === 'proposed')) {
    items.push({ id: `chase:${c.id}`, tone: 'proposal', label: `Chase: ${c.taskTitle}`, detail: `${c.workingDays} working days${c.waitingOn ? ` waiting on ${c.waitingOn}` : ''}`, to: '/?item=today-meetings' });
  }
  for (const c of live(prep.cadence).filter((x) => x.status === 'proposed')) {
    items.push({ id: `cadence:${c.id}`, tone: 'proposal', label: `Keep in touch with ${c.person}`, detail: c.reason, to: '/?item=today-meetings' });
  }
  for (const p of live(data.packages).filter((x) => !x.decision && (x.status === 'ready' || x.status === 'ready-to-approve'))) {
    items.push({ id: `package:${p.id}`, tone: 'proposal', label: `Content package: ${p.title}`, detail: p.why, to: `/plan?view=drafts&draft=${encodeURIComponent(p.id)}` });
  }
  for (const c of live(data.cfps.shortlist)) {
    items.push({ id: `cfp:${c.id}`, tone: 'proposal', label: `Call for papers: ${c.conference}`, detail: c.fit, to: '/?item=goal:voice' });
  }
  return items;
}

/** Follows answers nobody is watching, so they're marked unread when they land. */
function useHeadlessReplies(): ReturnType<typeof useAthenaReplies> {
  const replies = useAthenaReplies();
  const following = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const wanted = new Set(replies.pending.filter((p) => !isViewed(p.turnId)).map((p) => p.turnId));
    for (const [turnId, controller] of following.current) {
      if (!wanted.has(turnId)) { controller.abort(); following.current.delete(turnId); }
    }
    for (const turnId of wanted) {
      if (following.current.has(turnId)) continue;
      const controller = new AbortController();
      following.current.set(turnId, controller);
      void followChatTurn(turnId, QUIET, controller.signal, { headless: true })
        .catch(() => undefined)
        .finally(() => { if (following.current.get(turnId) === controller) following.current.delete(turnId); });
    }
  }, [replies.version, replies.pending]);
  useEffect(() => {
    const map = following.current;
    return () => { for (const controller of map.values()) controller.abort(); map.clear(); };
  }, []);
  return replies;
}

export const AthenaLauncher: React.FC<{ unavailable?: string | undefined }> = ({ unavailable }) => {
  const { launchAthena, floatOpen, showNews } = useAthenaContext();
  const proactive = useProactive(IDLE_POLL_MS);
  const { unread } = useHeadlessReplies();
  const [seen, setSeen] = useState(loadSeen);
  const news = useMemo<AthenaNewsItem[]>(() => [
    ...unread.map((u): AthenaNewsItem => ({ id: `reply:${u.turnId}`, tone: 'reply', label: 'Athena answered', detail: u.prompt, to: `/chat?session=${encodeURIComponent(u.sessionId)}` })),
    ...proactiveNews(proactive.data),
  ], [unread, proactive.data]);
  const fresh = news.filter((n) => !seen.has(n.id));
  const count = fresh.length;
  // No pulse for what was already waiting when the page loaded; only for arrivals after that.
  const previous = useRef<number | null>(null);
  const [pulse, setPulse] = useState(0);
  const loaded = proactive.isFetched;
  useEffect(() => {
    if (!loaded) return;
    if (previous.current !== null && count > previous.current) setPulse((n) => n + 1);
    previous.current = count;
  }, [count, loaded]);

  const open = (): void => {
    if (count > 0) {
      showNews(fresh);
      const next = new Set(news.map((n) => n.id));
      setSeen(next);
      try { window.localStorage.setItem(SEEN_KEY, JSON.stringify([...next])); } catch { /* badge resets on reload */ }
      dismissReplies(fresh.filter((n) => n.tone === 'reply').map((n) => n.id.slice('reply:'.length)));
    } else {
      showNews(null);
    }
    launchAthena();
  };

  if (floatOpen) return null;
  const label = unavailable ?? (count > 0 ? `Open Athena — ${count} new item${count === 1 ? '' : 's'}` : 'Open Athena');
  return (
    <button type="button" className={`kh-athena-launcher${count > 0 ? ' kh-athena-launcher--news' : ''}`}
      aria-label={label} title={unavailable ?? `${label} (⌘J / Ctrl+J)`} disabled={unavailable !== undefined} onClick={open}>
      <AthenaMark state="resting" size={30} />
      {count > 0 && <span key={pulse} className={`kh-athena-launcher__badge${pulse > 0 ? ' kh-athena-launcher__badge--pulse' : ''}`} aria-hidden="true">
        {count > 9 ? '9+' : count}
      </span>}
    </button>
  );
};
