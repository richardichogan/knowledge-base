import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withAiWorkflow } from '../ai/aiWorkflow.js';
import type { SyncFailure } from './sourceDiagnostics.js';

export type SyncRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
export interface SourceRunResult {
  source: string;
  indexed: number;
  errors: number;
  durationMs: number;
  failures?: SyncFailure[];
}
export interface SyncRun {
  id: string;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  results: SourceRunResult[];
}
type RunRow = { id: string; status: SyncRunStatus; started_at: Date; finished_at: Date | null; results: SourceRunResult[] };
function fromRow(row: RunRow): SyncRun {
  return { id: row.id, status: row.status, startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null, results: row.results };
}
export async function createSyncRun(db: Pool, claimKey?: string): Promise<SyncRun | null> {
  const { rows } = await db.query<RunRow>(
    `INSERT INTO sync_runs (id, claim_key, status) VALUES ($1,$2,'running')
     ON CONFLICT DO NOTHING RETURNING *`, [randomUUID(), claimKey ?? null]);
  return rows[0] === undefined ? null : fromRow(rows[0]);
}
export async function getSyncRun(db: Pool, id: string): Promise<SyncRun | null> {
  const { rows } = await db.query<RunRow>('SELECT * FROM sync_runs WHERE id = $1', [id]);
  return rows[0] === undefined ? null : fromRow(rows[0]);
}
export async function latestSyncRun(db: Pool): Promise<SyncRun | null> {
  const { rows } = await db.query<RunRow>('SELECT * FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 1');
  return rows[0] === undefined ? null : fromRow(rows[0]);
}
export function syncOutcome(results: SourceRunResult[]): Exclude<SyncRunStatus, 'running' | 'interrupted'> {
  const failures = results.filter(result => result.errors > 0);
  if (failures.length === 0) return 'succeeded';
  return failures.length === results.length ? 'failed' : 'partial';
}
export async function recordSyncProgress(db: Pool, id: string, results: SourceRunResult[], status: SyncRunStatus = 'running'): Promise<void> {
  await db.query(`UPDATE sync_runs SET results = $2, status = $3,
    finished_at = CASE WHEN $3 = 'running' THEN NULL ELSE NOW() END WHERE id = $1 AND status = 'running'`,
  [id, JSON.stringify(results), status]);
}
export async function recoverInterruptedWork(db: Pool): Promise<void> {
  await db.query("UPDATE sync_runs SET status = 'interrupted', finished_at = NOW() WHERE status = 'running'");
  await db.query("UPDATE scheduled_job_claims SET status = 'interrupted', finished_at = NOW() WHERE status = 'running'");
  await db.query(`UPDATE ai_chat_sessions SET pending_turn = pending_turn || '{"status":"interrupted"}'::jsonb
    WHERE pending_turn IS NOT NULL`);
}
export async function runClaimedJob(db: Pool, job: string, period: string, run: () => Promise<unknown>): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO scheduled_job_claims (job,period,status) VALUES ($1,$2,'running')
     ON CONFLICT DO NOTHING RETURNING job`, [job, period]);
  if (rows.length === 0) return false;
  try {
    await withAiWorkflow(db, { feature: job, purpose: 'scheduled' }, run);
    await db.query("UPDATE scheduled_job_claims SET status='succeeded', finished_at=NOW() WHERE job=$1 AND period=$2", [job, period]);
  } catch (error) {
    await db.query("UPDATE scheduled_job_claims SET status='failed', finished_at=NOW() WHERE job=$1 AND period=$2", [job, period]);
    throw error;
  }
  return true;
}
