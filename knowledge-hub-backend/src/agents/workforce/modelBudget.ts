import { performance } from 'node:perf_hooks';
import type { TokenUsage } from '../../ai/aiUsage.js';
import { REVIEW_CONTEXT_RESERVE } from '../../ai/knowledge/reviewContext.js';
import { ConflictError, KnowledgeHubError, ValidationError } from '../../types/errors.js';
import { currentAgentAttempt } from '../attempt.js';
import { positiveInteger } from './contracts.js';
import {
  pauseAssignmentBudget, recordReservationUsage, reserveAssignmentCall, reserveAssignmentResearch, workforceTransaction,
  type BudgetReservation,
} from './store.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface AssignmentModelCall {
  signal: AbortSignal;
  finish: (usage: TokenUsage | undefined) => Promise<void>;
}

interface AssignmentOperation {
  signal: AbortSignal;
  finish: (tokens: number | null) => Promise<void>;
}

function assertBoundedInput(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertBoundedInput(item);
  } else if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    if ('image_url' in input || input['type'] === 'input_image'
      || (input['type'] === 'code_interpreter' || input['type'] === 'web_search' || input['type'] === 'web_search_preview')) {
      throw new ValidationError('This assignment has no approved budget for image input or provider-managed tool execution.');
    }
    for (const child of Object.values(input)) assertBoundedInput(child);
  }
}

/** Every transport attempt must open its own reservation; cached clients never carry assignment state. */
export async function beginAssignmentModelCall(body: unknown, maxOutputTokens: number): Promise<AssignmentModelCall | undefined> {
  const attempt = currentAgentAttempt();
  if (!attempt?.assignmentId) return undefined;
  assertBoundedInput(body);
  positiveInteger(maxOutputTokens, 'Maximum model output tokens');
  // UTF-8 bytes plus the existing context headroom intentionally over-reserve text/framing.
  // This is an operational token allowance, not a provider price or exact billed-cost estimate.
  const tokens = Buffer.byteLength(JSON.stringify(body), 'utf8') + REVIEW_CONTEXT_RESERVE + maxOutputTokens;
  positiveInteger(tokens, 'Conservative model token reservation');
  const operation = await beginOperation('model', tokens);
  if (!operation) throw new ConflictError('The model call lost its assignment context.', 'ASSIGNMENT_BUDGET_UNAVAILABLE');
  return {
    signal: operation.signal,
    finish: (usage): Promise<void> => operation.finish(usage?.known === true ? usage.promptTokens + usage.completionTokens : null),
  };
}

async function beginOperation(kind: 'model' | 'research', tokens: number): Promise<AssignmentOperation | undefined> {
  const attempt = currentAgentAttempt();
  if (!attempt?.assignmentId) return undefined;
  const assignmentId = attempt.assignmentId;
  attempt.signal.throwIfAborted();
  attempt.budgetSignal?.throwIfAborted();
  if (!attempt.budgetDb) throw new ConflictError('The assignment has no durable model-call budget connection.', 'ASSIGNMENT_BUDGET_UNAVAILABLE');
  const db = attempt.budgetDb;
  const started = performance.now();
  const identity = { assignmentId, jobId: attempt.jobId, attempt: attempt.attempt, leaseOwner: attempt.owner };
  attempt.budgetStop ??= new AbortController();
  let reservation: BudgetReservation;
  try {
    reservation = await workforceTransaction(db, client => kind === 'model'
      ? reserveAssignmentCall(client, identity, tokens) : reserveAssignmentResearch(client, identity));
  } catch (error) {
    attempt.budgetStop.abort(error);
    attempt.budgetSignal ??= AbortSignal.any([attempt.signal, attempt.budgetStop.signal]);
    if (error instanceof KnowledgeHubError && (error.code.startsWith('ASSIGNMENT_') || error.code === 'AGENT_ATTEMPT_CONFLICT')) {
      await pauseAssignmentBudget(db, identity, error.message);
    }
    throw error;
  }
  const remainingMs = Math.floor(reservation.remainingMs - (performance.now() - started));
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || attempt.signal.aborted) {
    const error = new ConflictError('The assignment deadline expired before dispatch.', 'ASSIGNMENT_DEADLINE_EXCEEDED');
    attempt.budgetStop.abort(error);
    attempt.budgetSignal ??= AbortSignal.any([attempt.signal, attempt.budgetStop.signal]);
    await recordReservationUsage(db, reservation.id, null);
    attempt.signal.throwIfAborted();
    await pauseAssignmentBudget(db, identity, error.message);
    throw error;
  }
  if (!attempt.budgetSignal) {
    const deadline = AbortSignal.timeout(Math.min(remainingMs, MAX_TIMEOUT_MS));
    const bounded = new AbortController();
    deadline.addEventListener('abort', () => {
      bounded.abort(new ConflictError('The assignment deadline expired. Saved work has been retained.', 'ASSIGNMENT_DEADLINE_EXCEEDED'));
    }, { once: true });
    attempt.budgetSignal = AbortSignal.any([attempt.signal, bounded.signal, attempt.budgetStop.signal]);
  }
  let reconciliation: Promise<void> | undefined;
  return {
    signal: attempt.budgetSignal,
    finish: (actual): Promise<void> => {
      reconciliation ??= recordReservationUsage(db, reservation.id, actual).catch((error: unknown) => {
        attempt.budgetStop?.abort(error);
        throw error;
      });
      return reconciliation;
    },
  };
}

/** Search, MCP discovery and every public redirect hop share the same call allowance as model work. */
export async function withAssignmentResearch<T>(action: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const operation = await beginOperation('research', 0);
  if (!operation) return action(currentAgentAttempt()?.signal);
  let succeeded = false;
  try {
    operation.signal.throwIfAborted();
    const result = await action(operation.signal);
    operation.signal.throwIfAborted();
    succeeded = true;
    return result;
  } finally { await operation.finish(succeeded ? 0 : null); }
}

/** Existing optional-research fallbacks must never convert stop/budget failures into usable evidence. */
export function rethrowAssignmentControl(error: unknown): void {
  const attempt = currentAgentAttempt();
  if (!attempt) return;
  attempt.signal.throwIfAborted();
  attempt.budgetSignal?.throwIfAborted();
  if (attempt.assignmentId && error instanceof KnowledgeHubError
    && (error.code.startsWith('ASSIGNMENT_') || error.code === 'AGENT_ATTEMPT_CONFLICT')) throw error;
}
