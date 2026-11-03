import type { PoolClient } from 'pg';
import { rowToTask, type Task } from '../routes/tasks.js';
import { contentSignature } from '../agents/workforce/contracts.js';
import { ConflictError, NotFoundError } from '../types/errors.js';

export function taskAssistanceSignature(task: Task): string {
  return contentSignature({ title: task.title, body: task.body, projectId: task.projectId, externalUrl: task.externalUrl,
    status: task.status, updatedAt: task.updatedAt });
}

interface TaskJob {
  id: string;
  specialist: string;
  subject_type: string;
  subject_id: string;
  attempts: number;
  status: string;
}

export async function assignTaskAgent(
  client: PoolClient, job: TaskJob, specialistName: string, proposalId: unknown,
): Promise<Task | undefined> {
  if (job.subject_type !== 'task' || job.specialist === 'task-assistance-assessor') return;
  const proposal = typeof proposalId === 'string'
    ? (await client.query<{ task_signature: string; approved_at: Date | null }>(
      'SELECT task_signature,approved_at FROM task_assistance WHERE id=$1 AND task_id=$2 FOR UPDATE',
      [proposalId, job.subject_id])).rows[0] : undefined;
  const before = (await client.query<Record<string, unknown>>(
    `SELECT t.*,ARRAY(SELECT tt.tag_id::text FROM task_tags tt WHERE tt.task_id=t.id ORDER BY tt.tag_id) AS taxonomy_tag_ids
     FROM tasks t WHERE t.id=$1 AND NOT t.archived FOR UPDATE OF t`, [job.subject_id])).rows[0];
  if (!before) throw new NotFoundError('Task');
  if (typeof proposalId === 'string' && (!proposal?.approved_at || proposal.task_signature !== taskAssistanceSignature(rowToTask(before)))) {
    throw new ConflictError('The task or its approved assistance changed before assignment. Review it again.', 'TASK_ASSISTANCE_STALE');
  }
  const from = String(before['status']);
  const after = from === 'in-progress' ? before
    : (await client.query<Record<string, unknown>>(`UPDATE tasks
      SET status='in-progress',waiting_on=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [job.subject_id])).rows[0];
  if (!after) throw new NotFoundError('Task');
  after['taxonomy_tag_ids'] = before['taxonomy_tag_ids'];
  if (typeof proposalId === 'string') {
    const task = rowToTask(after);
    await client.query('UPDATE task_assistance SET task_signature=$2,task_snapshot=$3 WHERE id=$1',
      [proposalId, taskAssistanceSignature(task), JSON.stringify(task)]);
  }
  await client.query(`INSERT INTO task_notes(id,task_id,body,activity) VALUES(md5($1::text)::uuid,$2,$3,$4)
    ON CONFLICT(id) DO NOTHING`,
    [`${job.id}:assigned`, job.subject_id, `Assigned to ${specialistName}. Work is queued; the task is In progress and remains open for your review.`,
      JSON.stringify({ actor: 'athena', action: 'agent-assigned', specialistId: job.specialist, specialistName,
        jobId: job.id, ...(from !== 'in-progress' ? { from, to: 'in-progress' } : {}) })]);
  return rowToTask(after);
}

export async function recordTaskAgentActivity(
  client: PoolClient, job: TaskJob, specialistName: string, action: string, message: string,
): Promise<void> {
  if (job.subject_type !== 'task' || job.specialist === 'task-assistance-assessor') return;
  // The stable receipt makes recovery/retry idempotent without losing history
  // when the bounded job-progress array rolls over.
  await client.query(`INSERT INTO task_notes(id,task_id,body,activity)
    SELECT md5($1::text)::uuid,j.subject_id,$2,$3::jsonb FROM agent_jobs j
    WHERE j.id=$4 AND j.attempts=$5 AND j.status=$6
    ON CONFLICT(id) DO NOTHING`,
  [`${job.id}:${job.attempts}:${action}:${message}`, `${specialistName}: ${message}`,
    JSON.stringify({ actor: 'athena', action, specialistId: job.specialist, specialistName, jobId: job.id, attempt: job.attempts }),
    job.id, job.attempts, job.status]);
}
