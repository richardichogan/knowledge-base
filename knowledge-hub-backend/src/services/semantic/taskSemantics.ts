/**
 * Shared Plan/Today task semantics. Plan review (services/planReview.ts), nudges (services/planNudges.ts),
 * the Plan UI and chat all compare a `YYYY-MM-DD` due date strictly against the Europe/London work day.
 * This module is the single definition used by the semantic rules; tests prove the other call sites agree.
 */
import { ukClock } from '../../sync/ukClock.js';
import { normaliseTaskStatus, type TaskStatus } from '../taskStatus.js';

const DATE_PART_WIDTH = 2;
const ISO_DATE_LENGTH = 10;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** The work day a clock instant falls in (UK time), as used by Today/Plan. */
export function workDayAt(now: Date): string {
  return ukClock(now).day;
}

/**
 * Interprets a stored due value exactly like the task mapper: a DATE becomes its calendar day, and a timestamp
 * string keeps its date part (no timezone conversion). Returns null when there is no due date and undefined
 * when the value cannot be interpreted.
 */
export function normaliseDueDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    const part = (n: number): string => String(n).padStart(DATE_PART_WIDTH, '0');
    return `${value.getFullYear()}-${part(value.getMonth() + 1)}-${part(value.getDate())}`;
  }
  if (typeof value === 'string' && DATE_PREFIX.test(value)) return value.slice(0, ISO_DATE_LENGTH);
  return undefined;
}

/** Due boundary: a task is overdue only on days strictly after its due day. */
export function isDueDayPast(dueDay: string, today: string): boolean {
  return dueDay < today;
}

/** The app's only blocked representation: legacy blocked/awaiting-feedback were merged into Waiting. */
export function isBlockedStatus(status: TaskStatus): boolean {
  return status === 'waiting';
}

export { normaliseTaskStatus };
