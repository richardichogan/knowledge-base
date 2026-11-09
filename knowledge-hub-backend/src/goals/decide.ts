/**
 * goals/decide.ts — Today's Decide queue: everything waiting on Richard's decision in one list, oldest first.
 * Publishing picks, open chat decisions, proactive proposals (held ones included), unsent email drafts and
 * Athena's suggestions for waiting tasks with nobody named. Each item acts through the existing endpoints and tools.
 */
import type { Pool } from 'pg';
import { getPublishingPicks } from '../publishing/picks.js';
import { proactiveOverview } from './proactive.js';
import { listDrafts } from '../work/workContent.js';
import { getFoundryClient } from '../ai/foundryClient.js';
import { convertOpenDecision } from './scorecard.js';
import { recordTaskEdit } from '../work/taskEditActivity.js';
import { ValidationError } from '../types/errors.js';

export type DecideKind = 'publishing' | 'decision' | 'promise' | 'chase' | 'cadence' | 'cfp' | 'paused' | 'email' | 'waiting';
export interface DecideItem {
  /** `<kind>:<refId>` — unique within the queue. */
  id: string; kind: DecideKind; refId: string; title: string; detail: string; source: string; createdAt: string; held: boolean;
  meta: Record<string, string | number | boolean | null>;
}

const DETAIL_LIMIT = 600;
const clip = (s: string, n = DETAIL_LIMIT): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const iso = (v: string | Date | null | undefined, fallback = new Date(0)): string => {
  const d = v instanceof Date ? v : v ? new Date(v.length === 10 ? `${v}T09:00:00Z` : v) : fallback;
  return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString();
};

// Waiting-on guesses: one small model call per changed set of tasks, cached by task id + updated_at.
const guessCache = new Map<string, string | null>();
async function guessWaitingOn(tasks: Array<{ id: string; title: string; body: string; notes: string; stamp: string }>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const todo = tasks.filter(t => { const hit = guessCache.get(`${t.id}:${t.stamp}`); if (hit !== undefined) out.set(t.id, hit); return hit === undefined; });
  if (todo.length === 0) return out;
  try {
    const raw = await getFoundryClient('waiting-on').chat('light', [
      { role: 'system', content: 'For each task Richard has marked as waiting, name the person, team or organisation he is most likely waiting on, using only evidence in the task text and notes. Return ONLY JSON {"guesses":[{"id":"…","who":"name or null"}]}. Use null when there is no evidence. Keep names short (e.g. "Sam Smith", "Microsoft legal").' },
      { role: 'user', content: todo.map(t => `id: ${t.id}\ntitle: ${t.title}\nbody: ${clip(t.body, 1_200)}\nnotes: ${clip(t.notes, 1_200)}`).join('\n\n---\n\n') },
    ], 600);
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { guesses?: Array<{ id?: unknown; who?: unknown }> };
    const byId = new Map((parsed.guesses ?? []).map(g => [String(g.id), typeof g.who === 'string' && g.who.trim() ? g.who.trim().slice(0, 120) : null]));
    for (const t of todo) { const who = byId.get(t.id) ?? null; guessCache.set(`${t.id}:${t.stamp}`, who); out.set(t.id, who); }
  } catch (error) {
    console.warn('[decide] waiting-on guess failed:', error instanceof Error ? error.message : error);
    for (const t of todo) out.set(t.id, null);
  }
  return out;
}

async function waitingTasks(db: Pool) {
  return (await db.query<{ id: string; title: string; body: string | null; updated_at: Date; notes: string | null }>(
    `SELECT t.id::text, t.title, t.body, t.updated_at,
        (SELECT string_agg(n.body, E'\\n' ORDER BY n.created_at DESC) FROM (SELECT body, created_at FROM task_notes WHERE task_id=t.id ORDER BY created_at DESC LIMIT 8) n) AS notes
      FROM tasks t WHERE t.status='waiting' AND NOT t.archived AND COALESCE(TRIM(t.waiting_on),'')=''
        AND NOT EXISTS (SELECT 1 FROM task_notes s WHERE s.task_id=t.id AND s.activity->>'action'='waiting-on-skipped' AND s.created_at >= t.updated_at)
      ORDER BY t.updated_at LIMIT 30`)).rows;
}

/** Athena's guess at who a task is waiting on (for the "Waiting on whom?" prompt). Never throws. */
export async function suggestWaitingOn(db: Pool, taskId: string): Promise<string | null> {
  const row = (await db.query<{ id: string; title: string; body: string | null; updated_at: Date; notes: string | null }>(
    `SELECT t.id::text, t.title, t.body, t.updated_at,
        (SELECT string_agg(body, E'\\n') FROM (SELECT body FROM task_notes WHERE task_id=t.id ORDER BY created_at DESC LIMIT 8) n) AS notes
      FROM tasks t WHERE t.id::text=$1`, [taskId])).rows[0];
  if (!row) return null;
  return (await guessWaitingOn([{ id: row.id, title: row.title, body: row.body ?? '', notes: row.notes ?? '', stamp: row.updated_at.toISOString() }])).get(row.id) ?? null;
}

export async function decideQueue(db: Pool): Promise<DecideItem[]> {
  const [picks, proactive, drafts, decisions, waiting] = await Promise.all([
    getPublishingPicks(db), proactiveOverview(db), listDrafts(db),
    db.query<{ id: string; text: string; created_at: Date; session_id: string; title: string | null }>(
      `SELECT d.id::text, d.text, d.created_at, d.session_id::text, s.title FROM chat_decisions d
        JOIN ai_chat_sessions s ON s.id=d.session_id WHERE d.status='open' ORDER BY d.created_at LIMIT 100`),
    waitingTasks(db),
  ]);
  const items: DecideItem[] = [];
  const pickIds = (picks?.picks ?? []).map(p => p.draftId);
  const pickRows = pickIds.length ? (await db.query<{ id: string; topic_id: string; destination: string; version: number; created_at: Date }>(
    'SELECT id::text, topic_id::text, destination, version, created_at FROM publishing_drafts WHERE id::text = ANY($1::text[])', [pickIds])).rows : [];
  for (const p of picks?.picks ?? []) {
    const row = pickRows.find(r => r.id === p.draftId);
    if (!row) continue;
    items.push({ id: `publishing:${p.draftId}`, kind: 'publishing', refId: p.draftId, title: p.title, detail: p.reason,
      source: `Publishing pick · ${p.destinations.join(' / ')}`, createdAt: iso(row.created_at), held: false,
      meta: { topicId: row.topic_id, destination: row.destination, version: row.version } });
  }
  for (const d of decisions.rows) {
    items.push({ id: `decision:${d.id}`, kind: 'decision', refId: d.id, title: d.text, detail: '', source: `Chat · ${d.title?.trim() || 'Untitled chat'}`,
      createdAt: iso(d.created_at), held: false, meta: { sessionId: d.session_id } });
  }
  const prep = proactive.meetingPrep;
  for (const p of prep.promises.filter(x => x.status === 'proposed')) {
    items.push({ id: `promise:${p.id}`, kind: 'promise', refId: p.id, title: p.text,
      detail: `${p.owner === 'richard' ? 'You promised' : `${p.who} promised`}${p.due ? `, due ${p.due}` : ''}.`, source: `Meeting promise · ${p.reportDate} briefing`,
      createdAt: iso(p.reportDate), held: Boolean(p.held), meta: { owner: p.owner, who: p.who, draftId: p.draftId } });
  }
  for (const c of prep.chases.filter(x => x.status === 'proposed')) {
    items.push({ id: `chase:${c.id}`, kind: 'chase', refId: c.id, title: `Chase: ${c.taskTitle}`,
      detail: `Waiting${c.waitingOn ? ` on ${c.waitingOn}` : ''} for ${c.workingDays} working days. Athena drafted a chase.`, source: 'Chase proposal',
      createdAt: iso(c.at), held: Boolean(c.held), meta: { taskId: c.taskId, draftId: c.draftId } });
  }
  for (const c of prep.cadence.filter(x => x.status === 'proposed')) {
    items.push({ id: `cadence:${c.id}`, kind: 'cadence', refId: c.id, title: `Keep in touch with ${c.person}`,
      detail: `${c.reason} Last contact ${c.workingDays} working days ago.`, source: 'Keep-in-touch proposal',
      createdAt: iso(c.at), held: Boolean(c.held), meta: { person: c.person } });
  }
  for (const c of proactive.cfps.shortlist) {
    items.push({ id: `cfp:${c.id}`, kind: 'cfp', refId: c.id, title: c.conference, detail: `${c.fit} CFP deadline ${c.deadline.slice(0, 10)}.`,
      source: 'CFP shortlist', createdAt: iso(c.deadline), held: Boolean(c.held), meta: { cfpUrl: c.cfpUrl, deadline: c.deadline } });
  }
  for (const p of proactive.paused.filter(x => x.status === 'open')) {
    items.push({ id: `paused:${p.key}`, kind: 'paused', refId: p.key, title: p.question, detail: `${p.subjectTitle} failed ${p.failures} times. Last error: ${clip(p.lastError, 300)}`,
      source: 'Paused by Athena', createdAt: iso(p.at), held: false, meta: {} });
  }
  for (const d of drafts.filter(x => x.status === 'draft')) {
    items.push({ id: `email:${d.noteId}`, kind: 'email', refId: d.noteId, title: d.subject || d.title, detail: `${d.channel === 'email' ? 'Email' : 'Message'} to ${d.to || 'nobody yet'}${d.taskTitle ? ` · task: ${d.taskTitle}` : ''}.`,
      source: 'Unsent draft', createdAt: iso(d.updatedAt), held: false, meta: { taskId: d.taskId, channel: d.channel } });
  }
  const guesses = await guessWaitingOn(waiting.map(t => ({ id: t.id, title: t.title, body: t.body ?? '', notes: t.notes ?? '', stamp: t.updated_at.toISOString() })));
  for (const t of waiting) {
    const guess = guesses.get(t.id) ?? null;
    items.push({ id: `waiting:${t.id}`, kind: 'waiting', refId: t.id, title: guess ? `Waiting on: ${guess}?` : 'Waiting on whom?', detail: t.title,
      source: 'Waiting task', createdAt: iso(t.updated_at), held: false, meta: { suggestion: guess, taskTitle: t.title } });
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Compact queue for Athena's context; ids are the refIds her tools take. */
export function decideSummary(items: DecideItem[]): string {
  if (items.length === 0) return 'Decide queue: empty.';
  return `Decide queue (${items.length}, oldest first):\n${items.map(i => `- [${i.kind} ${i.refId}] ${i.title}${i.held ? ' (held)' : ''} — ${i.source}, ${i.createdAt.slice(0, 10)}${i.kind === 'waiting' ? ` · task: ${String(i.meta.taskTitle)}` : ''}`).join('\n')}`;
}

/** Decide-queue actions without an existing endpoint: chat decisions and waiting-on confirmation. */
export async function decideAction(db: Pool, action: string, args: Record<string, unknown>, actor: 'richard' | 'athena'): Promise<unknown> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) throw new ValidationError('id is required', { id: 'required' });
  if (action === 'decision-decided' || action === 'decision-drop') {
    const status = action === 'decision-decided' ? 'decided' : 'dropped';
    const r = await db.query(`UPDATE chat_decisions SET status=$2, updated_at=NOW() WHERE id::text=$1 AND status='open'`, [id, status]);
    if (!r.rowCount) throw new ValidationError('That decision is no longer open.', { id: 'stale' });
    return { status };
  }
  if (action === 'decision-task' || action === 'decision-note' || action === 'decision-spark') {
    const created = await convertOpenDecision(db, id, action.slice('decision-'.length) as 'task' | 'note' | 'spark', actor);
    if (!created) throw new ValidationError('That decision is no longer open.', { id: 'stale' });
    return { created };
  }
  if (action === 'waiting-on') {
    const who = typeof args.waitingOn === 'string' ? args.waitingOn.trim().slice(0, 200) : '';
    if (!who) throw new ValidationError('waitingOn is required', { waitingOn: 'required' });
    const before = (await db.query<{ waiting_on: string | null }>('SELECT waiting_on FROM tasks WHERE id::text=$1', [id])).rows[0];
    if (!before) throw new ValidationError('Task not found.', { id: 'missing' });
    await db.query('UPDATE tasks SET waiting_on=$2, updated_at=NOW() WHERE id::text=$1', [id, who]);
    await recordTaskEdit(db, id, actor, [{ field: 'waitingOn', label: 'Waiting on', from: before.waiting_on, to: who }]);
    return { waitingOn: who };
  }
  if (action === 'waiting-skip') {
    // Skipping hides the suggestion until the task next changes; recorded in the task's activity.
    await db.query('INSERT INTO task_notes(task_id,body,activity) SELECT id,$2,$3 FROM tasks WHERE id::text=$1',
      [id, 'Waiting-on suggestion skipped.', JSON.stringify({ actor, action: 'waiting-on-skipped' })]);
    return { skipped: true };
  }
  throw new ValidationError(`Unknown decide action ${action}.`, { action: 'invalid' });
}
