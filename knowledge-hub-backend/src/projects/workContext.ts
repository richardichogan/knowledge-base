import type { Pool } from 'pg';
import { assertProject, getProjectCockpit, listRegister, type ProjectCockpit, type RegisterItem } from './cockpit.js';
import { queryTimeline } from '../db/queries.js';
import { parseNoteContent } from '../utils/noteContent.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import { NotFoundError, ValidationError } from '../types/errors.js';

const LIMIT = 30;
const INVITATION_CHARS = 8000;
const NOTE_EXCERPT_CHARS = 3000;
const STALE_NOTE_DAYS = 14;
const DAY_MS = 86400000;
interface Change {
  id: string; kind: string; title: string; at: string; href: string; detail: string;
}
export interface ProjectChanges {
  since: string; until: string; items: Change[]; truncated: boolean;
}
interface Row { id: string; title: string; at: Date | string; detail: string; kind: string; href: string }
const iso = (value: Date | string): string => new Date(value).toISOString();
export function changesSince(value: unknown, now: Date): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))
    || Date.parse(value) > now.getTime()) throw new ValidationError('since must be a valid timestamp no later than now.');
  return new Date(value).toISOString();
}

/** Current changed records, not an audit diff or an inferred account of what changed. */
export async function getProjectChanges(db: Pool, projectId: string, sinceValue: unknown, now = new Date()): Promise<ProjectChanges> {
  await assertProject(db, projectId);
  const since = changesSince(sinceValue, now);
  const rows = await db.query<Row>(`
    SELECT * FROM (
      SELECT id::text, 'note' AS kind, content AS title, updated_at AS at, 'Saved note updated' AS detail,
        '/think?noteId=' || id::text AS href
      FROM notes WHERE project_id=$1 AND status='active' AND updated_at>$2 AND updated_at<=$3
      UNION ALL
      SELECT id::text, 'task', title, updated_at, 'Current status: ' || status, '/plan?taskId=' || id::text
      FROM tasks WHERE project_id=$1 AND updated_at>$2 AND updated_at<=$3
      UNION ALL
      SELECT d.id::text, 'decision', d.text, d.updated_at, 'Current status: ' || d.status, '/chat?session=' || s.id::text
      FROM chat_decisions d JOIN ai_chat_sessions s ON s.id=d.session_id
      WHERE s.project_id=$1 AND d.updated_at>$2 AND d.updated_at<=$3
      UNION ALL
      SELECT id::text, kind, title, updated_at, 'Current status: ' || status, '/projects?projectId=' || project_id
      FROM project_register_items WHERE project_id=$1 AND updated_at>$2 AND updated_at<=$3
    ) changes ORDER BY at DESC, id LIMIT $4`, [projectId, since, now.toISOString(), LIMIT + 1]);
  // The timeline uses source update/publication time, not reindex time, and its canonical de-duplication rules.
  const activity = await queryTimeline(db, { projectContext: projectId, since, pageSize: LIMIT + 1 });
  const local: Change[] = rows.rows.slice(0, LIMIT).map(row => ({
    ...row, title: row.kind === 'note' ? parseNoteContent(row.title).title ?? 'Untitled note' : row.title,
    at: iso(row.at),
  }));
  const external: Change[] = activity.items.filter(item => !['task', 'note', 'graph-calendar'].includes(item.source)).map(item => {
    const updated = item.metadata['updatedAt'];
    const at = typeof updated === 'string' && Number.isFinite(Date.parse(updated)) ? updated : item.publishedAt;
    const url = item.url;
    return { id: item.id, kind: item.source, title: item.title, at: iso(at), detail: item.summary,
      href: url && /^https?:\/\//i.test(url) ? url : '/my-work' };
  });
  const all = [...local, ...external].filter(item => item.at <= now.toISOString()).sort((a, b) => b.at.localeCompare(a.at));
  return { since, until: now.toISOString(), items: all.slice(0, LIMIT),
    truncated: rows.rows.length > LIMIT || activity.total > LIMIT || all.length > LIMIT };
}

export interface MeetingPreparation {
  generatedAt: string;
  meeting: { id: string; title: string; start: string; body: string; bodyTruncated: boolean; attendees: string[]; cancelled: boolean };
  projectId: string | null;
  cockpit: ProjectCockpit | null;
  register: RegisterItem[];
  registerTruncated: boolean;
  notes: Array<{ id: string; title: string; text: string; updatedAt: string; truncated: boolean }>;
  limitations: string[];
}
export async function prepareMeeting(db: Pool, eventId: string, projectId?: string, now = new Date()): Promise<MeetingPreparation> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(eventId)) throw new ValidationError('A valid calendar item ID is required.');
  const { rows } = await db.query<{ id: string; title: string; body: string; published_at: Date | string; metadata: Record<string, unknown> }>(
    `SELECT id,title,body,published_at,metadata FROM content_items WHERE id=$1 AND source='graph-calendar'`, [eventId]);
  const event = rows[0];
  if (!event) throw new NotFoundError('Calendar event');
  const result: MeetingPreparation = {
    generatedAt: now.toISOString(),
    meeting: { id: event.id, title: event.title, start: iso(event.published_at), body: event.body.slice(0, INVITATION_CHARS), bodyTruncated: event.body.length > INVITATION_CHARS,
      attendees: Array.isArray(event.metadata.attendees) ? event.metadata.attendees.filter((value): value is string => typeof value === 'string') : [],
      cancelled: event.metadata.isCancelled === true },
    projectId: projectId ?? null, cockpit: null, register: [], registerTruncated: false, notes: [],
    limitations: ['This is indexed calendar and saved project evidence, not a live mailbox read or a generated account of previous meetings.'],
  };
  if (result.meeting.bodyTruncated) result.limitations.push('The calendar description is excerpted at 8,000 characters.');
  if (result.meeting.cancelled) result.limitations.push('This calendar event is marked cancelled.');
  if (!projectId) { result.limitations.push('No project selected. Project decisions, actions and notes have not been assessed.'); return result; }
  result.cockpit = await getProjectCockpit(db, projectId, now);
  const register = await listRegister(db, projectId, { status: 'open', limit: 25 });
  result.register = register.items;
  result.registerTruncated = register.total > register.items.length;
  const notes = await db.query<{ id: string; content: string; updated_at: Date | string }>(
    `SELECT id,content,updated_at FROM notes WHERE project_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 6`, [projectId]);
  for (const note of notes.rows) {
    const parsed = parseNoteContent(note.content);
    const text = parsed.contentType && !parsed.blocks.length ? 'No saved body text.' : await renderNoteAsText(db, note.content);
    result.notes.push({ id: note.id, title: parseNoteContent(note.content).title ?? 'Untitled note',
      text: text.slice(0, NOTE_EXCERPT_CHARS), updatedAt: iso(note.updated_at), truncated: text.length > NOTE_EXCERPT_CHARS });
  }
  result.limitations.push('Only the six most recently updated project notes are included, with at most 3,000 characters each. They are not verified minutes or a complete project review.');
  if (!notes.rows.length) result.limitations.push('No active notes are filed to this project.');
  if (notes.rows.some(note => now.getTime() - new Date(note.updated_at).getTime() > STALE_NOTE_DAYS * DAY_MS)) result.limitations.push('Some included notes have not been updated in over 14 days. Confirm that their contents still apply.');
  if (result.registerTruncated) result.limitations.push('Only the first 25 open register items are shown.');
  return result;
}
