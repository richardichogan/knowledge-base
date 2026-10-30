import type { Pool } from 'pg';
import { withAgentAttempt } from '../attempt.js';
import { withAiWorkflow } from '../../ai/aiWorkflow.js';
import { ConflictError, KnowledgeHubError, ValidationError } from '../../types/errors.js';
import { AGENT_HEARTBEAT_MS, type Assignment, type StepDefinition } from './contracts.js';
import { completeManualBlogStep, type StepAcceptanceAdapter, type StepCompletion } from './controller.js';
import {
  claimManualBlogStep, recordAssignmentFailure, recoverAssignmentStep, renewAssignmentLease,
  resumeAssignment,
  type ClaimedAssignmentStep, type StepFailure,
} from './runtime.js';

export interface ManualBlogExecutor {
  /** Receives only scoped inputs/capabilities through its server-owned closure, never a database pool. */
  execute: (context: { assignment: Assignment; definition: StepDefinition; signal: AbortSignal }) => Promise<unknown>;
  acceptance: StepAcceptanceAdapter;
}

export function resumeConfiguredAssignment(
  db: Pool, id: string, ownerId: string, revision: number, requestId: string,
): Promise<Assignment> {
  if (!manualBlogExecutor) return Promise.reject(new ConflictError('The source-authorised workflow executor is not installed.', 'ASSIGNMENT_EXECUTOR_UNAVAILABLE'));
  return resumeAssignment(db, id, { ownerId, revision, requestId, checkCurrent: manualBlogExecutor.acceptance.checkCurrent });
}

let manualBlogExecutor: ManualBlogExecutor | undefined;

export function hasManualBlogExecutor(): boolean {
  return manualBlogExecutor !== undefined;
}

/** Registration is explicit; a newer binary must never claim a workflow it cannot actually execute. */
export function registerManualBlogExecutor(executor: ManualBlogExecutor): void {
  if (manualBlogExecutor) throw new ConflictError('The manual blog workflow is already registered.', 'ASSIGNMENT_EXECUTOR_REGISTERED');
  manualBlogExecutor = executor;
}

export async function recoverConfiguredAssignments(db: Pool, pool: string): Promise<void> {
  if (manualBlogExecutor) await recoverAssignmentStep(db, pool);
}

export async function claimConfiguredAssignment(
  db: Pool, pool: string, owner: string, signal: AbortSignal,
): Promise<ClaimedAssignmentStep | null> {
  return manualBlogExecutor ? claimManualBlogStep(db, pool, owner, signal, manualBlogExecutor.acceptance.checkCurrent) : null;
}

const MAX_TIMER_MS = 2_147_483_647;

function classifyFailure(error: unknown, signal: AbortSignal): StepFailure {
  if (error instanceof ConflictError && error.code === 'ASSIGNMENT_SOURCE_CHANGED') return { kind: 'stale', reason: error.message };
  if (error instanceof KnowledgeHubError && (error.code.startsWith('ASSIGNMENT_BUDGET')
    || error.code === 'ASSIGNMENT_DEADLINE_EXCEEDED' || error.code === 'ASSIGNMENT_STOPPED')) return { kind: 'wait', reason: error.message };
  if (signal.aborted) return { kind: 'shutdown', reason: 'The worker stopped. Saved work remains within the original allowance.' };
  return { kind: 'failed', reason: error instanceof KnowledgeHubError ? error.message
    : 'The specialist encountered an unexpected error. No unchecked output was accepted.' };
}

/** Called only after taking one of the existing engine's concurrency slots. */
export function runConfiguredAssignment(
  db: Pool, claimed: ClaimedAssignmentStep, onComplete: (completion: StepCompletion) => void,
): Promise<void> {
  const executor = manualBlogExecutor;
  if (!executor) return Promise.reject(new ValidationError('The manual blog executor is not installed.'));
  return runManualBlogStep(db, claimed, executor, onComplete);
}

export async function runManualBlogStep(
  db: Pool, claimed: ClaimedAssignmentStep, executor: ManualBlogExecutor, onComplete: (completion: StepCompletion) => void,
): Promise<void> {
  const lease = new AbortController();
  const budgetStop = new AbortController();
  const signal = AbortSignal.any([claimed.identity.signal, lease.signal, budgetStop.signal]);
  const identity = { ...claimed.identity, signal };
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = (): void => {
    const remaining = claimed.assignment.deadline.getTime() - Date.now();
    if (remaining <= 0) {
      budgetStop.abort(new ConflictError('The assignment reached its original deadline. Saved artifacts remain available.', 'ASSIGNMENT_DEADLINE_EXCEEDED'));
      return;
    }
    deadlineTimer = setTimeout(deadline, Math.min(remaining, MAX_TIMER_MS));
    deadlineTimer.unref();
  };
  deadline();
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal || signal.aborted) return;
    renewal = renewAssignmentLease(db, identity).then(owned => {
      if (!owned) lease.abort(new ConflictError('The assignment attempt lost its lease or authority.', 'AGENT_ATTEMPT_CONFLICT'));
    }).catch((error: unknown) => {
      console.error('[workforce] Lease renewal failed; stopping this attempt:', identity.jobId, error);
      lease.abort(new ConflictError('The assignment lease could not be renewed.', 'AGENT_ATTEMPT_CONFLICT'));
    }).finally(() => { renewal = undefined; });
  }, AGENT_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const completed = await withAgentAttempt({
      jobId: identity.jobId, assignmentId: identity.assignmentId, attempt: identity.attempt, owner: identity.owner,
      signal, budgetDb: db, budgetSignal: budgetStop.signal, budgetStop,
    }, () => withAiWorkflow(db, {
      feature: claimed.definition.profile, jobId: identity.jobId, attempt: identity.attempt, signal,
    }, async () => {
      signal.throwIfAborted();
      const proposal = await executor.execute({ assignment: claimed.assignment, definition: claimed.definition, signal });
      signal.throwIfAborted();
      return completeManualBlogStep(db, identity, proposal, executor.acceptance);
    }));
    try { onComplete(completed); }
    catch (error) {
      console.error('[workforce] The saved completion could not be broadcast; durable status remains available:', identity.assignmentId, error);
    }
  } catch (error) {
    if (lease.signal.aborted) return;
    const failure = classifyFailure(budgetStop.signal.aborted ? budgetStop.signal.reason : error, claimed.identity.signal);
    if (!(error instanceof KnowledgeHubError) && !signal.aborted) {
      console.error('[workforce] Assignment execution failed:', identity.assignmentId, identity.jobId, error);
    }
    await recordAssignmentFailure(db, identity, failure);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadlineTimer);
    await renewal;
  }
}
