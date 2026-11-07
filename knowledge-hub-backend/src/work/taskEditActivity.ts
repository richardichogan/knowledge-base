import type { Pool, PoolClient } from 'pg';
import type { Task } from '../routes/tasks.js';
import { readChecklist } from '../services/taskChecklist.js';

export type TaskActivityActor = 'richard' | 'athena' | 'system';
export interface TaskFieldChange { field: string; label: string; from: string | null; to: string | null; long?: boolean }

const LONG_TEXT_LIMIT = 20_000;
const PRIORITY_LABELS: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const TYPE_LABELS: Record<string, string> = { standard: 'Standard', cert_session: 'Certification session', cert_review: 'Certification review' };

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};
const list = (values: readonly string[] | null | undefined): string | null => text([...(values ?? [])].sort().join(', '));
const sameList = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean => list(a) === list(b);

type Comparable = Pick<Task, 'title' | 'body' | 'priority' | 'dueDate' | 'startDate' | 'endDate' | 'projectId' | 'tags'
  | 'waitingOn' | 'recurringCadence' | 'task_type' | 'checklist'>;

const dateText = (value: unknown): string | null => value instanceof Date
  ? `${value.getFullYear().toString()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : typeof value === 'string' ? value.slice(0, 'YYYY-MM-DD'.length) : null;

/** Reads a raw tasks row (pg row or to_jsonb snapshot) for comparison. */
export function comparableTaskRow(row: Record<string, unknown>): Comparable {
  return {
    title: String(row['title'] ?? ''), body: String(row['body'] ?? ''), priority: row['priority'] as Task['priority'],
    dueDate: dateText(row['due_date']), startDate: dateText(row['start_date']), endDate: dateText(row['end_date']),
    projectId: String(row['project_id'] ?? ''), tags: Array.isArray(row['tags']) ? row['tags'] as string[] : [],
    waitingOn: (row['waiting_on'] as string | null | undefined) ?? null,
    recurringCadence: (row['recurring_cadence'] as Task['recurringCadence'] | undefined) ?? null,
    task_type: (row['task_type'] as Task['task_type'] | undefined) ?? 'standard', checklist: readChecklist(row['checklist']),
  };
}

async function projectNames(db: Pool | PoolClient, ids: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ANY($1)', [ids]);
  return new Map(rows.map(row => [row.id, row.name]));
}

export async function taxonomyTagNames(db: Pool | PoolClient, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ name: string }>('SELECT name FROM tags WHERE id::text = ANY($1) ORDER BY name', [[...ids]]);
  return rows.map(row => row.name);
}

/** Lists every user-visible field that differs between two saved versions of a task; status has its own activity entry. */
export async function diffTaskForActivity(db: Pool | PoolClient, before: Comparable, after: Comparable,
  tagNames?: { before: string[]; after: string[] }): Promise<TaskFieldChange[]> {
  const changes: TaskFieldChange[] = [];
  const push = (field: string, label: string, from: string | null, to: string | null): void => {
    if (from !== to) changes.push({ field, label, from, to });
  };
  push('title', 'Title', text(before.title), text(after.title));
  if ((before.body ?? '') !== (after.body ?? '')) {
    changes.push({ field: 'body', label: 'Description', long: true,
      from: text(before.body)?.slice(0, LONG_TEXT_LIMIT) ?? null, to: text(after.body)?.slice(0, LONG_TEXT_LIMIT) ?? null });
  }
  push('priority', 'Priority', PRIORITY_LABELS[before.priority] ?? before.priority, PRIORITY_LABELS[after.priority] ?? after.priority);
  push('dueDate', 'Due date', before.dueDate, after.dueDate);
  push('startDate', 'Start date', before.startDate, after.startDate);
  push('endDate', 'Repeat until', before.endDate, after.endDate);
  push('recurringCadence', 'Repeats', before.recurringCadence, after.recurringCadence);
  push('waitingOn', 'Waiting on', text(before.waitingOn), text(after.waitingOn));
  push('task_type', 'Type', TYPE_LABELS[before.task_type] ?? before.task_type, TYPE_LABELS[after.task_type] ?? after.task_type);
  if (before.projectId !== after.projectId) {
    const names = await projectNames(db, [before.projectId, after.projectId]);
    push('projectId', 'Workstream', names.get(before.projectId) ?? before.projectId, names.get(after.projectId) ?? after.projectId);
  }
  if (!sameList(before.tags, after.tags)) push('tags', 'Labels', list(before.tags), list(after.tags));
  if (tagNames && !sameList(tagNames.before, tagNames.after)) push('taxonomyTags', 'Tags', list(tagNames.before), list(tagNames.after));

  const previous = new Map(before.checklist.map(item => [item.id, item]));
  const next = new Set(after.checklist.map(item => item.id));
  for (const item of after.checklist) {
    const old = previous.get(item.id);
    if (!old) { changes.push({ field: 'checklist', label: 'Sub-task added', from: null, to: item.title }); continue; }
    if (old.title !== item.title) changes.push({ field: 'checklist', label: 'Sub-task renamed', from: old.title, to: item.title });
    if (old.done !== item.done) changes.push({ field: 'checklist', label: item.done ? 'Sub-task completed' : 'Sub-task reopened', from: null, to: item.title });
  }
  for (const item of before.checklist) {
    if (!next.has(item.id)) changes.push({ field: 'checklist', label: 'Sub-task removed', from: item.title, to: null });
  }
  return changes;
}

function summarise(changes: TaskFieldChange[]): string {
  return changes.map(change => change.long
    ? `${change.label} changed`
    : change.from !== null && change.to !== null ? `${change.label}: ${change.from} -> ${change.to}`
      : `${change.label}: ${change.to ?? change.from ?? ''}${change.to === null && change.field !== 'checklist' ? ' (cleared)' : ''}`).join('\n');
}

export async function recordTaskEdit(db: Pool | PoolClient, taskId: string, actor: TaskActivityActor,
  changes: TaskFieldChange[]): Promise<void> {
  if (changes.length === 0) return;
  await db.query('INSERT INTO task_notes(task_id,body,activity) VALUES($1,$2,$3)',
    [taskId, summarise(changes), JSON.stringify({ actor, action: 'task-edited', changes })]);
}

export async function recordTaskCreated(db: Pool | PoolClient, taskId: string, actor: TaskActivityActor): Promise<void> {
  await db.query('INSERT INTO task_notes(task_id,body,activity) VALUES($1,$2,$3)',
    [taskId, 'Task created', JSON.stringify({ actor, action: 'task-created' })]);
}
