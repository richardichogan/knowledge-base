/**
 * components/athena/usedSources.ts — pure view-model for the "Used:" line: groups sources by how far they
 * got (Found, Read, Cited), decides how each one opens, and scopes warnings to the reply or one source.
 */
import type { ContextUsedApi, SourceLifecycle, UsedSourceApi, UsedWarningApi } from '../../types';

export interface SourceGroup { lifecycle: SourceLifecycle; label: string; hint: string; sources: UsedSourceApi[] }
export type SourceTarget =
  | { kind: 'internal'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'unavailable' }
  | { kind: 'none' };

const RANK: Record<SourceLifecycle, number> = { found: 0, read: 1, cited: 2 };
const SECRET_PARAM = /^(token|access_token|id_token|refresh_token|sig|signature|key|api[-_]?key|code|sas|sv|se|sp)$/i;

export const LIFECYCLE_LABEL: Record<SourceLifecycle, string> = { cited: 'Cited', read: 'Read', found: 'Found' };
const LIFECYCLE_HINT: Record<SourceLifecycle, string> = {
  cited: 'Supports something in the answer',
  read: 'Available to the answer, not necessarily quoted',
  found: 'Turned up in a search, not necessarily read',
};

/** Replies saved before lifecycle existed: what was explicitly looked at counts as read, background retrieval as found. */
export function lifecycleOf(source: UsedSourceApi, fallback: SourceLifecycle): SourceLifecycle {
  return source.lifecycle ?? fallback;
}

/** One entry per id at its furthest lifecycle, grouped Cited → Read → Found; empty groups are omitted. */
export function groupSources(used: Pick<ContextUsedApi, 'found' | 'auto'>): SourceGroup[] {
  const best = new Map<string, { source: UsedSourceApi; lifecycle: SourceLifecycle }>();
  const add = (source: UsedSourceApi, fallback: SourceLifecycle): void => {
    const lifecycle = lifecycleOf(source, fallback);
    const current = best.get(source.id);
    if (current === undefined || RANK[lifecycle] > RANK[current.lifecycle]) best.set(source.id, { source, lifecycle });
  };
  used.found.forEach((s) => { add(s, 'read'); });
  used.auto.forEach((s) => { add(s, 'found'); });
  return (['cited', 'read', 'found'] as const)
    .map((lifecycle) => ({
      lifecycle, label: LIFECYCLE_LABEL[lifecycle], hint: LIFECYCLE_HINT[lifecycle],
      sources: [...best.values()].filter((entry) => entry.lifecycle === lifecycle).map((entry) => entry.source),
    }))
    .filter((group) => group.sources.length > 0);
}

/** http(s) links only, and never one that carries a credential in its query string or userinfo. */
export function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    for (const name of parsed.searchParams.keys()) if (SECRET_PARAM.test(name)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const isInternal = (url: string): boolean => /^https?:\/\/[^/]*athena/i.test(url) || url.startsWith('/');

/** Missing or deleted targets never become links, so nothing navigates to a fabricated object. */
export function sourceTarget(source: UsedSourceApi): SourceTarget {
  if (source.available === false) return { kind: 'unavailable' };
  const url = source.url;
  if (url === undefined || url === null || url === '') return { kind: 'none' };
  if (url.startsWith('/')) return { kind: 'internal', href: url };
  const safe = safeExternalUrl(url);
  if (safe === null) return { kind: 'none' };
  return isInternal(url) ? { kind: 'internal', href: safe } : { kind: 'external', href: safe };
}

/** Warnings for the reply as a whole, and those attached to a single source. */
export function scopeWarnings(warnings: UsedWarningApi[] | undefined): { reply: UsedWarningApi[]; bySource: Map<string, UsedWarningApi[]> } {
  const reply: UsedWarningApi[] = [];
  const bySource = new Map<string, UsedWarningApi[]>();
  for (const warning of warnings ?? []) {
    if (warning.sourceId === undefined) { reply.push(warning); continue; }
    bySource.set(warning.sourceId, [...(bySource.get(warning.sourceId) ?? []), warning]);
  }
  return { reply, bySource };
}
