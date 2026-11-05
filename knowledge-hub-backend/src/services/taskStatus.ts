/**
 * Plan task statuses. Athena-created tasks start in the Inbox for review.
 * Blocked means the work cannot progress; Waiting means it is on someone or
 * something else (with a "waiting on" note). Legacy Awaiting feedback maps to Waiting.
 */
export const TASK_STATUSES = ['inbox', 'backlog', 'in-progress', 'blocked', 'waiting', 'completed'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

const LEGACY_STATUSES: Record<string, TaskStatus> = { 'awaiting-feedback': 'waiting' };

/** Accepts current and legacy status values; returns undefined for anything else. */
export function normaliseTaskStatus(value: unknown): TaskStatus | undefined {
  if (typeof value !== 'string') return undefined;
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  return LEGACY_STATUSES[value];
}
