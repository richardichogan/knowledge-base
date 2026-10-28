import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';

type Outcome = 'ready' | 'review-blocked' | 'published' | 'saved-to-blog';
type Purpose = 'user' | 'scheduled' | 'diagnostic';
interface WorkflowContext { id: string; stage: string; purpose: Purpose; result: { outcome: Outcome | null } }
const context = new AsyncLocalStorage<WorkflowContext>();
const MAX_STAGE_CHARS = 120;

export function aiWorkflowAttribution(): { workflowRunId: string; stage: string; purpose: Purpose } | undefined {
  const current = context.getStore();
  return current ? { workflowRunId: current.id, stage: current.stage, purpose: current.purpose } : undefined;
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
  return current ? context.run({ ...current, stage }, run) : run();
}

export async function withAiWorkflow<T>(
  db: Pool,
  options: { feature: string; jobId?: string; attempt?: number; purpose?: Purpose; signal?: AbortSignal },
  run: () => Promise<T>,
): Promise<T> {
  // Direct entry points also serve specialists; keep all nested calls in the same attempt.
  if (context.getStore()) return withAiStage(options.feature, run);
  const current: WorkflowContext = { id: randomUUID(), stage: options.feature, purpose: options.purpose ?? 'user', result: { outcome: null } };
  await db.query(`INSERT INTO ai_workflow_runs(id,environment,feature,purpose,job_id,attempt,status)
    VALUES($1,$2,$3,$4,$5,$6,'running')`,
  [current.id, env.isDevelopment ? 'dev' : 'prod', options.feature, current.purpose, options.jobId ?? null, options.attempt ?? 1]);
  return context.run(current, async () => {
    let status: 'completed' | 'failed' | 'interrupted' = 'completed';
    try { return await run(); }
    catch (error) { status = options.signal?.aborted ? 'interrupted' : 'failed'; throw error; }
    finally {
      try {
        await db.query('UPDATE ai_workflow_runs SET status=$2,outcome=$3,finished_at=NOW() WHERE id=$1',
          [current.id, status, status === 'completed' ? current.result.outcome : null]);
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
