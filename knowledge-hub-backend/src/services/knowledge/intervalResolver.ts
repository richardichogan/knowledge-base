/* eslint-disable @typescript-eslint/no-magic-numbers -- time, size and ranking constants */
/**
 * Relative and explicit date intervals for structured knowledge queries
 * (spec 5.7). Relative phrases resolve in the configured user timezone
 * (initially Europe/London); the result carries the UTC boundaries actually
 * used so the interpretation can be shown. Intervals are start-inclusive and
 * end-exclusive, and DST changes are handled by converting local midnights,
 * never by adding a fixed 24 hours.
 */

export const KNOWLEDGE_TIMEZONE = 'Europe/London';

export type RelativeIntervalKind =
  | 'today' | 'yesterday' | 'tomorrow'
  | 'this_week' | 'last_week' | 'next_week'
  | 'this_month' | 'last_month';

export interface KnowledgeInterval {
  kind: RelativeIntervalKind | 'explicit';
  timezone: string;
  /** Inclusive UTC start. */
  startUtc: string;
  /** Exclusive UTC end. */
  endUtc: string;
  /** Local calendar dates (YYYY-MM-DD) of the same boundaries, for DATE columns. */
  startLocalDate: string;
  endLocalDate: string;
}

interface LocalDate { y: number; m: number; d: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function offsetMs(instantMs: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc requires the assertions (noUncheckedIndexedAccess)
  const asUtc = Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!, parts['hour']!, parts['minute']!, parts['second']!);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

export function localDateOf(instant: Date, tz = KNOWLEDGE_TIMEZONE): LocalDate {
  const ms = instant.getTime() + offsetMs(instant.getTime(), tz);
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** UTC instant of local midnight at the start of `date` in `tz`. */
export function localMidnightUtc(date: LocalDate, tz = KNOWLEDGE_TIMEZONE): Date {
  const wallAsUtc = Date.UTC(date.y, date.m - 1, date.d);
  let guess = wallAsUtc - offsetMs(wallAsUtc, tz);
  guess = wallAsUtc - offsetMs(guess, tz);
  return new Date(guess);
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
const dateString = (d: LocalDate): string => `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;

function build(kind: KnowledgeInterval['kind'], start: LocalDate, end: LocalDate, tz: string): KnowledgeInterval {
  return {
    kind,
    timezone: tz,
    startUtc: localMidnightUtc(start, tz).toISOString(),
    endUtc: localMidnightUtc(end, tz).toISOString(),
    startLocalDate: dateString(start),
    endLocalDate: dateString(end),
  };
}

export function resolveRelativeInterval(kind: RelativeIntervalKind, now: Date, tz = KNOWLEDGE_TIMEZONE): KnowledgeInterval {
  const today = localDateOf(now, tz);
  switch (kind) {
    case 'today': return build(kind, today, addDays(today, 1), tz);
    case 'yesterday': return build(kind, addDays(today, -1), today, tz);
    case 'tomorrow': return build(kind, addDays(today, 1), addDays(today, 2), tz);
    case 'this_week':
    case 'last_week':
    case 'next_week': {
      const weekday = (new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay() + 6) % 7; // Monday = 0
      const monday = addDays(today, -weekday + (kind === 'last_week' ? -7 : kind === 'next_week' ? 7 : 0));
      return build(kind, monday, addDays(monday, 7), tz);
    }
    case 'this_month': return build(kind, { ...today, d: 1 }, nextMonth(today), tz);
    case 'last_month': {
      const first = { ...today, d: 1 };
      const prev = addDays(first, -1);
      return build(kind, { ...prev, d: 1 }, first, tz);
    }
  }
}

function nextMonth(d: LocalDate): LocalDate {
  return d.m === 12 ? { y: d.y + 1, m: 1, d: 1 } : { y: d.y, m: d.m + 1, d: 1 };
}

export class IntervalError extends Error {
  constructor(message: string) { super(message); this.name = 'IntervalError'; }
}

function parseInstant(value: string, label: string): Date {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(date.getTime())) throw new IntervalError(`${label} must be an ISO date or timestamp`);
  return date;
}

/** An explicit UTC range: start included, end excluded. */
export function explicitUtcInterval(start: string, end: string): KnowledgeInterval {
  const s = parseInstant(start, 'start');
  const e = parseInstant(end, 'end');
  if (e.getTime() <= s.getTime()) throw new IntervalError('end must be after start');
  const tz = 'UTC';
  return {
    kind: 'explicit', timezone: tz, startUtc: s.toISOString(), endUtc: e.toISOString(),
    startLocalDate: s.toISOString().slice(0, 10), endLocalDate: e.toISOString().slice(0, 10),
  };
}

export function intervalContains(interval: KnowledgeInterval, instant: Date | string): boolean {
  const t = new Date(instant).getTime();
  return t >= Date.parse(interval.startUtc) && t < Date.parse(interval.endUtc);
}

const PHRASES: [RegExp, RelativeIntervalKind][] = [
  [/^this week$/, 'this_week'], [/^last week$/, 'last_week'], [/^next week$/, 'next_week'],
  [/^today$/, 'today'], [/^yesterday$/, 'yesterday'], [/^tomorrow$/, 'tomorrow'],
  [/^this month$/, 'this_month'], [/^last month$/, 'last_month'],
];

/** Maps a small closed set of phrases; anything else is not guessed. */
export function parseRelativePhrase(phrase: string): RelativeIntervalKind | null {
  const text = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [pattern, kind] of PHRASES) if (pattern.test(text)) return kind;
  return null;
}
