/**
 * features/plan/taskInsights.ts
 * Pure helpers for the Plan board: task health flags, origin links,
 * the "recent completed" cut-off and the Athena page context.
 */
import type { PlanTask, TaskOrigin } from '../../types/task';

const DAY_MS = 86_400_000;
export const STALE_AFTER_DAYS = 14;
export const RECENT_COMPLETED_DAYS = 7;

export interface TaskHealth { kind: 'stale' | 'waiting'; label: string; title: string }

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS);
}

function ageLabel(days: number): string {
  return days < 56 ? `${Math.floor(days / 7)} wk` : `${Math.floor(days / 30)} mo`;
}

/** Flags open tasks nobody has touched for a while; waiting statuses read as "Waiting …". */
export function taskHealth(task: Pick<PlanTask, 'status' | 'updatedAt'>, now = new Date()): TaskHealth | null {
  if (task.status === 'completed') return null;
  const days = daysSince(task.updatedAt, now);
  if (days < STALE_AFTER_DAYS) return null;
  const waiting = task.status === 'blocked' || task.status === 'awaiting-feedback';
  return waiting
    ? { kind: 'waiting', label: `Waiting ${ageLabel(days)}`, title: `No change for ${days} days — chase it, unblock it or drop it.` }
    : { kind: 'stale', label: `Idle ${ageLabel(days)}`, title: `No update for ${days} days — still relevant?` };
}

export function isRecentlyCompleted(task: Pick<PlanTask, 'status' | 'updatedAt'>, now = new Date()): boolean {
  return task.status === 'completed' && daysSince(task.updatedAt, now) < RECENT_COMPLETED_DAYS;
}

/** In-app route for the item a task was created from. */
export function originHref(origin: TaskOrigin): string | null {
  if (origin.type === 'chat') return origin.url !== '' ? origin.url : `/chat?session=${encodeURIComponent(origin.id)}`;
  if (origin.type === 'note') return `/think?noteId=${encodeURIComponent(origin.id)}`;
  return origin.url !== '' ? origin.url : null;
}

export function originLabel(origin: TaskOrigin): string {
  const kind = origin.type === 'chat' ? 'Athena chat' : origin.type === 'note' ? 'Note' : 'Link';
  return origin.title !== '' ? `${kind}: ${origin.title}` : kind;
}

const STATUS_LABEL: Record<PlanTask['status'], string> = {
  backlog: 'Backlog', 'in-progress': 'In progress', blocked: 'Blocked', 'awaiting-feedback': 'Awaiting feedback', completed: 'Completed',
};

function taskLine(task: PlanTask, projectName: (id: string) => string, today: string, now: Date): string {
  const bits = [task.priority !== 'normal' ? task.priority : '', projectName(task.projectId)];
  if (task.dueDate) bits.push(task.dueDate < today ? `OVERDUE (due ${task.dueDate})` : `due ${task.dueDate}`);
  const health = taskHealth(task, now);
  if (health) bits.push(health.label.toLowerCase());
  return `* ${task.title} [${bits.filter(Boolean).join(', ')}]`;
}

/** Text the Plan Athena panel sends as page context. */
export function planContextDetail(tasks: PlanTask[], projectName: (id: string) => string, today: string, now = new Date()): string {
  const open = tasks.filter((t) => t.status !== 'completed');
  const lines = [
    `The Plan page: the user's task board (Backlog, In progress, Blocked, Awaiting feedback, Completed). Help them triage, prioritise, break down and schedule tasks. Today is ${today}.`,
  ];
  for (const status of ['in-progress', 'blocked', 'awaiting-feedback', 'backlog'] as const) {
    const group = open.filter((t) => t.status === status);
    if (group.length === 0) continue;
    lines.push('', `${STATUS_LABEL[status]} (${group.length}):`, ...group.slice(0, 25).map((t) => taskLine(t, projectName, today, now)));
  }
  const done = tasks.filter((t) => isRecentlyCompleted(t, now));
  if (done.length > 0) lines.push('', `Completed this week (${done.length}):`, ...done.slice(0, 10).map((t) => `* ${t.title}`));
  return lines.join('\n');
}

export function taskAthenaPrompt(task: PlanTask, projectName: string): string {
  const facts = [
    `Task: ${task.title}`,
    `Status: ${STATUS_LABEL[task.status]} · Priority: ${task.priority} · Project: ${projectName}`,
    task.dueDate ? `Due: ${task.dueDate}` : 'No due date',
    task.body ? `Details: ${task.body}` : '',
  ].filter(Boolean).join('\n');
  return `Help me move this task forward. Break it into concrete next steps, flag anything blocking it, and suggest a realistic due date.\n\n${facts}`;
}
