import type { Pool } from 'pg';
import { handOff, type HandOffResult } from '../agents/engine.js';
import { ConflictError, ValidationError } from '../types/errors.js';

export interface AutomaticTaskAssistance {
  status: 'queued' | 'failed' | 'skipped';
  message: string;
}

export async function prepareAutomaticTaskAssistance(
  db: Pool,
  taskId: string,
  ownerId: string | undefined,
  origin: { kind: 'app' } | { kind: 'chat'; conversationId: string },
): Promise<AutomaticTaskAssistance> {
  try {
    const task = (await db.query<{
      status: string; archived: boolean; recurring_cadence: string | null; recurring_parent_id: string | null;
    }>('SELECT status,archived,recurring_cadence,recurring_parent_id FROM tasks WHERE id=$1', [taskId])).rows[0];
    if (!task) throw new ValidationError('The task is unavailable for automatic assessment.');
    if (task.archived || task.status === 'completed' || task.status === 'inbox'
      || task.recurring_cadence !== null || task.recurring_parent_id !== null) {
      return { status: 'skipped', message: task.status === 'inbox'
        ? 'Automatic help waits until you accept this Inbox task. No assessment or work has started.'
        : 'Completed, archived and recurring tasks do not receive automatic help. Help me remains available for active tasks.' };
    }
    if (!ownerId?.trim()) throw new ValidationError('Task assistance requires an authenticated owner.');
    const existing = await db.query(`SELECT 1 FROM task_assistance WHERE task_id=$1 AND owner_id=$2
      UNION ALL SELECT 1 FROM agent_jobs WHERE subject_type='task' AND subject_id=$1::text
        AND specialist='task-assistance-assessor' AND input->>'ownerId'=$2
        AND NOT (status='done' AND COALESCE(result->'data'->>'skipped','false')='true') LIMIT 1`, [taskId, ownerId]);
    if (existing.rows.length) {
      return { status: 'skipped', message: 'Help has already been assessed or requested. Use Help me to retry or reassess; no duplicate job was started.' };
    }
    await queueTaskAssistanceAssessment(db, taskId, ownerId, origin, true);
    return { status: 'queued', message: 'How Athena could help is being prepared. You will be notified when the proposal is ready. No task work has started.' };
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'AGENT_ALREADY_REQUESTED') {
      return { status: 'skipped', message: 'Help has already been requested. No duplicate job was started.' };
    }
    console.error('[Task assistance] Could not queue automatic help:', error);
    return { status: 'failed', message: 'The task was saved, but Athena could not queue its help proposal. Open the task and choose Help me to retry.' };
  }
}

export async function queueTaskAssistanceAssessment(
  db: Pool,
  taskId: string,
  ownerId: string,
  origin: { kind: 'app' } | { kind: 'chat'; conversationId: string },
  once = false,
  scheduled = false,
): Promise<Exclude<HandOffResult, { status: 'needs_confirmation' }>> {
  if (!ownerId.trim()) throw new ValidationError('Task assistance requires an authenticated owner.');
  const result = await handOff(db, {
    specialist: 'task-assistance-assessor',
    subjectId: taskId,
    input: { ownerId, ...(scheduled ? { scheduled: true } : {}) },
    requestedBy: origin.kind,
    ...(origin.kind === 'chat' ? { conversationId: origin.conversationId } : {}),
    confirmed: true,
    once,
  });
  if (result.status === 'needs_confirmation') throw new ValidationError(result.message);
  return result;
}
