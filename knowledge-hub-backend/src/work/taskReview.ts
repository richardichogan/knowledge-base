import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { ConflictError } from '../types/errors.js';
import { queueTaskAssistanceAssessment } from './taskAssistanceQueue.js';

export interface TaskReviewSummary {
  considered: number;
  queued: number;
  skipped: number;
  reviewedAt: string;
}

const REVIEW_LIMIT = 25;

async function reviewOwner(db: Pool): Promise<string | undefined> {
  const latest = (await db.query<{ owner_id: string }>(
    'SELECT owner_id FROM task_assistance ORDER BY created_at DESC LIMIT 1')).rows[0]?.owner_id;
  return latest ?? env.ATHENA_ALLOWED_USER_IDS?.split(',').map((id) => id.trim()).find(Boolean);
}

/**
 * Twice-daily proactive review. Queues an assessment for every open task that is new to Athena or has changed since
 * Athena last looked at it. Research proposals start automatically; emails and messages are only ever drafted on approval.
 */
export async function reviewActiveTasks(db: Pool): Promise<TaskReviewSummary> {
  const reviewedAt = new Date().toISOString();
  const ownerId = await reviewOwner(db);
  if (!ownerId) return { considered: 0, queued: 0, skipped: 0, reviewedAt };
  const tasks = (await db.query<{ id: string }>(`
    SELECT t.id FROM tasks t
    WHERE NOT t.archived AND t.status NOT IN ('completed','cancelled')
      AND NOT EXISTS (SELECT 1 FROM agent_jobs j WHERE j.subject_type='task' AND j.subject_id=t.id::text
        AND j.specialist='task-assistance-assessor' AND j.status IN ('queued','running'))
      AND t.updated_at > COALESCE(GREATEST(
        (SELECT MAX(a.created_at) FROM task_assistance a WHERE a.task_id=t.id AND a.owner_id=$1),
        (SELECT MAX(j.created_at) FROM agent_jobs j WHERE j.subject_type='task' AND j.subject_id=t.id::text
          AND j.specialist='task-assistance-assessor')), '-infinity'::timestamptz)
    ORDER BY t.updated_at DESC LIMIT $2`, [ownerId, REVIEW_LIMIT])).rows;
  let queued = 0;
  let skipped = 0;
  for (const task of tasks) {
    try {
      await queueTaskAssistanceAssessment(db, task.id, ownerId, { kind: 'app' }, false, true);
      queued++;
    } catch (error) {
      skipped++;
      if (!(error instanceof ConflictError)) console.error('[Task review] Could not queue a task assessment:', error);
    }
  }
  return { considered: tasks.length, queued, skipped, reviewedAt };
}

/** The latest completed scheduled review, for the Today summary line. */
export async function latestTaskReview(db: Pool): Promise<TaskReviewSummary | null> {
  const row = (await db.query<{ review: TaskReviewSummary | null; updated_at: Date }>(`
    SELECT r.artifacts->'review' AS review, r.updated_at FROM managed_job_runs r
    WHERE r.status='succeeded' AND r.definition->>'kind'='task-review'
    ORDER BY r.updated_at DESC NULLS LAST LIMIT 1`)).rows[0];
  if (!row?.review) return null;
  return { ...row.review, reviewedAt: row.updated_at ? new Date(row.updated_at).toISOString() : row.review.reviewedAt };
}
