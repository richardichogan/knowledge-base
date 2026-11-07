/**
 * goals/loopBreaker.ts — stops Athena repeating work that keeps failing. After five failures on the same subject
 * (since its last success or Richard's last "try again"), the specialist or managed job is paused and Richard gets
 * one specific question on Today: try again, or leave it. Nothing retries until he answers.
 */
import type { Pool } from 'pg';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { mutateState, readState } from './goals.js';

const KEY = 'agent-loop-breaker';
export const LOOP_LIMIT = 5;
const MAX_PAUSES = 200;

export type PauseStatus = 'open' | 'resumed' | 'stopped';
export interface LoopPause {
  key: string; kind: 'agent' | 'job'; specialist?: string; specialistName?: string; subjectType?: string; subjectId?: string;
  jobId?: string; subjectTitle: string; failures: number; lastError: string; question: string; at: string;
  status: PauseStatus; resolvedAt: string | null;
}
interface LoopState { pauses: LoopPause[] }
const EMPTY: LoopState = { pauses: [] };

export const agentPauseKey = (specialist: string, subjectType: string, subjectId: string): string => `agent:${specialist}:${subjectType}:${subjectId}`;
export const jobPauseKey = (jobId: string): string => `job:${jobId}`;

function question(who: string, title: string, failures: number, error: string): string {
  const reason = error.trim().replace(/\s+/g, ' ').slice(0, 160);
  return `${who} has failed ${String(failures)} times on “${title || 'this'}”${reason ? ` — last error: ${reason}` : ''}. Shall I try again, or leave it?`;
}

export async function loopPauses(db: Pool, includeResolved = false): Promise<LoopPause[]> {
  const state = await readState<LoopState>(db, KEY);
  return (state?.pauses ?? []).filter(p => includeResolved || p.status === 'open');
}

async function pauseFor(db: Pool, key: string): Promise<LoopPause | undefined> {
  return (await readState<LoopState>(db, KEY))?.pauses.find(p => p.key === key);
}

async function upsertPause(db: Pool, pause: Omit<LoopPause, 'at' | 'status' | 'resolvedAt' | 'question'>, who: string): Promise<LoopPause> {
  return mutateState(db, KEY, EMPTY, state => {
    const existing = state.pauses.find(p => p.key === pause.key);
    const q = question(who, pause.subjectTitle, pause.failures, pause.lastError);
    if (existing && existing.status !== 'resumed') {
      Object.assign(existing, { failures: pause.failures, lastError: pause.lastError, question: existing.status === 'open' ? q : existing.question });
      return existing;
    }
    const next: LoopPause = { ...pause, question: q, at: new Date().toISOString(), status: 'open', resolvedAt: null };
    state.pauses = [next, ...state.pauses.filter(p => p.key !== pause.key)].slice(0, MAX_PAUSES);
    return next;
  });
}

/** Failures for (specialist, subject) since the later of its last success and Richard's last resume. */
export async function checkAgentLoop(db: Pool, input: { specialist: string; specialistName: string; subjectType: string; subjectId: string; subjectTitle: string }): Promise<LoopPause | null> {
  const key = agentPauseKey(input.specialist, input.subjectType, input.subjectId);
  const existing = await pauseFor(db, key);
  if (existing?.status === 'open' || existing?.status === 'stopped') return existing;
  const since = existing?.status === 'resumed' ? existing.resolvedAt : null;
  const { rows } = await db.query<{ failures: number; last_error: string | null }>(
    `WITH ok AS (SELECT MAX(created_at) AS at FROM agent_jobs WHERE specialist=$1 AND subject_type=$2 AND subject_id=$3 AND status='done')
     SELECT COUNT(*)::int AS failures,
            (ARRAY_AGG(error ORDER BY created_at DESC))[1] AS last_error
       FROM agent_jobs, ok
      WHERE specialist=$1 AND subject_type=$2 AND subject_id=$3 AND status='failed'
        AND created_at > GREATEST(COALESCE(ok.at, '-infinity'::timestamptz), COALESCE($4::timestamptz, '-infinity'::timestamptz))`,
    [input.specialist, input.subjectType, input.subjectId, since]);
  const failures = rows[0]?.failures ?? 0;
  if (failures < LOOP_LIMIT) return null;
  return upsertPause(db, {
    key, kind: 'agent', specialist: input.specialist, specialistName: input.specialistName, subjectType: input.subjectType,
    subjectId: input.subjectId, subjectTitle: input.subjectTitle, failures, lastError: rows[0]?.last_error ?? '',
  }, input.specialistName);
}

/** Managed jobs: pauses after the last five runs all failed. Returns the pause when the job should be disabled. */
export async function checkJobLoop(db: Pool, jobId: string, name: string): Promise<LoopPause | null> {
  const key = jobPauseKey(jobId);
  const existing = await pauseFor(db, key);
  const since = existing?.status === 'resumed' ? existing.resolvedAt : null;
  const { rows } = await db.query<{ status: string; message: string | null }>(
    `SELECT status, artifacts->>'error' AS message FROM managed_job_runs
      WHERE job_id=$1 AND NOT preview AND status IN ('succeeded','failed','partial')
        AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
      ORDER BY updated_at DESC LIMIT $3`, [jobId, since, LOOP_LIMIT]);
  if (rows.length < LOOP_LIMIT || rows.some(r => r.status !== 'failed')) return null;
  return upsertPause(db, { key, kind: 'job', jobId, subjectTitle: name, failures: LOOP_LIMIT, lastError: rows[0]?.message ?? '' }, `The “${name}” job`);
}

export async function resolvePause(db: Pool, key: unknown, outcome: 'resumed' | 'stopped'): Promise<LoopPause> {
  if (typeof key !== 'string' || !key) throw new ValidationError('Choose the paused item.');
  return mutateState(db, KEY, EMPTY, state => {
    const pause = state.pauses.find(p => p.key === key);
    if (!pause) throw new NotFoundError('That paused item no longer exists.');
    if (pause.status === 'resumed') throw new ValidationError('That item has already been resumed.');
    pause.status = outcome;
    pause.resolvedAt = new Date().toISOString();
    return pause;
  });
}
