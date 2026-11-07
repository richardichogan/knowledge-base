/**
 * goals/proposals.ts — Athena's proposal ledger. Every proactive proposal (weekly moves, date changes, deal follow-ups,
 * promises, chases, cadence nudges, content packages, CFPs and chat next steps) is recorded with its outcome so the
 * Friday scorecard can report what Athena proposed and what Richard did with it. A proposal type ignored three weeks
 * running is switched off automatically and the scorecard says so; Richard can switch it back on.
 */
import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import { mutateState, readState } from './goals.js';

const LEDGER_KEY = 'proactive-ledger';
const DAY_MS = 86_400_000;
const KEEP_DAYS = 120;
const IGNORED_WEEKS = 3;
/** Undecided proposals younger than this are still open, not ignored. */
const OPEN_MS = 2 * 86_400_000;
const TITLE_LIMIT = 200;

export const PROPOSAL_TYPES = ['goal-move', 'date-proposal', 'deal-followup', 'promise', 'chase', 'cadence', 'content-package', 'cfp', 'chat-next-step', 'goal-adjustment'] as const;
export type ProposalType = typeof PROPOSAL_TYPES[number];
export const PROPOSAL_LABELS: Record<ProposalType, string> = {
  'goal-move': 'Weekly moves', 'date-proposal': 'Due-date changes', 'deal-followup': 'Deal follow-up drafts', promise: 'Promises from meetings',
  chase: 'Chase drafts', cadence: 'Keep-in-touch nudges', 'content-package': 'Content packages', cfp: 'CFP shortlist', 'chat-next-step': 'Chat next steps',
  'goal-adjustment': 'Monthly goal adjustments',
};
/** The weekly brief and scorecard are the backbone of the goals loop: reported, never switched off automatically. */
const EXEMPT: ReadonlySet<ProposalType> = new Set(['goal-move', 'date-proposal', 'goal-adjustment']);

export type ProposalOutcome = 'proposed' | 'accepted' | 'dismissed';
export interface ProposalEntry { id: string; type: ProposalType; title: string; at: string; outcome: ProposalOutcome; decidedAt: string | null; draftId?: string; surfacedAt?: string }
interface Ledger {
  entries: ProposalEntry[];
  disabled: Partial<Record<ProposalType, { at: string; reason: string; by: 'athena' | 'richard' }>>;
  reenabledAt: Partial<Record<ProposalType, string>>;
  /** Peak gating for proposals that have no ledger entry (or predate surfacedAt): candidate id → first shown. */
  surfaced?: Record<string, string>;
}
const empty = (): Ledger => ({ entries: [], disabled: {}, reenabledAt: {} });

export interface ProposalReport {
  since: string; proposed: number; accepted: number; open: number; ignored: number; dismissed: number;
  byType: Array<{ type: ProposalType; label: string; proposed: number; accepted: number; open: number; ignored: number; dismissed: number }>;
  stopped: Array<{ type: ProposalType; label: string; at: string; reason: string; by: 'athena' | 'richard' }>;
}

export function proposalType(value: unknown): ProposalType {
  if (typeof value === 'string' && (PROPOSAL_TYPES as readonly string[]).includes(value)) return value as ProposalType;
  throw new ValidationError(`Unknown proposal type. Use one of: ${PROPOSAL_TYPES.join(', ')}.`);
}

async function ledger(db: Pool): Promise<Ledger> {
  const value = await readState<Ledger>(db, LEDGER_KEY);
  return value ? { ...empty(), ...value } : empty();
}

export async function proposalEnabled(db: Pool, type: ProposalType): Promise<boolean> {
  return !(await ledger(db)).disabled[type];
}

/** Records a proposal once; recording the same id again is a no-op. */
export async function recordProposal(db: Pool, type: ProposalType, id: string, title: string, draftId?: string | null): Promise<void> {
  await mutateState<Ledger, void>(db, LEDGER_KEY, empty(), value => {
    value.entries ??= []; value.disabled ??= {}; value.reenabledAt ??= {};
    if (value.entries.some(e => e.id === id)) return;
    const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
    value.entries = value.entries.filter(e => Date.parse(e.at) >= cutoff);
    value.entries.push({ id, type, title: title.slice(0, TITLE_LIMIT), at: new Date().toISOString(), outcome: 'proposed', decidedAt: null, ...(draftId ? { draftId } : {}) });
  });
}

/** Records Richard's decision on a proposal. Unknown ids are ignored (the proposal predates the ledger). */
export async function decideProposal(db: Pool, id: string, outcome: 'accepted' | 'dismissed'): Promise<void> {
  await mutateState<Ledger, void>(db, LEDGER_KEY, empty(), value => {
    const entry = (value.entries ?? []).find(e => e.id === id);
    if (entry && entry.outcome === 'proposed') { entry.outcome = outcome; entry.decidedAt = new Date().toISOString(); }
  });
}

export async function setProposalTypeEnabled(db: Pool, type: ProposalType, enabled: boolean): Promise<void> {
  await mutateState<Ledger, void>(db, LEDGER_KEY, empty(), value => {
    value.disabled ??= {}; value.reenabledAt ??= {};
    if (enabled) { delete value.disabled[type]; value.reenabledAt[type] = new Date().toISOString(); }
    else value.disabled[type] = { at: new Date().toISOString(), reason: 'Switched off by Richard.', by: 'richard' };
  });
}

/** A draft that was marked Sent counts as accepted; an archived or deleted draft counts as dismissed. */
async function syncDraftOutcomes(db: Pool): Promise<void> {
  const open = (await ledger(db)).entries.filter(e => e.outcome === 'proposed' && e.draftId);
  if (open.length === 0) return;
  const rows = (await db.query<{ id: string; sent: boolean | null; archived: boolean | null }>(
    `SELECT x.id, e.status='sent' AS sent, coalesce(n.status <> 'active', true) AS archived
       FROM unnest($1::text[]) AS x(id) LEFT JOIN notes n ON n.id::text=x.id LEFT JOIN email_drafts e ON e.note_id::text=x.id`,
    [open.map(e => e.draftId!)])).rows;
  const state = new Map(rows.map(r => [r.id, r.sent ? 'accepted' as const : r.archived ? 'dismissed' as const : null]));
  if (![...state.values()].some(Boolean)) return;
  await mutateState<Ledger, void>(db, LEDGER_KEY, empty(), value => {
    for (const e of value.entries ?? []) {
      const outcome = e.outcome === 'proposed' && e.draftId ? state.get(e.draftId) : null;
      if (outcome) { e.outcome = outcome; e.decidedAt = new Date().toISOString(); }
    }
  });
}

const mondayOf = (time: number): number => {
  const d = new Date(time); d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS;
};

/**
 * Switches off any non-exempt type whose proposals were all left undecided in each of the last three complete weeks.
 * Only proposals made after Richard last switched the type back on count. Returns the types switched off now.
 */
export async function evaluateAutoOff(db: Pool, now = new Date()): Promise<ProposalType[]> {
  await syncDraftOutcomes(db);
  const thisWeek = mondayOf(now.getTime());
  const weeks = Array.from({ length: IGNORED_WEEKS }, (_, i) => thisWeek - (i + 1) * 7 * DAY_MS);
  return mutateState<Ledger, ProposalType[]>(db, LEDGER_KEY, empty(), value => {
    value.entries ??= []; value.disabled ??= {}; value.reenabledAt ??= {};
    const off: ProposalType[] = [];
    for (const type of PROPOSAL_TYPES) {
      if (EXEMPT.has(type) || value.disabled[type]) continue;
      const since = Date.parse(value.reenabledAt[type] ?? '1970-01-01');
      const ignored = weeks.every(start => {
        const inWeek = value.entries.filter(e => e.type === type && Date.parse(e.at) >= Math.max(start, since) && Date.parse(e.at) < start + 7 * DAY_MS);
        return inWeek.length > 0 && inWeek.every(e => e.outcome === 'proposed');
      });
      if (!ignored) continue;
      value.disabled[type] = { at: now.toISOString(), reason: `Ignored ${String(IGNORED_WEEKS)} weeks running, so Athena stopped proposing these.`, by: 'athena' };
      off.push(type);
    }
    return off;
  });
}

/** The last seven days of proposals, for the scorecard footer and Athena. */
export async function proposalReport(db: Pool, now = new Date()): Promise<ProposalReport> {
  await syncDraftOutcomes(db);
  const value = await ledger(db);
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const recent = value.entries.filter(e => Date.parse(e.at) >= since.getTime());
  const count = (list: ProposalEntry[]) => ({
    proposed: list.length, accepted: list.filter(e => e.outcome === 'accepted').length,
    open: list.filter(e => e.outcome === 'proposed' && now.getTime() - Date.parse(e.at) < OPEN_MS).length,
    ignored: list.filter(e => e.outcome === 'proposed' && now.getTime() - Date.parse(e.at) >= OPEN_MS).length, dismissed: list.filter(e => e.outcome === 'dismissed').length,
  });
  return {
    since: since.toISOString(), ...count(recent),
    byType: PROPOSAL_TYPES.map(type => ({ type, label: PROPOSAL_LABELS[type], ...count(recent.filter(e => e.type === type)) })).filter(t => t.proposed > 0),
    stopped: PROPOSAL_TYPES.flatMap(type => { const d = value.disabled[type]; return d ? [{ type, label: PROPOSAL_LABELS[type], ...d }] : []; }),
  };
}

/** Peak hours (UK): when Richard acts on proposals rather than skimming past them. */
const PEAK_WINDOWS: ReadonlyArray<[number, number]> = [[9 * 60, 11 * 60], [16 * 60, 18 * 60]];
export const PEAK_MAX = 3;

function londonParts(at: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
export function inPeakWindow(at = new Date()): boolean {
  const { day, minutes } = londonParts(at);
  return day >= 1 && day <= 5 && PEAK_WINDOWS.some(([a, b]) => minutes >= a && minutes < b);
}
/** The start of the next peak window, to the minute. */
export function nextPeakWindow(at = new Date()): string {
  let t = Math.ceil(at.getTime() / 60_000) * 60_000;
  for (let i = 0; i < 8 * 24 * 60; i += 1, t += 60_000) {
    const d = new Date(t);
    if (inPeakWindow(d) && !inPeakWindow(new Date(t - 60_000))) return d.toISOString();
  }
  return new Date(t).toISOString();
}

/**
 * Proactive proposals surface in peak hours only, at most three at a time, oldest first. Once surfaced an item stays
 * visible until decided. Candidates are the ids currently on Today; anything not in the ledger predates it and shows.
 */
export async function gateProposals(db: Pool, candidateIds: string[], now = new Date()): Promise<{ visible: Set<string>; held: number; peak: boolean; nextWindow: string }> {
  const peak = inPeakWindow(now);
  const candidates = new Set(candidateIds);
  const visible = await mutateState<Ledger, Set<string>>(db, LEDGER_KEY, empty(), value => {
    value.entries ??= [];
    const known = new Map(value.entries.map(e => [e.id, e]));
    const surfaced: Record<string, string> = {};
    for (const id of candidates) {
      const at = known.get(id)?.surfacedAt ?? value.surfaced?.[id];
      if (at) surfaced[id] = at;
    }
    // Once shown, a proposal stays until decided; new ones only fill free slots in peak hours.
    const shown = new Set(Object.keys(surfaced));
    if (peak) {
      const order = (id: string) => known.get(id)?.at ?? '';
      const waiting = candidateIds.filter(id => !shown.has(id)).sort((a, b) => order(a).localeCompare(order(b)));
      for (const id of waiting) {
        if (shown.size >= PEAK_MAX) break;
        const at = now.toISOString();
        surfaced[id] = at;
        const e = known.get(id);
        if (e) e.surfacedAt = at;
        shown.add(id);
      }
    }
    value.surfaced = surfaced;
    return shown;
  });
  return { visible, held: candidateIds.filter(id => !visible.has(id)).length, peak, nextWindow: peak ? now.toISOString() : nextPeakWindow(now) };
}

/** Chat next steps: an offer is accepted when Richard's next message in that chat is one of the offered steps. */
export async function recordChatNextSteps(db: Pool, messageId: string, steps: string[]): Promise<void> {
  if (steps.length > 0 && messageId) await recordProposal(db, 'chat-next-step', `chat:${messageId}`, steps.join(' · '));
}
export async function noteChatNextStepChoice(db: Pool, sessionId: string, message: string): Promise<void> {
  const last = (await db.query<{ id: string; next_steps: string[] | null }>(
    `SELECT id::text, next_steps FROM ai_chat_messages WHERE session_id::text=$1 AND role='assistant' ORDER BY id DESC LIMIT 1`, [sessionId])).rows[0];
  if (!last?.next_steps?.length) return;
  // Typing something else leaves the offer ignored rather than rejected.
  if (last.next_steps.some(step => step.trim().toLowerCase() === message.trim().toLowerCase())) await decideProposal(db, `chat:${last.id}`, 'accepted');
}
