import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../types/errors.js';
import {
  canTransition, commissionSignature, isTerminalAssignment, parseAssignmentBrief, parseBudgetLimits,
  type Assignment, type AssignmentBrief, type AssignmentState, type BudgetLimits, type Readiness, type StepDefinition,
} from './contracts.js';

interface AssignmentRow {
  id: string;
  brief: unknown;
  worker_pool: string;
  status: AssignmentState;
  readiness: Readiness;
  revision: number;
  budget_profile_id: string;
  deadline: Date;
  reason: string | null;
  created_at: Date;
  finished_at: Date | null;
  commission_signature: string;
}

const assignment = (row: AssignmentRow): Assignment => ({
  id: row.id, brief: parseAssignmentBrief(row.brief), workerPool: row.worker_pool, status: row.status,
  readiness: row.readiness, revision: row.revision, budgetProfileId: row.budget_profile_id,
  deadline: row.deadline, reason: row.reason, createdAt: row.created_at, finishedAt: row.finished_at,
});

export async function workforceTransaction<T>(db: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { discard = true; console.error('[workforce] Transaction rollback failed:', rollbackError); }
    throw error;
  } finally { client.release(discard); }
}

export interface CommissionOptions {
  budgetProfileId: string;
  workerPool: string;
  /** A trusted domain adapter revalidates scope, current sources and real user authority. */
  authorise: (client: PoolClient, brief: AssignmentBrief) => Promise<void>;
  firstStep: StepDefinition;
  specialist: string;
  subjectTitle: string;
  subjectUrl: string;
  input: Record<string, unknown>;
  /** Optional canonical domain save, committed with the initial job before any worker can claim it. */
  initialiseStep?: (client: PoolClient, jobId: string, assignmentId: string) => Promise<void>;
}

export async function commissionAssignment(db: Pool, value: unknown, options: CommissionOptions): Promise<{ assignment: Assignment; existing: boolean }> {
  const brief = parseAssignmentBrief(value);
  if (brief.scope.readOnly) throw new ForbiddenError('Read-only requests cannot commission a mutating workforce assignment.');
  if (!options.workerPool.trim()) throw new ValidationError('The originating worker pool is required.');
  const signature = commissionSignature(brief);
  return workforceTransaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `agent-request:${JSON.stringify([brief.ownerId, options.workerPool, brief.origin.requestId])}`,
    ]);
    const request = await client.query<AssignmentRow>(
      `SELECT * FROM agent_assignments WHERE owner_id=$1 AND worker_pool=$2 AND request_id=$3 FOR UPDATE`,
      [brief.ownerId, options.workerPool, brief.origin.requestId],
    );
    const previous = request.rows[0];
    if (previous) {
      if (previous.commission_signature !== signature) throw new ConflictError('This request ID belongs to a different commission.', 'ASSIGNMENT_REQUEST_CONFLICT');
      return { assignment: assignment(previous), existing: true };
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-subject:${brief.subjectType}:${brief.subjectId}`]);
    await options.authorise(client, brief);
    const active = await client.query<AssignmentRow>(
      `SELECT * FROM agent_assignments WHERE subject_type=$1 AND subject_id=$2 AND status IN ('queued','running','waiting') FOR UPDATE`,
      [brief.subjectType, brief.subjectId],
    );
    const busy = active.rows[0];
    if (busy) {
      if (busy.commission_signature === signature && busy.worker_pool === options.workerPool) return { assignment: assignment(busy), existing: true };
      throw new ConflictError('Another assignment owns this subject with a different brief or worker pool.', 'AGENT_SUBJECT_BUSY');
    }
    const legacy = await client.query(
      `SELECT id FROM agent_jobs WHERE subject_type=$1 AND subject_id=$2 AND assignment_id IS NULL
        AND status IN ('queued','running') LIMIT 1`,
      [brief.subjectType, brief.subjectId],
    );
    if (legacy.rowCount) throw new ConflictError('A specialist is already working on this subject.', 'AGENT_SUBJECT_BUSY');
    const profile = await client.query<{ limits: unknown }>(
      `SELECT limits FROM agent_budget_profiles WHERE id=$1 AND workflow=$2 AND workflow_version=$3
        AND policy_profile=$4 AND approved_by=$5 AND enabled FOR SHARE`,
      [options.budgetProfileId, brief.workflow, brief.workflowVersion, brief.policyProfile, brief.ownerId],
    );
    if (!profile.rows[0]) throw new ForbiddenError('This workflow has no enabled, owner-approved numeric budget profile.');
    const limits = parseBudgetLimits(profile.rows[0].limits);
    const id = randomUUID();
    const inserted = await client.query<AssignmentRow>(
      `INSERT INTO agent_assignments(id,owner_id,workflow,workflow_version,policy_profile,brief,commission_signature,
        request_id,worker_pool,subject_type,subject_id,budget_profile_id,deadline)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,clock_timestamp()+$13*INTERVAL '1 millisecond') RETURNING *`,
      [id, brief.ownerId, brief.workflow, brief.workflowVersion, brief.policyProfile, JSON.stringify(brief), signature,
        brief.origin.requestId, options.workerPool, brief.subjectType, brief.subjectId, options.budgetProfileId, limits.durationMs],
    );
    const jobId = await insertAssignmentStep(client, {
      assignmentId: id, brief, workerPool: options.workerPool, definition: options.firstStep,
      specialist: options.specialist, subjectTitle: options.subjectTitle, subjectUrl: options.subjectUrl, input: options.input,
    });
    await options.initialiseStep?.(client, jobId, id);
    const saved = inserted.rows[0];
    if (!saved) throw new Error('The assignment insert returned no row.');
    return { assignment: assignment(saved), existing: false };
  });
}

interface NewStep {
  assignmentId: string;
  brief: AssignmentBrief;
  workerPool: string;
  definition: StepDefinition;
  specialist: string;
  subjectTitle: string;
  subjectUrl: string;
  input: Record<string, unknown>;
  dependsOn?: string;
}

/** The fixed workflow controller supplies the definition, never a model tool argument. */
export async function insertAssignmentStep(client: PoolClient, step: NewStep): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO agent_jobs(id,specialist,subject_type,subject_id,subject_title,subject_url,input,worker_pool,
      requested_by,conversation_id,is_step,protocol_version,assignment_id,step_key,role_id,task_profile,prompt_version,output_type,depends_on)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,TRUE,2,$11,$12,$13,$14,$15,$16,$17)`,
    [id, step.specialist, step.brief.subjectType, step.brief.subjectId, step.subjectTitle, step.subjectUrl,
      JSON.stringify(step.input), step.workerPool, step.brief.origin.kind === 'chat' ? 'chat' : 'app',
      step.brief.origin.kind === 'chat' ? step.brief.origin.conversationId : null,
      step.assignmentId, step.definition.key, step.definition.role, step.definition.profile, step.definition.promptVersion, step.definition.outputType,
      step.dependsOn ?? null],
  );
  return id;
}

export async function getAssignment(db: Pool, id: string, ownerId: string): Promise<Assignment> {
  const result = await db.query<AssignmentRow>('SELECT * FROM agent_assignments WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  if (!result.rows[0]) throw new NotFoundError('Workforce assignment');
  return assignment(result.rows[0]);
}

/** A transport retry reads its durable receipt, without commissioning or reauthorising more work. */
export async function getAssignmentForRequest(db: Pool, ownerId: string, workerPool: string, requestId: string): Promise<Assignment | null> {
  const result = await db.query<AssignmentRow>(
    'SELECT * FROM agent_assignments WHERE owner_id=$1 AND worker_pool=$2 AND request_id=$3',
    [ownerId, workerPool, requestId],
  );
  return result.rows[0] ? assignment(result.rows[0]) : null;
}

/** Internal controller read; HTTP/chat callers must use the owner-scoped read. */
export async function lockAssignment(client: PoolClient, id: string): Promise<Assignment> {
  const result = await client.query<AssignmentRow>('SELECT * FROM agent_assignments WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new NotFoundError('Workforce assignment');
  return assignment(result.rows[0]);
}

export async function transitionAssignment(
  client: PoolClient, id: string, expectedRevision: number, from: AssignmentState, to: AssignmentState,
  outcome: { readiness: Readiness; reason: string | null },
): Promise<Assignment> {
  if (!canTransition(from, to)) throw new ConflictError(`An assignment cannot move from ${from} to ${to}.`, 'ASSIGNMENT_TRANSITION_INVALID');
  if (to === 'completed' && outcome.readiness === 'pending') throw new ValidationError('A completed assignment needs an explicit readiness disposition.');
  if (outcome.readiness === 'ready' && to !== 'completed') throw new ValidationError('Only a completed assignment can be ready.');
  const result = await client.query<AssignmentRow>(
    `UPDATE agent_assignments SET status=$4,readiness=$5,reason=$6,revision=revision+1,
      finished_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END
      WHERE id=$1 AND revision=$2 AND status=$3 RETURNING *`,
    [id, expectedRevision, from, to, outcome.readiness, outcome.reason, isTerminalAssignment(to)],
  );
  const row = result.rows[0];
  if (!row) throw new ConflictError('The assignment changed before this transition.', 'ASSIGNMENT_REVISION_CONFLICT');
  if (isTerminalAssignment(to) || to === 'waiting') {
    await client.query(
      `INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,$4)`,
      [randomUUID(), row.id, row.revision, to],
    );
  }
  return assignment(row);
}

export async function cancelAssignment(db: Pool, id: string, ownerId: string, revision: number): Promise<Assignment> {
  return workforceTransaction(db, async client => {
    const result = await client.query<AssignmentRow>('SELECT * FROM agent_assignments WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Workforce assignment');
    if (row.status === 'cancelled') return assignment(row);
    const cancelled = await transitionAssignment(client, id, revision, row.status, 'cancelled', {
      readiness: 'blocked', reason: 'Cancelled. Saved artifacts remain available; delivery records are unchanged.',
    });
    await client.query(
      `UPDATE agent_jobs SET status='failed',error='The owning assignment was cancelled.',finished_at=clock_timestamp(),
        lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
       WHERE assignment_id=$1 AND status IN ('queued','running')`,
      [id],
    );
    return cancelled;
  });
}

export interface BudgetReservation { id: string; tokens: number; remainingMs: number }
interface ReservationIdentity { assignmentId: string; jobId: string; attempt: number; leaseOwner: string }

export async function reserveAssignmentCall(
  client: PoolClient, identity: ReservationIdentity, tokens: number,
): Promise<BudgetReservation> {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new ValidationError('A conservative token reservation is required before dispatch.');
  return await reserveAssignmentOperation(client, identity, tokens, 'model');
}

export function reserveAssignmentResearch(client: PoolClient, identity: ReservationIdentity): Promise<BudgetReservation> {
  return reserveAssignmentOperation(client, identity, 0, 'research');
}

async function reserveAssignmentOperation(
  client: PoolClient, identity: ReservationIdentity, tokens: number, kind: 'model' | 'research',
): Promise<BudgetReservation> {
  const result = await client.query<{ limits: unknown; calls_reserved: string; tokens_reserved: string; remaining_ms: number }>(
    `SELECT p.limits,a.calls_reserved,a.tokens_reserved,
      EXTRACT(EPOCH FROM (a.deadline-clock_timestamp()))*1000 AS remaining_ms FROM agent_assignments a
      JOIN agent_budget_profiles p ON p.id=a.budget_profile_id
      WHERE a.id=$1 AND a.status='running' AND a.deadline>clock_timestamp() AND p.enabled FOR UPDATE OF a FOR SHARE OF p`,
    [identity.assignmentId],
  );
  const row = result.rows[0];
  if (!row) throw new ConflictError('The assignment stopped, expired or its budget profile was disabled.', 'ASSIGNMENT_STOPPED');
  const limits: BudgetLimits = parseBudgetLimits(row.limits);
  if (BigInt(row.calls_reserved) + BigInt(1) > BigInt(limits.calls) || BigInt(row.tokens_reserved) + BigInt(tokens) > BigInt(limits.tokens)) {
    throw new ConflictError('The shared assignment budget is exhausted. Saved work has been retained.', 'ASSIGNMENT_BUDGET_EXHAUSTED');
  }
  const job = await client.query(
    `SELECT id FROM agent_jobs WHERE id=$1 AND assignment_id=$2 AND attempts=$3 AND lease_owner=$4
      AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`,
    [identity.jobId, identity.assignmentId, identity.attempt, identity.leaseOwner],
  );
  if (!job.rowCount) throw new ConflictError('This attempt no longer owns the assignment step.', 'AGENT_ATTEMPT_CONFLICT');
  await client.query(
    'UPDATE agent_assignments SET calls_reserved=calls_reserved+1,tokens_reserved=tokens_reserved+$2 WHERE id=$1',
    [identity.assignmentId, tokens],
  );
  const id = randomUUID();
  await client.query(
    `INSERT INTO agent_budget_reservations(id,assignment_id,job_id,attempt,tokens_reserved,operation_kind) VALUES($1,$2,$3,$4,$5,$6)`,
    [id, identity.assignmentId, identity.jobId, identity.attempt, tokens, kind],
  );
  return { id, tokens, remainingMs: Number(row.remaining_ms) };
}

export async function pauseAssignmentBudget(db: Pool, identity: ReservationIdentity, reason: string): Promise<void> {
  await workforceTransaction(db, async client => {
    await client.query('SELECT id FROM agent_assignments WHERE id=$1 FOR UPDATE', [identity.assignmentId]);
    const changed = await client.query<{ revision: number }>(
      `UPDATE agent_assignments SET status='waiting',readiness='blocked',reason=$2,revision=revision+1
        WHERE id=$1 AND status='running' AND EXISTS (
          SELECT 1 FROM agent_jobs WHERE id=$3 AND assignment_id=$1 AND attempts=$4 AND lease_owner=$5
            AND status='running' AND lease_until>clock_timestamp()) RETURNING revision`,
      [identity.assignmentId, reason, identity.jobId, identity.attempt, identity.leaseOwner],
    );
    if (!changed.rows[0]) return;
    await client.query(
      `UPDATE agent_jobs SET status='queued',error=$5,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND assignment_id=$2 AND attempts=$3 AND lease_owner=$4 AND status='running'`,
      [identity.jobId, identity.assignmentId, identity.attempt, identity.leaseOwner, reason],
    );
    await client.query(
      `INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,'waiting')`,
      [randomUUID(), identity.assignmentId, changed.rows[0].revision],
    );
  });
}

export async function recordReservationUsage(db: Pool, reservationId: string, tokens: number | null): Promise<void> {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new ValidationError('Provider usage must be known non-negative tokens or explicitly unknown.');
  const exceeded = await workforceTransaction(db, async client => {
    const reservation = await client.query<{ assignment_id: string; tokens_reserved: string }>(
      'SELECT assignment_id,tokens_reserved FROM agent_budget_reservations WHERE id=$1', [reservationId],
    );
    const row = reservation.rows[0];
    if (!row) throw new NotFoundError('Usage reservation');
    await client.query('SELECT id FROM agent_assignments WHERE id=$1 FOR UPDATE', [row.assignment_id]);
    const saved = await client.query(
      `UPDATE agent_budget_reservations SET tokens_actual=$2,status=CASE WHEN $2::bigint IS NULL THEN 'unknown' ELSE 'known' END
        WHERE id=$1 AND status='reserved' RETURNING id`,
      [reservationId, tokens],
    );
    if (!saved.rowCount) throw new ConflictError('This usage reservation was already reconciled or is unavailable.', 'ASSIGNMENT_USAGE_CONFLICT');
    const overrun = tokens === null ? BigInt(0) : BigInt(tokens) - BigInt(row.tokens_reserved);
    if (overrun <= BigInt(0)) return false;
    const changed = await client.query<{ revision: number }>(
      `UPDATE agent_assignments SET tokens_reserved=tokens_reserved+$2,readiness='blocked',revision=revision+1,
        status=CASE WHEN status='running' THEN 'waiting' ELSE status END,
        reason='Provider usage exceeded its conservative reservation. Saved work requires budget review.'
        WHERE id=$1 RETURNING revision`,
      [row.assignment_id, overrun.toString()],
    );
    const revision = changed.rows[0]?.revision;
    if (revision === undefined) throw new Error('The assignment disappeared while recording a budget overrun.');
    await client.query(
      `INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,'budget-overrun')`,
      [randomUUID(), row.assignment_id, revision],
    );
    return true;
  });
  if (exceeded) throw new ConflictError('Provider usage exceeded its reservation. Further work was stopped; the actual charge was retained.', 'ASSIGNMENT_BUDGET_OVERRUN');
}
