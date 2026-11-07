/**
 * goals/goals.ts — Richard's four working goals, their measures and live status. Automatic measures read real data
 * (podcast recordings, sent posts, inbox, open decisions); manual measures (proposals, CFPs, milestones) are recorded
 * by Richard or by Athena on his word. Shared by the Today Goals panel, the Monday brief, the Friday scorecard and Athena.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getSyncState, upsertSyncState } from '../db/queries.js';
import { NotFoundError, ValidationError } from '../types/errors.js';

const DAY_MS = 86_400_000;
const PROGRESS_KEY = 'athena-goals-progress';
const NOTE_LIMIT = 500;
const MAX_ENTRIES = 500;
const MAX_COUNT_STEP = 20;

export type GoalId = 'imagine' | 'practice' | 'voice' | 'attention';
export type GoalHealth = 'on-track' | 'at-risk' | 'slipping';
type AutoMetric = 'days-since-podcast' | 'posts-last-7-days' | 'inbox-open' | 'decisions-over-14-days';

interface MeasureBase { id: string; label: string }
interface CountMeasure extends MeasureBase { kind: 'count'; period: 'quarter' | 'month'; target: number; unit: string }
interface MilestoneMeasure extends MeasureBase { kind: 'milestone'; deadline: string }
interface AutoMeasure extends MeasureBase { kind: 'auto'; metric: AutoMetric; target: number; direction: 'at-most' | 'at-least'; unit: string }
export type MeasureDefinition = CountMeasure | MilestoneMeasure | AutoMeasure;

export interface GoalDefinition {
  id: GoalId; name: string; why: string; projects: string[]; homeProject: string; measures: MeasureDefinition[];
}

/** Agreed with Richard on 7 Nov 2026. */
export const GOALS: readonly GoalDefinition[] = [
  { id: 'imagine', name: 'Win with Imagine', why: 'Turn Imagine conversations into sent proposals.', homeProject: 'imagine',
    projects: ['imagine', 'ikea', 'imagine-turnaround', 'imagine-complaints-process', 'reckitt'],
    measures: [{ id: 'imagine-proposals', label: 'Proposals sent', kind: 'count', period: 'quarter', target: 2, unit: 'proposals' }] },
  { id: 'practice', name: 'Grow the IBM/MSFT practice', why: 'Earn the Advanced Specialisation and grow the joint practice.', homeProject: 'ibm-msft-practice',
    projects: ['ibm-msft-practice'],
    measures: [{ id: 'advanced-specialisation', label: 'Advanced Specialisation submitted', kind: 'milestone', deadline: '2027-01-31' }] },
  { id: 'voice', name: 'Be the recognised voice', why: 'Publish steadily and speak where your buyers listen.', homeProject: 'ibm-thought-leadership',
    projects: ['ibm-thought-leadership', 'cloudt-with-a-chance-of-insights', 'content-pipeline'],
    measures: [
      { id: 'podcast-cadence', label: 'Days since last podcast recording', kind: 'auto', metric: 'days-since-podcast', target: 14, direction: 'at-most', unit: 'days' },
      { id: 'posts-week', label: 'Posts published in the last 7 days', kind: 'auto', metric: 'posts-last-7-days', target: 3, direction: 'at-least', unit: 'posts' },
      { id: 'cfp-month', label: 'CFPs submitted', kind: 'count', period: 'month', target: 1, unit: 'CFPs' },
    ] },
  { id: 'attention', name: 'Protect your attention', why: 'Keep the inbox and open decisions small enough to trust.', homeProject: 'personal',
    projects: [],
    measures: [
      { id: 'inbox', label: 'Tasks in the inbox', kind: 'auto', metric: 'inbox-open', target: 30, direction: 'at-most', unit: 'tasks' },
      { id: 'old-decisions', label: 'Open decisions older than 14 days', kind: 'auto', metric: 'decisions-over-14-days', target: 0, direction: 'at-most', unit: 'decisions' },
    ] },
];

export const GOAL_PROJECTS: readonly string[] = [...new Set(GOALS.flatMap(g => g.projects))];

/** Richard's approved changes on top of the agreed goals: measure targets/deadlines and which goal each project serves. */
export const GOAL_CONFIG_KEY = 'goal-config';
export type ProjectGoal = GoalId | 'none';
export interface MeasureOverride { target?: number; deadline?: string }
export interface GoalAdjustment {
  id: string; kind: 'target' | 'deadline' | 'link'; measureId?: string; projectId?: string; goalId?: ProjectGoal;
  from: string; to: string; reason: string; at: string; status: 'proposed' | 'accepted' | 'dismissed'; decidedAt: string | null;
}
export interface GoalConfig { measures: Record<string, MeasureOverride>; projectGoals: Record<string, ProjectGoal>; adjustments: GoalAdjustment[]; lastReview: string | null }
export const EMPTY_GOAL_CONFIG: GoalConfig = { measures: {}, projectGoals: {}, adjustments: [], lastReview: null };

export async function goalConfig(db: Pool): Promise<GoalConfig> {
  const raw = await readState<Partial<GoalConfig>>(db, GOAL_CONFIG_KEY);
  return { measures: raw?.measures ?? {}, projectGoals: raw?.projectGoals ?? {}, adjustments: raw?.adjustments ?? [], lastReview: raw?.lastReview ?? null };
}

/** The agreed goals with Richard's approved overrides applied. Use this rather than GOALS wherever targets or projects matter. */
export function applyGoalConfig(config: GoalConfig): GoalDefinition[] {
  return GOALS.map(g => {
    const projects = [
      ...g.projects.filter(p => !config.projectGoals[p] || config.projectGoals[p] === g.id),
      ...Object.entries(config.projectGoals).filter(([p, id]) => id === g.id && !g.projects.includes(p)).map(([p]) => p),
    ];
    const measures = g.measures.map((m): MeasureDefinition => {
      const o = config.measures[m.id];
      if (!o) return m;
      if (m.kind === 'milestone') return o.deadline ? { ...m, deadline: o.deadline } : m;
      return typeof o.target === 'number' ? { ...m, target: o.target } : m;
    });
    return { ...g, projects, measures };
  });
}
export async function loadGoals(db: Pool): Promise<GoalDefinition[]> { return applyGoalConfig(await goalConfig(db)); }
export async function goalProjects(db: Pool): Promise<string[]> { return [...new Set((await loadGoals(db)).flatMap(g => g.projects))]; }

export interface ProgressEntry { id: string; measureId: string; at: string; count?: number; done?: boolean; note: string; actor: 'richard' | 'athena' }
export interface MeasureStatus {
  id: string; label: string; kind: MeasureDefinition['kind']; health: GoalHealth; summary: string;
  value: number | null; target: number | null; unit: string | null; period: string | null;
  deadline: string | null; done: boolean | null; manual: boolean; recent: ProgressEntry[];
}
export interface GoalStatus {
  id: GoalId; name: string; why: string; health: GoalHealth; projects: Array<{ id: string; name: string }>;
  openTasks: number; overdueTasks: number; measures: MeasureStatus[];
}

export function goal(id: unknown): GoalDefinition {
  const found = GOALS.find(g => g.id === id);
  if (!found) throw new ValidationError('Unknown goal. Use imagine, practice, voice or attention.');
  return found;
}

function measure(id: unknown): MeasureDefinition {
  const found = GOALS.flatMap(g => g.measures).find(m => m.id === id);
  if (!found) throw new NotFoundError('Goal measure');
  return found;
}

/** Reads a JSON value stored in sync_state. */
export async function readState<T>(db: Pool, key: string): Promise<T | null> {
  const state = await getSyncState(db, key);
  if (state?.lastCursor == null) return null;
  try { return JSON.parse(state.lastCursor) as T; } catch { return null; }
}
export async function writeState(db: Pool, key: string, value: unknown, count = 0): Promise<void> {
  await upsertSyncState(db, key, { lastSyncAt: new Date(), lastCursor: JSON.stringify(value), itemCount: count, lastError: null });
}
/** Read-modify-write of a sync_state JSON value under a row lock, so concurrent edits are not lost. */
export async function mutateState<T, R>(db: Pool, key: string, empty: T, change: (value: T) => R | Promise<R>): Promise<R> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO sync_state(source, item_count, updated_at) VALUES ($1, 0, NOW()) ON CONFLICT (source) DO NOTHING`, [key]);
    const raw = (await client.query<{ last_cursor: string | null }>('SELECT last_cursor FROM sync_state WHERE source=$1 FOR UPDATE', [key])).rows[0]?.last_cursor;
    let value: T = empty;
    if (raw) { try { value = JSON.parse(raw) as T; } catch { value = empty; } }
    const result = await change(value);
    await client.query('UPDATE sync_state SET last_cursor=$2, last_sync_at=NOW(), updated_at=NOW(), last_error=NULL WHERE source=$1', [key, JSON.stringify(value)]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function periodBounds(period: 'quarter' | 'month', now: Date): { start: Date; end: Date; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const first = period === 'quarter' ? m - (m % 3) : m;
  const start = new Date(Date.UTC(y, first, 1));
  const end = new Date(Date.UTC(y, first + (period === 'quarter' ? 3 : 1), 1));
  const label = period === 'quarter' ? `Q${String(first / 3 + 1)} ${String(y)}` : start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { start, end, label };
}

const shortDate = (d: Date): string => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

async function autoValue(db: Pool, metric: AutoMetric): Promise<{ value: number | null; detail: string }> {
  if (metric === 'days-since-podcast') {
    const row = (await db.query<{ d: Date | null; n: number | null }>(
      `SELECT recording_date AS d, episode_number AS n FROM podcast_episodes
        WHERE recording_date IS NOT NULL AND recording_date <= CURRENT_DATE ORDER BY recording_date DESC LIMIT 1`)).rows[0];
    if (!row?.d) return { value: null, detail: 'No recorded episode found.' };
    const days = Math.floor((Date.now() - new Date(row.d).getTime()) / DAY_MS);
    return { value: days, detail: `Last recorded ${shortDate(new Date(row.d))}${row.n ? ` (EP${String(row.n)})` : ''}.` };
  }
  if (metric === 'posts-last-7-days') {
    const n = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM publishing_deliveries WHERE status='sent' AND published_at > NOW() - INTERVAL '7 days'`)).rows[0]?.n ?? 0;
    return { value: n, detail: 'Counts sent Bluesky, LinkedIn and blog deliveries.' };
  }
  if (metric === 'inbox-open') {
    const n = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE status='inbox' AND NOT archived`)).rows[0]?.n ?? 0;
    return { value: n, detail: 'Counts unarchived Plan tasks in the inbox.' };
  }
  const n = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM chat_decisions WHERE status='open' AND created_at < NOW() - INTERVAL '14 days'`)).rows[0]?.n ?? 0;
  return { value: n, detail: 'Counts open chat decisions recorded more than 14 days ago.' };
}

function autoHealth(m: AutoMeasure, value: number | null): GoalHealth {
  if (value === null) return 'at-risk';
  if (m.direction === 'at-least') return value >= m.target ? 'on-track' : value >= Math.ceil(m.target / 2) ? 'at-risk' : 'slipping';
  if (value <= m.target) return 'on-track';
  const slack = m.target === 0 ? 10 : m.target / 2;
  return value <= m.target + slack ? 'at-risk' : 'slipping';
}

const RANK: Record<GoalHealth, number> = { 'on-track': 0, 'at-risk': 1, slipping: 2 };
export const worstHealth = (values: GoalHealth[]): GoalHealth => values.reduce<GoalHealth>((a, b) => (RANK[b] > RANK[a] ? b : a), 'on-track');

function measureStatus(m: MeasureDefinition, entries: ProgressEntry[], now: Date, auto: { value: number | null; detail: string } | null): MeasureStatus {
  const own = entries.filter(e => e.measureId === m.id).sort((a, b) => b.at.localeCompare(a.at));
  const base = { id: m.id, label: m.label, kind: m.kind, recent: own.slice(0, 5) };
  if (m.kind === 'auto') {
    const value = auto?.value ?? null;
    const aim = `${m.direction === 'at-most' ? 'at most' : 'at least'} ${String(m.target)} ${m.unit}`;
    return { ...base, health: autoHealth(m, value), value, target: m.target, unit: m.unit, period: null, deadline: null, done: null, manual: false,
      summary: `${value === null ? 'Unknown' : `${String(value)} ${m.unit}`}; aim for ${aim}. ${auto?.detail ?? ''}`.trim() };
  }
  if (m.kind === 'count') {
    const { start, end, label } = periodBounds(m.period, now);
    const value = own.filter(e => e.at >= start.toISOString() && e.at < end.toISOString()).reduce((sum, e) => sum + (e.count ?? 0), 0);
    const elapsed = (now.getTime() - start.getTime()) / (end.getTime() - start.getTime());
    const health: GoalHealth = value >= m.target || value >= Math.floor(m.target * elapsed) ? 'on-track' : elapsed < 0.75 ? 'at-risk' : 'slipping';
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
    return { ...base, health, value, target: m.target, unit: m.unit, period: label, deadline: null, done: null, manual: true,
      summary: `${String(value)} of ${String(m.target)} ${m.unit} in ${label}; ${String(daysLeft)} days left.` };
  }
  const done = own[0]?.done === true;
  const deadline = new Date(`${m.deadline}T23:59:59Z`);
  const daysLeft = Math.ceil((deadline.getTime() - now.getTime()) / DAY_MS);
  const health: GoalHealth = done || daysLeft > 30 ? 'on-track' : daysLeft > 7 ? 'at-risk' : 'slipping';
  const due = deadline.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return { ...base, health, value: null, target: null, unit: null, period: null, deadline: m.deadline, done, manual: true,
    summary: done ? `Done on ${shortDate(new Date(own[0]!.at))}.` : daysLeft >= 0 ? `Due ${due}; ${String(daysLeft)} days left.` : `Was due ${due}; ${String(-daysLeft)} days overdue.` };
}

export async function progressEntries(db: Pool): Promise<ProgressEntry[]> {
  return (await readState<{ entries: ProgressEntry[] }>(db, PROGRESS_KEY))?.entries ?? [];
}

/** Live status of every goal, its measures and its workstreams' open and overdue tasks. */
export async function goalsStatus(db: Pool, now = new Date()): Promise<GoalStatus[]> {
  const entries = await progressEntries(db);
  const goals = await loadGoals(db);
  const projectIds = [...new Set(goals.flatMap(g => g.projects))];
  const metrics = [...new Set(goals.flatMap(g => g.measures).flatMap(m => (m.kind === 'auto' ? [m.metric] : [])))];
  const autos = new Map(await Promise.all(metrics.map(async metric => [metric, await autoValue(db, metric)] as const)));
  const names = new Map((await db.query<{ id: string; name: string }>('SELECT id, name FROM projects')).rows.map(r => [r.id, r.name]));
  const counts = new Map((await db.query<{ project_id: string; open: number; overdue: number }>(
    `SELECT project_id, COUNT(*)::int AS open, COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS overdue
       FROM tasks WHERE NOT archived AND status <> 'completed' AND project_id = ANY($1) GROUP BY project_id`, [projectIds])).rows.map(r => [r.project_id, r]));
  return goals.map(g => {
    const measures = g.measures.map(m => measureStatus(m, entries, now, m.kind === 'auto' ? autos.get(m.metric) ?? null : null));
    return { id: g.id, name: g.name, why: g.why, health: worstHealth(measures.map(m => m.health)),
      projects: g.projects.map(id => ({ id, name: names.get(id) ?? id })),
      openTasks: g.projects.reduce((n, p) => n + (counts.get(p)?.open ?? 0), 0),
      overdueTasks: g.projects.reduce((n, p) => n + (counts.get(p)?.overdue ?? 0), 0), measures };
  });
}

/** Records progress on a manual measure: a count for proposals and CFPs, or done/not done for a milestone. */
export async function recordGoalProgress(db: Pool, input: { measureId?: unknown; count?: unknown; done?: unknown; note?: unknown; date?: unknown },
  actor: ProgressEntry['actor']): Promise<ProgressEntry> {
  const m = measure(input.measureId);
  if (m.kind === 'auto') throw new ValidationError(`${m.label} is measured automatically from Athena's data and cannot be recorded by hand.`);
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, NOTE_LIMIT) : '';
  const at = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? new Date(`${input.date}T12:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + DAY_MS) throw new ValidationError('Use a valid date that is not in the future.');
  const entry: ProgressEntry = { id: randomUUID(), measureId: m.id, at: at.toISOString(), note, actor };
  if (m.kind === 'count') {
    const count = input.count ?? 1;
    if (typeof count !== 'number' || !Number.isInteger(count) || count === 0 || Math.abs(count) > MAX_COUNT_STEP) {
      throw new ValidationError('Record a whole number from -20 to 20; use a negative number to correct a mistake.');
    }
    entry.count = count;
  } else {
    if (typeof input.done !== 'boolean') throw new ValidationError('Say whether the milestone is done.');
    entry.done = input.done;
  }
  await mutateState<{ entries: ProgressEntry[] }, void>(db, PROGRESS_KEY, { entries: [] }, value => {
    value.entries = [entry, ...(value.entries ?? [])].slice(0, MAX_ENTRIES);
  });
  return entry;
}

/** Monday of the current UK week as YYYY-MM-DD. */
export function weekOf(now = new Date()): string {
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  local.setDate(local.getDate() - ((local.getDay() + 6) % 7));
  return `${String(local.getFullYear())}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
}

/** Owner for queued task assistance: the latest assistance owner, else the first allowed user. */
export async function assistanceOwner(db: Pool, allowed: string | undefined): Promise<string | undefined> {
  const latest = (await db.query<{ owner_id: string }>('SELECT owner_id FROM task_assistance ORDER BY created_at DESC LIMIT 1')).rows[0]?.owner_id;
  return latest ?? allowed?.split(',').map(id => id.trim()).find(Boolean);
}
