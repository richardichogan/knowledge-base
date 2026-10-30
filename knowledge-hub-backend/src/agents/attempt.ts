import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '../types/errors.js';

export interface AgentAttempt {
  jobId: string;
  attempt: number;
  owner: string;
  assignmentId: string | null;
  signal: AbortSignal;
  budgetDb?: Pool;
  budgetSignal?: AbortSignal;
  budgetStop?: AbortController;
}

const attempts = new AsyncLocalStorage<AgentAttempt>();

export function withAgentAttempt<T>(attempt: AgentAttempt, run: () => Promise<T>): Promise<T> {
  return attempts.run(attempt, run);
}

export function currentAgentAttempt(): AgentAttempt | undefined {
  return attempts.getStore();
}

/** Call inside the same short transaction that accepts a generated domain write. */
export async function lockAgentAttempt(client: PoolClient): Promise<void> {
  const current = attempts.getStore();
  if (!current) return;
  current.signal.throwIfAborted();
  current.budgetSignal?.throwIfAborted();
  if (current.assignmentId) {
    const assignment = await client.query(
      `SELECT a.id FROM agent_assignments a JOIN agent_budget_profiles p ON p.id=a.budget_profile_id
        WHERE a.id=$1 AND a.status='running' AND a.deadline>clock_timestamp() AND p.enabled FOR UPDATE OF a FOR SHARE OF p`,
      [current.assignmentId],
    );
    if (!assignment.rowCount) throw stopped();
  }
  const job = await client.query(
    `SELECT id FROM agent_jobs WHERE id=$1 AND attempts=$2 AND lease_owner=$3
      AND assignment_id IS NOT DISTINCT FROM $4::uuid AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`,
    [current.jobId, current.attempt, current.owner, current.assignmentId],
  );
  if (!job.rowCount) throw stopped();
  current.signal.throwIfAborted();
  current.budgetSignal?.throwIfAborted();
}

function stopped(): ConflictError {
  return new ConflictError('This specialist no longer owns the current attempt. Its generated changes were not applied.', 'AGENT_ATTEMPT_CONFLICT');
}
