import type { Pool } from 'pg';
import { record } from '../agents/workforce/contracts.js';
import { ConflictError, ValidationError } from '../types/errors.js';

const ACTIVITY_LIMIT = 30;
const ACTIVITY_BODY_LIMIT = 3000;
const REVIEW_REASON_LIMIT = 3000;
export interface TaskAssistanceContext {
  direction: string;
  activity: { body: string; activity: unknown; createdAt: string; truncated: boolean }[];
  activityMayBePartial: boolean;
}

export async function latestTaskDirection(db: Pick<Pool, 'query'>, taskId: string, ownerId: string): Promise<string> {
  return (await db.query<{ direction: string }>(
    `SELECT direction FROM task_assistance WHERE task_id=$1 AND owner_id=$2 AND btrim(direction)<>''
     ORDER BY created_at DESC,id DESC LIMIT 1`, [taskId, ownerId])).rows[0]?.direction.trim() ?? '';
}

export async function requireCurrentTaskDirection(
  db: Pick<Pool, 'query'>, taskId: string, ownerId: string, confirmed: string,
): Promise<void> {
  if (await latestTaskDirection(db, taskId, ownerId) !== confirmed.trim()) {
    throw new ConflictError('Your task direction changed or was omitted from this proposal. Reassess and approve the corrected work; no result was applied.',
      'TASK_ASSISTANCE_STALE');
  }
}

export async function taskAssistanceContext(
  db: Pick<Pool, 'query'>, taskId: string, ownerId: string, direction?: string,
): Promise<TaskAssistanceContext> {
  const previous = direction?.trim() ? '' : await latestTaskDirection(db, taskId, ownerId);
  const activity = (await db.query<{ body: string; activity: unknown; created_at: Date | string }>(
    'SELECT body,activity,created_at FROM task_notes WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',
    [taskId, ACTIVITY_LIMIT])).rows;
  return {
    direction: direction?.trim() || previous || '',
    activity: activity.reverse().map(item => ({ body: item.body.slice(0, ACTIVITY_BODY_LIMIT), activity: item.activity,
      createdAt: String(item.created_at), truncated: item.body.length > ACTIVITY_BODY_LIMIT })),
    activityMayBePartial: activity.length === ACTIVITY_LIMIT,
  };
}

export interface TaskAssistanceReview {
  fulfilsRequest: boolean;
  sourceRequired: boolean;
  sourceSupportsResult: boolean;
  substantiveContent: boolean;
  reason: string;
}

export function parseTaskAssistanceReview(value: unknown): TaskAssistanceReview {
  const data = record(value, 'Task assistance review');
  for (const field of ['fulfilsRequest', 'sourceRequired', 'sourceSupportsResult', 'substantiveContent']) {
    if (typeof data[field] !== 'boolean') throw new ValidationError(`Invalid task assistance review ${field}.`);
  }
  if (typeof data['reason'] !== 'string' || !data['reason'].trim() || data['reason'].length > REVIEW_REASON_LIMIT) {
    throw new ValidationError('The task assistance review must explain its decision.');
  }
  return { fulfilsRequest: data['fulfilsRequest'] as boolean, sourceRequired: data['sourceRequired'] as boolean,
    sourceSupportsResult: data['sourceSupportsResult'] as boolean, substantiveContent: data['substantiveContent'] as boolean,
    reason: data['reason'] };
}

export function requireTaskAssistanceReady(
  review: TaskAssistanceReview, reads: number, sourceRequired: boolean,
): void {
  if (!review.fulfilsRequest || !review.substantiveContent
    || ((sourceRequired || review.sourceRequired) && (!reads || !review.sourceSupportsResult))) {
    throw new ValidationError(`Task work is not ready: ${review.reason} No completed result was saved. Review the source or revise the proposal before retrying.`);
  }
}
