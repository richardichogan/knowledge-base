import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';

type Outcome = 'ready' | 'review-blocked' | 'published' | 'saved-to-blog';
type Purpose = 'user' | 'scheduled' | 'diagnostic';
export type AiFailureCode =
  | 'cancelled'
  | 'timeout'
  | 'provider-http'
  | 'provider-refused'
  | 'provider-empty'
  | 'provider-incomplete'
  | 'response-truncated'
  | 'source-forbidden'
  | 'operation-error'
  | 'unclassified';
interface WorkflowContext {
  id: string;
  feature: string;
  stage: string;
  purpose: Purpose;
  result: { outcome: Outcome | null };
  failureStages: Map<unknown, string>;
}
const context = new AsyncLocalStorage<WorkflowContext>();
const MAX_STAGE_CHARS = 120;
const AI_FAILURE_CODES: readonly AiFailureCode[] = [
  'cancelled', 'timeout', 'provider-http', 'provider-refused', 'provider-empty',
  'provider-incomplete', 'response-truncated', 'source-forbidden', 'operation-error', 'unclassified',
];

export function aiFailureCode(error: unknown, cancelled = false): AiFailureCode {
  if (cancelled) return 'cancelled';
  if (typeof error === 'object' && error !== null && 'aiFailureCode' in error) {
    const code = error.aiFailureCode;
    const match = AI_FAILURE_CODES.find(candidate => candidate === code && candidate !== 'unclassified');
    if (match) return match;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  if (error instanceof Error && (error.name === 'TimeoutError' || /timed out|timeout/i.test(error.message))) {
    return 'timeout';
  }
  return 'operation-error';
}

export function aiWorkflowAttribution(): { workflowRunId: string; feature: string; stage: string; purpose: Purpose } | undefined {
  const current = context.getStore();
  return current ? { workflowRunId: current.id, feature: current.feature, stage: current.stage, purpose: current.purpose } : undefined;
}

export function setAiWorkflowStage(stage: string): void {
  const current = context.getStore();
  if (current) current.stage = stage.slice(0, MAX_STAGE_CHARS);
}

export function setAiWorkflowOutcome(outcome: Outcome): void {
  const current = context.getStore();
  if (current) current.result.outcome = outcome;
}

export async function withAiStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current) return run();
  const child = { ...current, stage: stage.slice(0, MAX_STAGE_CHARS) };
  return context.run(child, async () => {
    try { return await run(); }
    catch (error) {
      if (!child.failureStages.has(error)) child.failureStages.set(error, child.stage);
      throw error;
    }
  });
}

export async function withAiWorkflow<T>(
  db: Pool,
  options: { feature: string; jobId?: string; attempt?: number; purpose?: Purpose; signal?: AbortSignal; independent?: boolean },
  run: () => Promise<T>,
): Promise<T> {
  // Direct entry points also serve specialists; keep all nested calls in the same attempt.
  if (context.getStore() && !options.independent) return withAiStage(options.feature, run);
  const current: WorkflowContext = {
    id: randomUUID(), feature: options.feature, stage: options.feature, purpose: options.purpose ?? 'user',
    result: { outcome: null }, failureStages: new Map(),
  };
  try {
    await db.query(`INSERT INTO ai_workflow_runs(id,environment,feature,purpose,job_id,attempt,status)
    VALUES($1,$2,$3,$4,$5,$6,'running')`,
    [current.id, env.isDevelopment ? 'dev' : 'prod', options.feature, current.purpose, options.jobId ?? null, options.attempt ?? 1]);
  } catch {
    console.error('[ai-workflow] Attribution unavailable; operation will run without workflow tracking:', current.id);
    return run();
  }
  return context.run(current, async () => {
    let status: 'completed' | 'failed' | 'interrupted' = 'completed';
    let failureStage: string | null = null;
    let failureCode: AiFailureCode | null = null;
    try { return await run(); }
    catch (error) {
      const cancelled = options.signal?.aborted === true
        && !(options.signal.reason instanceof Error && options.signal.reason.name === 'TimeoutError');
      failureStage = current.failureStages.get(error) ?? current.stage;
      failureCode = aiFailureCode(error, cancelled);
      status = failureCode === 'cancelled' ? 'interrupted' : 'failed';
      throw error;
    }
    finally {
      try {
        await db.query(`UPDATE ai_workflow_runs
          SET status=$2,outcome=$3,failure_stage=$4,failure_code=$5,finished_at=NOW() WHERE id=$1`,
        [current.id, status, status === 'completed' ? current.result.outcome : null,
          failureStage, failureCode]);
      } catch (error) {
        // A telemetry write must not turn a saved artifact into an apparent generation failure.
        console.error('[ai-workflow] Could not record the final outcome; tracking is incomplete:', current.id, error);
      }
    }
  });
}

export async function recordBlogDelivery(db: Pool, jobId: string, status: 'draft' | 'published'): Promise<void> {
  try {
    await db.query(`UPDATE ai_workflow_runs SET outcome=CASE WHEN outcome='published' THEN outcome ELSE $2 END
      WHERE job_id=$1 AND status='completed'
      AND id=(SELECT id FROM ai_workflow_runs WHERE job_id=$1 AND status='completed' ORDER BY started_at DESC LIMIT 1)`,
    [jobId, status === 'published' ? 'published' : 'saved-to-blog']);
  } catch (error) {
    console.error('[ai-workflow] Blog delivery succeeded but its outcome was not recorded:', jobId, error);
  }
}
