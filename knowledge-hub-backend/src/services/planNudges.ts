/**
 * services/planNudges.ts
 * Keeps Plan from being ignored: the end-of-day check-in (settle today's open items) and the
 * "at risk" picks Athena raises at the start of a chat (tasks that keep slipping or have gone quiet).
 */
import type { Pool } from 'pg';
import { ukClock } from '../sync/ukClock.js';

export interface NudgeTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  projectId: string;
  dueDate: string | null;
  rescheduleCount: number;
}

export interface AtRiskTask extends NudgeTask {
  score: number;
  reason: string;
}

export interface CheckinState {
  day: string;
  hour: number;
  status: 'completed' | 'skipped' | null;
  items: NudgeTask[];
  completedToday: Array<{ id: string; title: string }>;
}

interface NudgeRow {
  id: string; title: string; status: string; priority: string; project_id: string;
  due_date: string | null; reschedule_count: number | null; updated_at: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const MAX_CHECKIN_ITEMS = 25;
const MAX_AT_RISK = 2;
const AT_RISK_POOL = 200;
const MIN_AT_RISK_SCORE = 5;
const OVERDUE_WEIGHT = 2;
const MAX_OVERDUE_POINTS = 30;
const SLIP_WEIGHT = 5;
const DUE_TODAY_POINTS = 6;
const URGENT_POINTS = 6;
const HIGH_POINTS = 3;
const QUIET_DAYS = 14;
const DAYS_PER_WEEK = 7;
const MAX_QUIET_POINTS = 6;

/** True when a due date moves to a later day, i.e. the task slipped. */
export function isLaterDueDate(previous: string | null, next: string | null): boolean {
  return previous !== null && next !== null && next.slice(0, previous.length) > previous;
}

export function workDay(input: unknown): string {
  return typeof input === 'string' && DATE_RE.test(input) ? input : ukClock().day;
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(from)) / MS_PER_DAY);
}

function toNudge(r: NudgeRow): NudgeTask {
  return { id: r.id, title: r.title, status: r.status, priority: r.priority, projectId: r.project_id, dueDate: r.due_date, rescheduleCount: r.reschedule_count ?? 0 };
}

/** Scores how likely an open task is being forgotten. Undated, unprioritised backlog (someday) never scores. */
export function scoreAtRisk(r: NudgeRow, today: string): AtRiskTask | null {
  const slips = r.reschedule_count ?? 0;
  const reasons: string[] = [];
  let score = 0;
  if (r.due_date !== null && r.due_date < today) {
    const late = daysBetween(r.due_date, today);
    score += Math.min(late * OVERDUE_WEIGHT, MAX_OVERDUE_POINTS);
    reasons.push(`overdue ${late} day${late === 1 ? '' : 's'}`);
  } else if (r.due_date === today) {
    score += DUE_TODAY_POINTS;
    reasons.push('due today');
  }
  if (slips > 0) {
    score += slips * SLIP_WEIGHT;
    reasons.push(`pushed back ${slips} time${slips === 1 ? '' : 's'}`);
  }
  const committed = r.due_date !== null || r.status === 'in-progress' || r.priority === 'urgent' || r.priority === 'high';
  if (!committed) return null;
  const quiet = daysBetween(r.updated_at, today);
  if (quiet >= QUIET_DAYS) {
    score += Math.min(Math.floor(quiet / DAYS_PER_WEEK), MAX_QUIET_POINTS);
    reasons.push(`untouched ${quiet} days`);
  }
  if (r.priority === 'urgent') score += URGENT_POINTS;
  else if (r.priority === 'high') score += HIGH_POINTS;
  if (score < MIN_AT_RISK_SCORE || reasons.length === 0) return null;
  const reason = reasons.join(', ');
  return { ...toNudge(r), score, reason: reason.charAt(0).toUpperCase() + reason.slice(1) };
}

const NUDGE_COLUMNS = `id::text, title, status, priority, project_id, to_char(due_date, 'YYYY-MM-DD') AS due_date,
  reschedule_count, updated_at::text`;

export async function atRiskTasks(db: Pool, today: string, limit = MAX_AT_RISK): Promise<AtRiskTask[]> {
  const result = await db.query<NudgeRow>(
    `SELECT ${NUDGE_COLUMNS} FROM tasks
      WHERE archived = false AND status IN ('backlog', 'in-progress')
      ORDER BY due_date ASC NULLS LAST, updated_at ASC LIMIT $1`, [AT_RISK_POOL]);
  return result.rows
    .map((r) => scoreAtRisk(r, today))
    .filter((t): t is AtRiskTask => t !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function getCheckin(db: Pool, day: string): Promise<CheckinState> {
  const [state, items, done] = await Promise.all([
    db.query<{ status: 'completed' | 'skipped' }>('SELECT status FROM day_checkins WHERE day = $1', [day]),
    db.query<NudgeRow>(
      `SELECT ${NUDGE_COLUMNS} FROM tasks
        WHERE archived = false AND status IN ('backlog', 'in-progress')
          AND (due_date <= $1::date OR status = 'in-progress')
        ORDER BY due_date ASC NULLS LAST, updated_at ASC LIMIT $2`, [day, MAX_CHECKIN_ITEMS]),
    db.query<{ id: string; title: string }>(
      `SELECT id::text, title FROM tasks
        WHERE status = 'completed' AND (updated_at AT TIME ZONE 'Europe/London')::date = $1::date
        ORDER BY updated_at DESC LIMIT $2`, [day, MAX_CHECKIN_ITEMS]),
  ]);
  return { day, hour: ukClock().hour, status: state.rows[0]?.status ?? null, items: items.rows.map(toNudge), completedToday: done.rows };
}

export async function saveCheckin(db: Pool, day: string, status: 'completed' | 'skipped', settled: unknown[]): Promise<void> {
  await db.query(
    `INSERT INTO day_checkins (day, status, settled) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (day) DO UPDATE SET status = EXCLUDED.status, settled = EXCLUDED.settled, created_at = NOW()`,
    [day, status, JSON.stringify(settled)]);
}
