/**
 * jobs/traceEvaluationSweepJob.ts
 * Hourly bounded sweep that runs the free deterministic evaluation over
 * finished turn traces with no current-version verdict yet, so health checks
 * and Decision-1 shadow agreement accumulate without manual Evaluate clicks.
 * Model-based evaluation stays on demand because it spends tokens.
 */
import type { Pool } from 'pg';
import { EVALUATOR_VERSION, evaluateSavedTrace } from '../health/traceReview.js';

const BATCH_SIZE = 25;
const MAX_FAILED_ATTEMPTS = 3;

export async function runTraceEvaluationSweepJob(db: Pool): Promise<void> {
  const { rows } = await db.query<{ id: string; session_id: string }>(
    `SELECT t.id,t.session_id FROM ai_turn_traces t
      WHERE t.status<>'running' AND t.session_id IS NOT NULL AND t.expires_at>NOW()
        AND NOT EXISTS (SELECT 1 FROM ai_trace_evaluations e WHERE e.trace_id=t.id
          AND e.method='deterministic' AND e.version=$1 AND e.status IN ('running','completed'))
        AND (SELECT COUNT(*) FROM ai_trace_evaluations f WHERE f.trace_id=t.id
          AND f.method='deterministic' AND f.version=$1 AND f.status='failed')<$2
      ORDER BY t.started_at DESC LIMIT $3`,
    [EVALUATOR_VERSION, MAX_FAILED_ATTEMPTS, BATCH_SIZE],
  );
  let evaluated = 0;
  for (const trace of rows) {
    try {
      await evaluateSavedTrace(db, trace.session_id, trace.id, 'deterministic');
      evaluated += 1;
    } catch (error) {
      console.error('[trace-eval-sweep] Evaluation failed for trace', trace.id,
        error instanceof Error ? error.message : String(error));
    }
  }
  if (rows.length) console.warn(`[trace-eval-sweep] Deterministic evaluations completed: ${evaluated.toString()}/${rows.length.toString()}`);
}
