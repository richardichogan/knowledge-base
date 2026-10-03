/**
 * ai/contentSchedule.ts — when the next podcast recording and newsletter are due.
 * Two independent fortnightly cycles whose dates move (he records on Mondays now,
 * the newsletter goes out Friday or Monday). Each date rolls forward once it has
 * passed; a "Podcast Record" calendar event overrides the podcast date; a newsletter
 * published near its due date counts as that issue done.
 */
import type { Pool } from 'pg';
import { workToday } from '../integrations/ibm/ibmMeetings.js';

export type ScheduledFormat = 'podcast' | 'newsletter';

export interface ScheduleEntry {
  format: ScheduledFormat;
  /** Next due date, YYYY-MM-DD. */
  next: string;
  daysAway: number;
  intervalDays: number;
  note: string | null;
}

const DAY_MS = 86_400_000;
/** A deadline this close is too late for new topics — suggestions go to the one after. */
export const TOO_LATE_DAYS = 2;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

export async function getSchedule(db: Pool, now = new Date()): Promise<Record<ScheduledFormat, ScheduleEntry>> {
  const today = workToday(now);
  const { rows } = await db.query<{ format: ScheduledFormat; next_date: Date; interval_days: number; note: string | null }>(
    `SELECT format, to_char(next_date, 'YYYY-MM-DD') AS next_date, interval_days, note FROM content_schedule`,
  );
  const result = {} as Record<ScheduledFormat, ScheduleEntry>;
  for (const r of rows) {
    let next = r.next_date as unknown as string;
    const interval = Math.max(1, r.interval_days);

    if (r.format === 'podcast') {
      // A "Podcast Record" calendar event in the next two weeks is the truth.
      const ev = await db.query<{ d: string }>(
        `SELECT to_char(published_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS d FROM content_items
          WHERE source = 'graph-calendar' AND title ILIKE '%podcast record%'
            AND published_at >= $1::date AND published_at < $1::date + 15
          ORDER BY published_at LIMIT 1`,
        [today],
      ).catch(() => ({ rows: [] as Array<{ d: string }> }));
      if (ev.rows[0] !== undefined) next = ev.rows[0].d;
    } else {
      // A newsletter published within a few days of its due date means that issue is done.
      const pub = await db.query<{ d: string }>(
        `SELECT to_char(published_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS d FROM content_items
          WHERE source = 'cms-newsletter' ORDER BY published_at DESC LIMIT 1`,
      );
      const last = pub.rows[0]?.d;
      if (last !== undefined && Math.abs(daysBetween(next, last)) <= 4 && last >= addDays(next, -4)) next = addDays(last, interval);
    }

    while (next < today) next = addDays(next, interval);
    if (next !== (r.next_date as unknown as string)) {
      await db.query(`UPDATE content_schedule SET next_date = $2::date, updated_at = NOW() WHERE format = $1`, [r.format, next]).catch(() => undefined);
    }
    result[r.format] = { format: r.format, next, daysAway: daysBetween(today, next), intervalDays: interval, note: r.note };
  }
  return result;
}

/** Sets a due date by hand ("the newsletter's moved to Monday 12 Oct"). */
export async function setScheduleDate(db: Pool, format: ScheduledFormat, date: string, note?: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  await db.query(
    `INSERT INTO content_schedule (format, next_date, note) VALUES ($1, $2::date, $3)
     ON CONFLICT (format) DO UPDATE SET next_date = EXCLUDED.next_date, note = COALESCE($3, content_schedule.note), updated_at = NOW()`,
    [format, date, note ?? null],
  );
}

export function describeSchedule(s: Record<ScheduledFormat, ScheduleEntry>): string {
  const line = (e: ScheduleEntry | undefined, label: string): string => {
    if (e === undefined) return `${label}: no date set`;
    const when = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${e.next}T00:00:00Z`));
    const away = e.daysAway === 0 ? 'today' : e.daysAway === 1 ? 'tomorrow' : `in ${e.daysAway.toString()} days`;
    return `${label}: ${when} (${away})${e.note !== null && e.note !== '' ? ` — ${e.note}` : ''}`;
  };
  return [line(s.podcast, 'Next podcast recording'), line(s.newsletter, 'Next newsletter due')].join('\n');
}
