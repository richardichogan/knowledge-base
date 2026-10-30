import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../types/errors.js';
import {
  AGENT_LEASE_MS, AGENT_MAX_ATTEMPTS, AGENT_PROTOCOL_VERSION, MANUAL_BLOG_STEPS, WORKFORCE_VERSION,
  parseBudgetLimits, type Assignment, type StepDefinition,
} from './contracts.js';
import { manualBlogStepDefinition, type StepAttempt } from './controller.js';
import { lockAssignment, transitionAssignment, workforceTransaction } from './store.js';

interface RuntimeJob {
  id: string;
  assignment_id: string;
  step_key: string;
  protocol_version: number;
  role_id: string;
  task_profile: string;
  prompt_version: number;
  output_type: string;
  subject_type: string;
  subject_id: string;
  specialist: string;
  input: Record<string, unknown>;
  attempts: number;
  status: string;
}

export interface ClaimedAssignmentStep {
  identity: StepAttempt;
  assignment: Assignment;
  definition: StepDefinition;
  input: Readonly<Record<string, unknown>>;
  specialist: string;
}

export type CurrentAssignmentCheck = (client: PoolClient, assignment: Assignment) => Promise<void>;

const PROFILE_IDS = Object.values(MANUAL_BLOG_STEPS).map(step => step.profile);

async function availableBudget(client: PoolClient, assignment: Assignment): Promise<boolean> {
  const result = await client.query<{ limits: unknown; calls_reserved: string; tokens_reserved: string; live: boolean }>(
    `SELECT p.limits,a.calls_reserved,a.tokens_reserved,a.deadline>clock_timestamp() AS live
      FROM agent_assignments a JOIN agent_budget_profiles p ON p.id=a.budget_profile_id
      WHERE a.id=$1 AND p.enabled AND p.workflow=a.workflow AND p.workflow_version=a.workflow_version
        AND p.policy_profile=a.policy_profile AND p.approved_by=a.owner_id FOR SHARE OF p`,
    [assignment.id],
  );
  const row = result.rows[0];
  if (!row?.live) return false;
  const limits = parseBudgetLimits(row.limits);
  return BigInt(row.calls_reserved) < BigInt(limits.calls) && BigInt(row.tokens_reserved) < BigInt(limits.tokens);
}

async function event(client: PoolClient, current: Assignment, kind: string): Promise<Assignment> {
  await client.query('UPDATE agent_assignments SET revision=revision+1 WHERE id=$1', [current.id]);
  const changed = await lockAssignment(client, current.id);
  await client.query(
    'INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,$4)',
    [randomUUID(), current.id, changed.revision, kind],
  );
  return changed;
}

async function stopJobs(client: PoolClient, assignmentId: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE agent_jobs SET status='failed',error=$2,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
      lease_owner=NULL,lease_until=NULL WHERE assignment_id=$1 AND status IN ('queued','running')`, [assignmentId, reason],
  );
}

/** Uses the existing queue and lease policy. The caller must share the legacy worker's concurrency slots. */
export function claimManualBlogStep(
  db: Pool, workerPool: string, owner: string, signal: AbortSignal, checkCurrent: CurrentAssignmentCheck,
): Promise<ClaimedAssignmentStep | null> {
  if (!workerPool.trim() || !owner.trim()) return Promise.reject(new ValidationError('The worker pool and lease owner are required.'));
  return workforceTransaction(db, async client => {
    signal.throwIfAborted();
    const candidates = await client.query<{ id: string }>(
      `SELECT a.id FROM agent_assignments a WHERE a.worker_pool=$1 AND a.workflow='manual-blog'
        AND a.workflow_version=$2 AND a.policy_profile='manual-blog' AND a.status IN ('queued','running')
        AND NOT EXISTS (SELECT 1 FROM agent_jobs r WHERE r.assignment_id=a.id AND r.status='running')
        AND EXISTS (SELECT 1 FROM agent_jobs j LEFT JOIN agent_jobs d ON d.id=j.depends_on
          WHERE j.assignment_id=a.id AND j.worker_pool=$1 AND j.status='queued' AND j.protocol_version=$3
            AND j.task_profile=ANY($4) AND (j.depends_on IS NULL OR d.status='done'))
        ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
      [workerPool, WORKFORCE_VERSION, AGENT_PROTOCOL_VERSION, PROFILE_IDS],
    );
    if (!candidates.rows[0]) return null;
    let current = await lockAssignment(client, candidates.rows[0].id);
    if (!await availableBudget(client, current)) {
      await transitionAssignment(client, current.id, current.revision, current.status, 'waiting', {
        readiness: 'blocked', reason: 'The approved allowance is unavailable, exhausted or expired. Saved work requires an authorised review.',
      });
      return null;
    }
    const jobs = await client.query<RuntimeJob>(
      `SELECT j.* FROM agent_jobs j LEFT JOIN agent_jobs d ON d.id=j.depends_on
        WHERE j.assignment_id=$1 AND j.worker_pool=$2 AND j.status='queued' AND j.protocol_version=$3
          AND j.task_profile=ANY($4) AND (j.depends_on IS NULL OR d.status='done')
        ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j`,
      [current.id, workerPool, AGENT_PROTOCOL_VERSION, PROFILE_IDS],
    );
    const job = jobs.rows[0];
    if (!job) throw new ConflictError('The eligible step changed during claim.', 'ASSIGNMENT_STEP_INVALID');
    let definition: StepDefinition;
    try { definition = manualBlogStepDefinition(job, current); }
    catch (error) {
      if (!(error instanceof ConflictError || error instanceof ValidationError)) throw error;
      await stopJobs(client, current.id, error.message);
      await transitionAssignment(client, current.id, current.revision, current.status, 'failed', { readiness: 'blocked', reason: error.message });
      return null;
    }
    if (job.attempts >= AGENT_MAX_ATTEMPTS) {
      const reason = 'This step exhausted its existing interruption/retry limit. Saved artifacts remain available.';
      await transitionAssignment(client, current.id, current.revision, current.status, 'failed', { readiness: 'blocked', reason });
      await stopJobs(client, current.id, reason);
      return null;
    }
    try { await checkCurrent(client, current); }
    catch (error) {
      if (!(error instanceof ConflictError) || error.code !== 'ASSIGNMENT_SOURCE_CHANGED') throw error;
      await stopJobs(client, current.id, error.message);
      await transitionAssignment(client, current.id, current.revision, current.status, 'superseded', { readiness: 'blocked', reason: error.message });
      return null;
    }
    if (current.status === 'queued') {
      current = await transitionAssignment(client, current.id, current.revision, 'queued', 'running', { readiness: 'pending', reason: null });
      await client.query(
        `INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,'step-started')`,
        [randomUUID(), current.id, current.revision],
      );
    } else current = await event(client, current, 'step-started');
    const claimed = await client.query<{ attempts: number }>(
      `UPDATE agent_jobs SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,clock_timestamp()),
        finished_at=NULL,error=NULL,lease_owner=$2,lease_until=LEAST($4::timestamptz,clock_timestamp()+$3*INTERVAL '1 millisecond'),
        updated_at=clock_timestamp() WHERE id=$1 AND status='queued' RETURNING attempts`,
      [job.id, owner, AGENT_LEASE_MS, current.deadline],
    );
    if (!claimed.rows[0]) throw new ConflictError('The step could not be claimed.', 'AGENT_ATTEMPT_CONFLICT');
    signal.throwIfAborted();
    return {
      identity: { assignmentId: current.id, jobId: job.id, attempt: claimed.rows[0].attempts, owner, workerPool, signal },
      assignment: current, definition, input: job.input, specialist: job.specialist,
    };
  });
}

/** Assignment-before-job locking matches domain acceptance, cancellation and reservations. */
export function renewAssignmentLease(db: Pool, identity: StepAttempt): Promise<boolean> {
  return workforceTransaction(db, async client => {
    identity.signal.throwIfAborted();
    const current = await lockAssignment(client, identity.assignmentId);
    if (current.workerPool !== identity.workerPool || current.status !== 'running') return false;
    const profile = await client.query(
      `SELECT p.id FROM agent_budget_profiles p JOIN agent_assignments a ON a.budget_profile_id=p.id
        WHERE a.id=$1 AND p.enabled AND a.deadline>clock_timestamp() FOR SHARE OF p`, [current.id],
    );
    if (!profile.rowCount) return false;
    const result = await client.query(
      `UPDATE agent_jobs j SET lease_until=LEAST(a.deadline,clock_timestamp()+$5*INTERVAL '1 millisecond')
        FROM agent_assignments a JOIN agent_budget_profiles p ON p.id=a.budget_profile_id
        WHERE j.id=$1 AND j.assignment_id=a.id AND a.id=$2 AND j.attempts=$3 AND j.lease_owner=$4
          AND j.worker_pool=$6 AND j.status='running' AND j.lease_until>clock_timestamp()
          AND a.deadline>clock_timestamp() AND p.enabled RETURNING j.id`,
      [identity.jobId, identity.assignmentId, identity.attempt, identity.owner, AGENT_LEASE_MS, identity.workerPool],
    );
    return Boolean(result.rowCount);
  });
}

/** One bounded recovery per poll; never steals a live lease or changes a waiting assignment. */
export function recoverAssignmentStep(db: Pool, workerPool: string): Promise<Assignment | null> {
  return workforceTransaction(db, async client => {
    const selected = await client.query<{ id: string }>(
      `SELECT a.id FROM agent_assignments a JOIN agent_budget_profiles p ON p.id=a.budget_profile_id
        WHERE a.worker_pool=$1 AND a.workflow='manual-blog' AND a.workflow_version=$2
          AND a.status IN ('queued','running') AND (
            a.deadline<=clock_timestamp() OR NOT p.enabled OR EXISTS (
              SELECT 1 FROM agent_jobs j WHERE j.assignment_id=a.id AND j.worker_pool=$1 AND j.protocol_version=$3
                AND j.status='running' AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())))
        ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
      [workerPool, WORKFORCE_VERSION, AGENT_PROTOCOL_VERSION],
    );
    if (!selected.rows[0]) return null;
    const current = await lockAssignment(client, selected.rows[0].id);
    if (!await availableBudget(client, current)) {
      const reason = 'The approved allowance is unavailable, exhausted or expired. Saved work requires an authorised review.';
      await client.query(
        `UPDATE agent_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,error=$2,updated_at=clock_timestamp()
          WHERE assignment_id=$1 AND status='running'`, [current.id, reason],
      );
      return transitionAssignment(client, current.id, current.revision, current.status, 'waiting', { readiness: 'blocked', reason });
    }
    const expired = await client.query<RuntimeJob>(
      `SELECT * FROM agent_jobs WHERE assignment_id=$1 AND worker_pool=$2 AND protocol_version=$3 AND status='running'
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at,id FOR UPDATE`,
      [current.id, workerPool, AGENT_PROTOCOL_VERSION],
    );
    if (!expired.rows.length) return null;
    if (expired.rows.some(job => job.attempts >= AGENT_MAX_ATTEMPTS)) {
      const reason = 'A worker was interrupted too many times. Saved artifacts remain available; no unchecked result was accepted.';
      await stopJobs(client, current.id, reason);
      return transitionAssignment(client, current.id, current.revision, current.status, 'failed', { readiness: 'blocked', reason });
    }
    await client.query(
      `UPDATE agent_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp(),
        error='The previous lease expired. Resuming the same step within its original allowance.'
        WHERE assignment_id=$1 AND status='running' AND (lease_until IS NULL OR lease_until<=clock_timestamp())`,
      [current.id],
    );
    return event(client, current, 'lease-recovered');
  });
}

export type StepFailure =
  | { kind: 'transient' | 'shutdown' | 'failed'; reason: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'stale'; reason: string };

export function recordAssignmentFailure(db: Pool, identity: StepAttempt, failure: StepFailure): Promise<Assignment | null> {
  if (!failure.reason.trim()) return Promise.reject(new ValidationError('An assignment failure requires an explanation.'));
  return workforceTransaction(db, async client => {
    const current = await lockAssignment(client, identity.assignmentId);
    if (current.workerPool !== identity.workerPool || current.status !== 'running') return null;
    const allowanceAvailable = failure.kind === 'transient' || failure.kind === 'shutdown'
      ? await availableBudget(client, current) : false;
    const result = await client.query<RuntimeJob>(
      `SELECT * FROM agent_jobs WHERE id=$1 AND assignment_id=$2 AND attempts=$3 AND lease_owner=$4 AND worker_pool=$5
        AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`,
      [identity.jobId, identity.assignmentId, identity.attempt, identity.owner, identity.workerPool],
    );
    const job = result.rows[0];
    if (!job) return null;
    const retry = (failure.kind === 'transient' || failure.kind === 'shutdown')
      && job.attempts < AGENT_MAX_ATTEMPTS && allowanceAvailable;
    if (retry || failure.kind === 'wait') {
      await client.query(
        `UPDATE agent_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,error=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [job.id, failure.reason],
      );
      return retry ? event(client, current, 'step-retry')
        : transitionAssignment(client, current.id, current.revision, 'running', 'waiting', { readiness: 'blocked', reason: failure.reason });
    }
    const to = failure.kind === 'stale' ? 'superseded' : 'failed';
    await stopJobs(client, current.id, failure.reason);
    return transitionAssignment(client, current.id, current.revision, 'running', to, { readiness: 'blocked', reason: failure.reason });
  });
}

export interface ResumeAuthorisation {
  ownerId: string;
  revision: number;
  requestId: string;
  checkCurrent: CurrentAssignmentCheck;
}

/** Explicit, owner/revision-bound action; it never replaces the brief, sources, deadline or allowance. */
export function resumeAssignment(db: Pool, id: string, authority: ResumeAuthorisation): Promise<Assignment> {
  if (!authority.requestId.trim() || authority.requestId.length > MAX_REQUEST_ID_CHARS) return Promise.reject(new ValidationError('A bounded explicit resume request ID is required.'));
  return workforceTransaction(db, async client => {
    const access = await client.query('SELECT id FROM agent_assignments WHERE id=$1 AND owner_id=$2', [id, authority.ownerId]);
    if (!access.rowCount) throw new NotFoundError('Workforce assignment');
    const current = await lockAssignment(client, id);
    if (current.status !== 'waiting' || current.revision !== authority.revision) {
      throw new ConflictError('The waiting assignment changed. Refresh before requesting resume.', 'ASSIGNMENT_REVISION_CONFLICT');
    }
    if (!await availableBudget(client, current)) throw new ForbiddenError('Resume cannot reset an expired, disabled or exhausted allowance. A new approved commission is required.');
    await authority.checkCurrent(client, current);
    const jobs = await client.query<RuntimeJob>("SELECT * FROM agent_jobs WHERE assignment_id=$1 AND status='queued' ORDER BY created_at,id FOR UPDATE", [id]);
    if (jobs.rows.length !== 1 || !jobs.rows[0] || jobs.rows[0].attempts >= AGENT_MAX_ATTEMPTS) {
      throw new ConflictError('No single resumable step remains within the existing attempt limit.', 'ASSIGNMENT_RESUME_INVALID');
    }
    manualBlogStepDefinition(jobs.rows[0], current);
    const resumed = await transitionAssignment(client, id, current.revision, 'waiting', 'running', { readiness: 'pending', reason: null });
    await client.query(
      `INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind,metadata) VALUES($1,$2,$3,'resumed',$4::jsonb)`,
      [randomUUID(), id, resumed.revision, JSON.stringify({ requestId: authority.requestId, ownerId: authority.ownerId })],
    );
    return resumed;
  });
}

const MAX_REQUEST_ID_CHARS = 4_000;
