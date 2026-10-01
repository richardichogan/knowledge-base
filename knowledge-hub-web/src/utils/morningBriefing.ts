/**
 * utils/morningBriefing.ts — the first time Athena is opened each day, she
 * opens on that day's morning briefing (a pinned chat) instead of the last
 * conversation.
 */
const SEEN_KEY = 'kh_briefing_seen_date';
// Same key the standalone/full Athena chat restores its session from.
const ATHENA_SESSION_KEY = 'kh-athena-session-id-standalone';

export function briefingSeenToday(date: string): boolean {
  try { return window.localStorage.getItem(SEEN_KEY) === date; } catch { return true; }
}

export function markBriefingSeen(date: string): void {
  try { window.localStorage.setItem(SEEN_KEY, date); } catch { /* storage unavailable */ }
}

/** Opens the briefing chat in the full Athena window. */
export function openBriefingInAthena(sessionId: string): void {
  try { window.localStorage.setItem(ATHENA_SESSION_KEY, sessionId); } catch { /* storage unavailable */ }
  window.open('/chat', '_blank', 'noopener');
}
