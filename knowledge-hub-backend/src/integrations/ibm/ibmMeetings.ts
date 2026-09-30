/**
 * integrations/ibm/ibmMeetings.ts — IBM work meetings from the daily
 * M365 Copilot summary, pasted by the user.
 *
 * IBM blocks app access to the work mailbox/calendar, so the day's meeting
 * list Copilot produces ("08:30–08:55: Title, organised by X, with Y. Prep
 * recommended.") is pasted into Athena. Each line becomes a calendar item
 * (content_items, source 'graph-calendar', sourceId 'ibm-paste-…' — the same
 * shape as POST /api/capture/ibm-calendar), so it shows on Calendar/Today and
 * in Athena's "today's schedule" context.
 *
 * Plan tasks are created only for a clear action ("Prep recommended"), and
 * never when a task with the same title already exists in any state.
 */

import type { Pool } from 'pg';
import { upsertContentItem } from '../../db/queries.js';
import type { ContentItem } from '../../types/contentItem.js';

export const WORK_TIMEZONE = 'Europe/London';

const MIN_MEETING_LINES = 2;
const HHMM_LENGTH = 5;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const SLUG_MAX_CHARS = 40;

export interface ParsedMeeting {
  start: string; // HH:MM, London time
  end: string;
  title: string;
  organiser: string | null;
  attendees: string[];
  prepRecommended: boolean;
  externalInvitees: boolean;
  conflictNote: string | null;
}

const LINE = /^\s*[-*•]?\s*(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})\s*:?\s*(.+?)\s*$/;

/** True when the text looks like a pasted Copilot meeting list (2+ timed lines). */
export function looksLikeMeetingList(text: string): boolean {
  return text.split('\n').filter((l) => LINE.test(l)).length >= MIN_MEETING_LINES;
}

function splitNames(list: string): string[] {
  return list
    .replace(/\b(required|among the invitees|and others)\b/gi, '')
    .split(/,|\band\b/)
    .map((n) => n.trim().replace(/\.$/, ''))
    .filter((n) => n !== '');
}

export function parseMeetingList(text: string): ParsedMeeting[] {
  const meetings: ParsedMeeting[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw);
    if (m === null) continue;
    const [, start = '', end = '', rest = ''] = m;
    const conflict = /⚠️?\s*(Conflicts?[^.]*\.?)/i.exec(rest);
    const withoutConflict = conflict === null ? rest : rest.replace(conflict[0], '').trim();
    const organisedIdx = withoutConflict.search(/,?\s*organi[sz]ed by /i);
    const titleEnd = organisedIdx >= 0 ? organisedIdx : withoutConflict.search(/\.(\s|$)/);
    const title = (titleEnd >= 0 ? withoutConflict.slice(0, titleEnd) : withoutConflict).replace(/\s*,\s*$/, '').trim();
    const organiser = /organi[sz]ed by ([^,.]+)/i.exec(withoutConflict)?.[1]?.trim() ?? null;
    const withList = organisedIdx >= 0 ? /,\s*with ([^.]+)/i.exec(withoutConflict.slice(organisedIdx))?.[1] : undefined;
    meetings.push({
      start: start.padStart(HHMM_LENGTH, '0'),
      end: end.padStart(HHMM_LENGTH, '0'),
      title,
      organiser,
      attendees: withList !== undefined ? splitNames(withList) : [],
      prepRecommended: /prep recommended/i.test(rest),
      externalInvitees: /external invitees/i.test(rest),
      conflictNote: conflict?.[1]?.trim() ?? null,
    });
  }
  return meetings;
}

/** Today's date (YYYY-MM-DD) in the work timezone. */
export function workToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: WORK_TIMEZONE }).format(now);
}

/** Converts a London wall-clock date + HH:MM to a UTC ISO string (handles BST/GMT). */
function londonToUtc(date: string, time: string): string {
  const naive = new Date(`${date}T${time}:00Z`);
  const offsetName = new Intl.DateTimeFormat('en-GB', { timeZone: WORK_TIMEZONE, timeZoneName: 'shortOffset' })
    .formatToParts(naive).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const hours = Number(/GMT([+-]\d+)?/.exec(offsetName)?.[1] ?? '0');
  return new Date(naive.getTime() - hours * MS_PER_HOUR).toISOString();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, SLUG_MAX_CHARS);
}

/** Picks the project a meeting belongs to from words in its title (else IBM practice). */
async function projectFor(db: Pool, title: string): Promise<string> {
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM projects`);
  const lower = title.toLowerCase();
  const hit = rows.find((p) => p.id !== 'personal' && (lower.includes(p.name.toLowerCase()) || lower.includes(p.id.replace(/-/g, ' '))));
  return hit?.id ?? 'ibm-msft-practice';
}

export interface MeetingImportResult {
  date: string;
  imported: number;
  removed: number;
  tasksCreated: string[];
  tasksAlreadyThere: string[];
}

/**
 * Saves a pasted meeting list for `date` (default: today, London). Replaces
 * that day's earlier paste, so cancelled meetings disappear.
 */
export async function importMeetingList(db: Pool, text: string, date = workToday()): Promise<MeetingImportResult> {
  const meetings = parseMeetingList(text);
  const dayLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const ids: string[] = [];
  const tasksCreated: string[] = [];
  const tasksAlreadyThere: string[] = [];

  for (const m of meetings) {
    const sourceId = `ibm-paste-${date}-${m.start.replace(':', '')}-${slug(m.title)}`;
    ids.push(sourceId);
    const startIso = londonToUtc(date, m.start);
    const endIso = londonToUtc(date, m.end);
    const details = [
      m.organiser !== null ? `Organised by ${m.organiser}` : '',
      m.attendees.length > 0 ? `With ${m.attendees.join(', ')}` : '',
      m.externalInvitees ? 'External invitees' : '',
      m.prepRecommended ? 'Prep recommended' : '',
      m.conflictNote ?? '',
    ].filter(Boolean);
    const item: Omit<ContentItem, 'id' | 'indexedAt'> = {
      source: 'graph-calendar',
      sourceId,
      title: m.title,
      summary: [`${m.start}–${m.end}`, ...details].join(' · '),
      body: details.join('\n'),
      publishedAt: startIso,
      projectContext: await projectFor(db, m.title),
      metadata: {
        source: 'ibm-work',
        start: startIso,
        end: endIso,
        isAllDay: false,
        organiser: m.organiser,
        attendees: m.attendees,
        prepRecommended: m.prepRecommended,
        externalInvitees: m.externalInvitees,
        conflictNote: m.conflictNote,
        importedManually: true,
      },
      tags: [],
    };
    await upsertContentItem(db, item);

    if (m.prepRecommended) {
      const title = `Prep: ${m.title} (${dayLabel} ${m.start})`;
      // Any existing task with this title — open, done or archived — means it's already on the Plan.
      const existing = await db.query(`SELECT 1 FROM tasks WHERE lower(title) = lower($1) LIMIT 1`, [title]);
      if (existing.rowCount !== null && existing.rowCount > 0) {
        tasksAlreadyThere.push(title);
      } else {
        await db.query(
          `INSERT INTO tasks (title, body, status, project_id, tags, priority, due_date) VALUES ($1, $2, 'backlog', $3, $4, 'normal', $5)`,
          [title, `Copilot recommends preparing for this meeting.\n${item.summary}`, item.projectContext, [], date],
        );
        tasksCreated.push(title);
      }
    }
  }

  const removed = await db.query(
    `DELETE FROM content_items WHERE source = 'graph-calendar' AND source_id LIKE $1 AND NOT (source_id = ANY($2::text[]))`,
    [`ibm-paste-${date}-%`, ids],
  );
  return { date, imported: meetings.length, removed: removed.rowCount ?? 0, tasksCreated, tasksAlreadyThere };
}

/** Today's meetings (both calendars), for Athena's context. */
export async function buildTodayScheduleBlock(db: Pool, now = new Date()): Promise<string> {
  const date = workToday(now);
  const dayStart = londonToUtc(date, '00:00');
  const dayEnd = new Date(new Date(dayStart).getTime() + MS_PER_DAY).toISOString();
  const { rows } = await db.query<{ title: string; summary: string; published_at: Date; source_id: string }>(
    `SELECT title, summary, published_at, source_id FROM content_items
      WHERE source = 'graph-calendar' AND published_at >= $1 AND published_at < $2
      ORDER BY published_at`,
    [dayStart, dayEnd],
  );
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: WORK_TIMEZONE, hour: '2-digit', minute: '2-digit' });
  const dateLabel = new Intl.DateTimeFormat('en-GB', { timeZone: WORK_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  const lines = [
    `## Today — ${dateLabel} (UK time now ${timeFmt.format(now)})`,
    rows.length === 0
      ? 'No meetings recorded for today (the IBM diary is only known if Richard pastes the Copilot meeting list).'
      : 'Meetings today:',
    ...rows.map((r) => {
      const where = r.source_id.startsWith('ibm-') ? 'IBM' : 'personal';
      return `- ${r.summary.startsWith(timeFmt.format(r.published_at)) ? '' : `${timeFmt.format(r.published_at)} `}${r.title} [${where}] — ${r.summary}`;
    }),
  ];
  return lines.join('\n');
}
