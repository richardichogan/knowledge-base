/**
 * services/athenaReplies.ts — remembers Athena answers that are still being
 * written, and answers that finished while no chat was showing them, so the
 * floating launcher can badge them and link back to the chat.
 */
import { useSyncExternalStore } from 'react';

export interface PendingReply { turnId: string; sessionId: string; prompt: string; startedAt: number }
export interface UnreadReply { turnId: string; sessionId: string; prompt: string; finishedAt: number }

const PENDING_KEY = 'kh_athena_pending_replies';
const UNREAD_KEY = 'kh_athena_unread_replies';
const PENDING_TTL_MS = 30 * 60_000;
const MAX_UNREAD = 20;

function load<T>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch { return []; }
}

let pending: PendingReply[] = load<PendingReply>(PENDING_KEY).filter((p) => Date.now() - p.startedAt < PENDING_TTL_MS);
let unread: UnreadReply[] = load<UnreadReply>(UNREAD_KEY);
const viewers = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    window.localStorage.setItem(UNREAD_KEY, JSON.stringify(unread));
  } catch { /* storage full or blocked: the badge just won't survive a reload */ }
  version += 1;
  listeners.forEach((l) => l());
}

function shortPrompt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function trackReply(turnId: string, sessionId: string, prompt: string): void {
  if (pending.some((p) => p.turnId === turnId)) return;
  pending = [...pending, { turnId, sessionId, prompt: shortPrompt(prompt), startedAt: Date.now() }];
  changed();
}

export function attachViewer(turnId: string): void {
  viewers.set(turnId, (viewers.get(turnId) ?? 0) + 1);
  changed();
}

export function detachViewer(turnId: string): void {
  const n = (viewers.get(turnId) ?? 1) - 1;
  if (n <= 0) viewers.delete(turnId); else viewers.set(turnId, n);
  changed();
}

export function isViewed(turnId: string): boolean { return (viewers.get(turnId) ?? 0) > 0; }

/** The turn ended. It becomes unread only when it finished with an answer and nobody was watching. */
export function settleReply(turnId: string, answered: boolean): void {
  const item = pending.find((p) => p.turnId === turnId);
  if (!item) return;
  pending = pending.filter((p) => p.turnId !== turnId);
  if (answered && !isViewed(turnId)) {
    unread = [{ turnId, sessionId: item.sessionId, prompt: item.prompt, finishedAt: Date.now() }, ...unread].slice(0, MAX_UNREAD);
  }
  changed();
}

export function dismissReplies(turnIds?: string[]): void {
  unread = turnIds ? unread.filter((u) => !turnIds.includes(u.turnId)) : [];
  changed();
}

export function readSession(sessionId: string): void {
  if (!unread.some((u) => u.sessionId === sessionId)) return;
  unread = unread.filter((u) => u.sessionId !== sessionId);
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAthenaReplies(): { pending: PendingReply[]; unread: UnreadReply[]; version: number } {
  const v = useSyncExternalStore(subscribe, () => version);
  return { pending, unread, version: v };
}
