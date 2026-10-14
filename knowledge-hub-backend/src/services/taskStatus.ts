/**
 * Plan task statuses. Athena-created tasks start in the Inbox for review;
 * Blocked and Awaiting feedback were merged into Waiting (with a "waiting on" note).
 */
export const TASK_STATUSES = ['inbox', 'backlog', 'in-progress', 'waiting', 'completed'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

const LEGACY_STATUSES: Record<string, TaskStatus> = { blocked: 'waiting', 'awaiting-feedback': 'waiting' };

/** Accepts current and legacy status values; returns undefined for anything else. */
export function normaliseTaskStatus(value: unknown): TaskStatus | undefined {
  if (typeof value !== 'string') return undefined;
  if ((TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  return LEGACY_STATUSES[value];
}
