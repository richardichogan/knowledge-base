import type { PoolClient } from 'pg';
import { ConflictError, ValidationError } from '../types/errors.js';

export const STATUS_NOTE_LIMIT = 3000;
export interface TaskStatusProposal {
  taskId: string; title: string; from: string; to: string; note: string;
  waitingOn?: string;
}

export async function recordTaskStatusChange(
  db: PoolClient, taskId: string, previousStatus: string, nextStatus: string,
  input: { statusChangeNote?: unknown; expectedStatus?: unknown; statusProposedBy?: unknown },
): Promise<void> {
  if (previousStatus === nextStatus) return;
  if (input.expectedStatus !== previousStatus) {
    throw new ConflictError('The task status changed. Review the current task before moving it.', 'TASK_STATUS_CONFLICT');
  }
  if (typeof input.statusChangeNote !== 'string' || !input.statusChangeNote.trim()
    || input.statusChangeNote.length > STATUS_NOTE_LIMIT) {
    throw new ValidationError(`Add a status-change note of up to ${STATUS_NOTE_LIMIT} characters before moving the task.`);
  }
  await db.query('INSERT INTO task_notes(task_id,body,activity) VALUES($1,$2,$3)',
    [taskId, `Status: ${previousStatus} -> ${nextStatus}\n\n${input.statusChangeNote.trim()}`, JSON.stringify({
      actor: 'richard', action: 'status-changed', from: previousStatus, to: nextStatus,
      ...(input.statusProposedBy === 'athena' ? { proposedBy: 'athena' } : {}),
    })]);
}
