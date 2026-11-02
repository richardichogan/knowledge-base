/**
 * Job updates — finished or failed background work is recorded here and surfaced only through the Background work
 * cog: an unseen dot on the cog and a list in its panel. No popup, chime or desktop notification. Shared across tabs.
 */
import { useSyncExternalStore } from 'react';
import { LONG_PROMPT_MS } from '../chat/completionNotification';

export interface JobUpdate { id: string; ok: boolean; title: string; body: string; url: string; tag: string; at: string; seen: boolean }

const STORAGE_KEY = 'athena-job-updates';
const LIMIT = 30;
const listeners = new Set<() => void>();

function read(): JobUpdate[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed as JobUpdate[] : [];
  } catch { return []; }
}

let updates: JobUpdate[] = typeof localStorage === 'undefined' ? [] : read();
const changed = (): void => { for (const listener of listeners) listener(); };
function save(next: JobUpdate[]): void {
  updates = next.slice(0, LIMIT);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updates)); } catch { /* The in-memory list still works. */ }
  changed();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) { updates = read(); changed(); } });
}

/** Records finished background work for the cog. Jobs shorter than 30s are not recorded unless `always` is set. */
export function announceAthenaJob(input: { ok: boolean; title: string; body: string; url: string; startedAt: number; tag: string; always?: boolean; id?: string }): void {
  if (!input.always && Date.now() - input.startedAt <= LONG_PROMPT_MS) return;
  const id = input.id ?? crypto.randomUUID();
  if (updates.some(update => update.id === id)) return;
  save([{ id, ok: input.ok, title: input.title, body: input.body, url: input.url, tag: input.tag, at: new Date().toISOString(), seen: false }, ...updates]);
}

export function markJobUpdatesSeen(): void {
  if (updates.some(update => !update.seen)) save(updates.map(update => ({ ...update, seen: true })));
}

const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useJobUpdates(): JobUpdate[] {
  return useSyncExternalStore(subscribe, () => updates, () => updates);
}
