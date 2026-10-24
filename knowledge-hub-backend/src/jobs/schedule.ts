import type { JobDefinition } from './contracts.js';
import { JOB_LIMITS } from './contracts.js';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../config/constants.js';
export const JOB_LOOKAHEAD_DAYS = 8;
const OFFSET_PROBE_HOURS = 36;
const HALF_DAY_HOURS = 12;

const formatters = new Map<string, Intl.DateTimeFormat>();
export function localClock(date: Date, timezone: string): { day: string; time: string } {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, f);
  }
  const parts = f.formatToParts(date);
  const part = (key: string): string => parts.find(p => p.type === key)!.value;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

function wallInstant(day: string, time: string, timezone: string): Date {
  const wall = Date.parse(`${day}T${time}:00Z`);
  const offsets = new Set<number>();
  for (const delta of [-OFFSET_PROBE_HOURS, -HALF_DAY_HOURS, 0, HALF_DAY_HOURS, OFFSET_PROBE_HOURS]) {
    const stamp = wall + delta * MS_PER_HOUR;
    const local = localClock(new Date(stamp), timezone);
    offsets.add(Date.parse(`${local.day}T${local.time}:00Z`) - stamp);
  }
  const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b);
  const exact = candidates.filter(stamp => {
    const clock = localClock(new Date(stamp), timezone);
    return clock.day === day && clock.time === time;
  });
  if (exact.length) return new Date(exact[0]!);
  // A nonexistent spring-forward minute runs at the first valid later minute.
  const later = candidates.filter(stamp => {
    const clock = localClock(new Date(stamp), timezone);
    return clock.day === day && clock.time > time;
  });
  let stamp = Math.min(...later);
  if (!Number.isFinite(stamp)) throw new Error('Cannot resolve schedule in this timezone.');
  while (Number.isFinite(stamp)) {
    const prior = localClock(new Date(stamp - MS_PER_MINUTE), timezone);
    if (prior.day !== day || prior.time < time) break;
    stamp -= MS_PER_MINUTE;
  }
  return new Date(stamp);
}

export function occurrences(schedule: JobDefinition['schedule'], from: Date, to: Date): Date[] {
  const found: Date[] = [];
  const first = Date.parse(`${localClock(from, schedule.timezone).day}T12:00:00Z`);
  const last = Date.parse(`${localClock(to, schedule.timezone).day}T12:00:00Z`);
  for (let dayStamp = first; dayStamp <= last; dayStamp += MS_PER_DAY) {
    const day = new Date(dayStamp);
    if (!schedule.days.includes(day.getUTCDay())) continue;
    for (const time of schedule.times) {
      const stamp = wallInstant(day.toISOString().slice(0, JOB_LIMITS.dateChars), time, schedule.timezone);
      if (stamp >= from && stamp <= to) found.push(stamp);
    }
  }
  return [...new Map(found.map(d => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime());
}
export function nextOccurrence(schedule: JobDefinition['schedule'], after: Date): Date {
  const next = occurrences(schedule, new Date(after.getTime() + 1), new Date(after.getTime() + JOB_LOOKAHEAD_DAYS * MS_PER_DAY))[0];
  if (!next) throw new Error('No scheduled occurrence within eight days.');
  return next;
}
