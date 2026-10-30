import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError, ValidationError } from '../../types/errors.js';
import { currentAgentAttempt, lockAgentAttempt, withAgentAttempt } from '../attempt.js';
import {
  AGENT_PROTOCOL_VERSION, MANUAL_BLOG_STEPS, WORKFORCE_VERSION, contentSignature, parseArtifactReference, positiveInteger,
  type ArtifactReference, type Assignment, type StepDefinition,
} from './contracts.js';
import { insertAssignmentStep, lockAssignment, transitionAssignment, workforceTransaction } from './store.js';

export type ManualBlogStep = keyof typeof MANUAL_BLOG_STEPS;

export interface StepAttempt {
  assignmentId: string;
  jobId: string;
  attempt: number;
  owner: string;
  workerPool: string;
  signal: AbortSignal;
}

export interface StoredArtifact {
  id: string;
  reference: ArtifactReference;
}

export interface StepAcceptance {
  reference: ArtifactReference;
  schemaVersion: number;
  summary: string;
  disposition:
    | { kind: 'continue' }
    | { kind: 'review'; requiresRevision: boolean; readiness: 'ready' | 'blocked'; reason: string | null }
    | { kind: 'wait'; reason: string };
}

/** Server-owned domain acceptance, never provided as a model tool argument or to a role executor. */
export interface StepAcceptanceAdapter {
  /** Revalidate authority/scope and lock controlling source versions until commit. No network/model work here. */
  checkCurrent: (client: PoolClient, assignment: Assignment) => Promise<void>;
  /** Validate the exact output and save through the canonical domain store in this transaction. */
  accept: (
    client: PoolClient,
    context: { assignment: Assignment; step: ManualBlogStep; inputs: readonly StoredArtifact[] },
    proposal: unknown,
  ) => Promise<StepAcceptance>;
}

interface StepRow {
  id: string;
  assignment_id: string;
  worker_pool: string;
  attempts: number;
  protocol_version: number;
  step_key: string;
  role_id: string;
  task_profile: string;
  prompt_version: number;
  output_type: string;
  specialist: string;
  subject_type: string;
  subject_id: string;
  subject_title: string;
  subject_url: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: string;
  lease_until: Date | null;
}

interface ArtifactRow { id: string; domain_reference: unknown }

export function manualBlogStepDefinition(
  job: Pick<StepRow, 'step_key' | 'protocol_version' | 'role_id' | 'task_profile' | 'prompt_version' | 'output_type' | 'subject_type' | 'subject_id'>,
  assignment: Assignment,
): typeof MANUAL_BLOG_STEPS[ManualBlogStep] {
  if (assignment.brief.workflow !== 'manual-blog' || assignment.brief.workflowVersion !== WORKFORCE_VERSION
    || assignment.brief.policyProfile !== 'manual-blog' || assignment.brief.scope.readOnly) {
    throw new ValidationError('This controller only accepts the authorised manual-blog workflow and policy version.');
  }
  const definition = Object.values(MANUAL_BLOG_STEPS).find(step => step.key === job.step_key);
  if (!definition || job.protocol_version !== AGENT_PROTOCOL_VERSION
    || definition.role !== job.role_id || definition.profile !== job.task_profile
    || definition.promptVersion !== job.prompt_version || definition.outputType !== job.output_type
    || job.subject_type !== assignment.brief.subjectType || job.subject_id !== assignment.brief.subjectId) {
    throw new ConflictError('The assignment step does not match the fixed workflow definition.', 'ASSIGNMENT_STEP_INVALID');
  }
  return definition;
}

type Advancement =
  | { kind: 'next'; step: StepDefinition }
  | { kind: 'complete'; readiness: 'ready' | 'blocked'; reason: string | null }
  | { kind: 'wait'; reason: string };

function requiredReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_SUMMARY_CHARS) {
    throw new ValidationError('A blocked or waiting disposition requires a bounded explanation.');
  }
  return reason.trim();
}

const MAX_SUMMARY_CHARS = 4_000;

function advancement(step: string, accepted: StepAcceptance): Advancement {
  const disposition = accepted.disposition;
  if (disposition.kind === 'wait') return { kind: 'wait', reason: requiredReason(disposition.reason) };
  if (disposition.kind === 'continue') {
    const next = step === 'research' ? MANUAL_BLOG_STEPS.draft
      : step === 'draft' ? MANUAL_BLOG_STEPS.critique : step === 'revision' ? MANUAL_BLOG_STEPS.recheck : undefined;
    if (!next) throw new ValidationError('A critic must return a validated review disposition, not an author continuation.');
    return { kind: 'next', step: next };
  }
  if (disposition.kind !== 'review' || (step !== 'critique' && step !== 'recheck')
    || typeof disposition.requiresRevision !== 'boolean'
    || (disposition.readiness !== 'ready' && disposition.readiness !== 'blocked')) {
    throw new ValidationError('Only the independent critic can supply a validated review disposition.');
  }
  const reason = disposition.readiness === 'blocked' ? requiredReason(disposition.reason)
    : disposition.reason === null ? null : requiredReason(disposition.reason);
  if (disposition.requiresRevision) {
    if (step !== 'critique') throw new ConflictError('This assignment has already used its one automatic author revision.', 'ASSIGNMENT_REVISION_EXHAUSTED');
    return { kind: 'next', step: MANUAL_BLOG_STEPS.revision };
  }
  return { kind: 'complete', readiness: disposition.readiness, reason };
}

function storedArtifact(row: ArtifactRow): StoredArtifact {
  return { id: row.id, reference: parseArtifactReference(row.domain_reference) };
}

export interface StepCompletion {
  assignment: Assignment;
  artifact: StoredArtifact;
  nextJobId: string | null;
  replayed: boolean;
}

/**
 * Accepts canonical domain output, its immutable reference and the deterministic successor together.
 * Models cannot choose a successor or receive this transaction's database capability.
 */
export function completeManualBlogStep(
  db: Pool, identity: StepAttempt, proposal: unknown, adapter: StepAcceptanceAdapter,
): Promise<StepCompletion> {
  const proposalSignature = contentSignature(proposal);
  const active = currentAgentAttempt();
  if (active && (active.jobId !== identity.jobId || active.assignmentId !== identity.assignmentId
    || active.attempt !== identity.attempt || active.owner !== identity.owner)) {
    return Promise.reject(new ConflictError('Acceptance cannot switch away from the active worker attempt.', 'AGENT_ATTEMPT_CONFLICT'));
  }
  const signal = active?.budgetSignal ? AbortSignal.any([identity.signal, active.budgetSignal]) : identity.signal;
  return withAgentAttempt({
    jobId: identity.jobId, assignmentId: identity.assignmentId, attempt: identity.attempt,
    owner: identity.owner, signal,
  }, () => workforceTransaction(db, async client => {
    signal.throwIfAborted();
    const current = await lockAssignment(client, identity.assignmentId);
    if (current.workerPool !== identity.workerPool) throw new ConflictError('This worker cannot accept another pool\'s output.', 'AGENT_ATTEMPT_CONFLICT');
    const jobs = await client.query<StepRow>(
      `SELECT * FROM agent_jobs WHERE id=$1 AND assignment_id=$2 AND worker_pool=$3 AND attempts=$4 FOR UPDATE`,
      [identity.jobId, identity.assignmentId, identity.workerPool, identity.attempt],
    );
    const job = jobs.rows[0];
    if (!job) throw new ConflictError('The assignment step changed before acceptance.', 'AGENT_ATTEMPT_CONFLICT');
    const definition = manualBlogStepDefinition(job, current);
    const previous = job.result?.['workforceCompletion'];
    if (job.status === 'done' && previous && typeof previous === 'object'
      && 'signature' in previous && previous.signature === proposalSignature
      && 'owner' in previous && previous.owner === identity.owner) {
      const saved = await client.query<ArtifactRow>(
        'SELECT id,domain_reference FROM agent_artifacts WHERE producer_job_id=$1 AND producer_attempt=$2 ORDER BY created_at DESC LIMIT 1',
        [job.id, identity.attempt],
      );
      if (!saved.rows[0]) throw new ConflictError('The completed step is missing its immutable artifact reference.', 'ASSIGNMENT_ARTIFACT_MISSING');
      const next = await client.query<{ id: string }>('SELECT id FROM agent_jobs WHERE depends_on=$1 AND assignment_id=$2', [job.id, current.id]);
      return { assignment: current, artifact: storedArtifact(saved.rows[0]), nextJobId: next.rows[0]?.id ?? null, replayed: true };
    }
    await lockAgentAttempt(client);
    await adapter.checkCurrent(client, current);
    const inputs = await client.query<ArtifactRow>(
      'SELECT id,domain_reference FROM agent_artifacts WHERE assignment_id=$1 ORDER BY created_at,id', [current.id],
    );
    const accepted = await adapter.accept(client, {
      assignment: current, step: definition.key, inputs: inputs.rows.map(storedArtifact),
    }, proposal);
    const reference = parseArtifactReference(accepted.reference);
    const schemaVersion = positiveInteger(accepted.schemaVersion, 'Artifact schema version');
    if (reference.type !== definition.outputType || schemaVersion !== WORKFORCE_VERSION) {
      throw new ValidationError('The accepted artifact does not match this step\'s output contract.');
    }
    if (typeof accepted.summary !== 'string' || !accepted.summary.trim() || accepted.summary.length > MAX_SUMMARY_CHARS) {
      throw new ValidationError('A completed step requires a bounded outcome summary.');
    }
    const next = advancement(definition.key, accepted);
    await adapter.checkCurrent(client, current);
    await lockAgentAttempt(client);
    const artifact: StoredArtifact = { id: randomUUID(), reference };
    await client.query(
      `INSERT INTO agent_artifacts(id,assignment_id,producer_job_id,producer_attempt,artifact_type,schema_version,
        content_signature,domain_reference,source_versions,input_artifact_ids)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
      [artifact.id, current.id, job.id, identity.attempt, reference.type, schemaVersion, reference.signature,
        JSON.stringify(reference), JSON.stringify(current.brief.scope.sources), inputs.rows.map(input => input.id)],
    );
    const saved = await client.query(
      `UPDATE agent_jobs SET status=$5,result=COALESCE(result,'{}'::jsonb)||$6::jsonb
        ||jsonb_build_object('data',COALESCE(result->'data','{}'::jsonb)||($6::jsonb->'data')),
        error=$7,finished_at=CASE WHEN $5='done' THEN clock_timestamp() ELSE NULL END,
        lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
       WHERE id=$1 AND assignment_id=$2 AND attempts=$3 AND lease_owner=$4
         AND status='running' AND lease_until>clock_timestamp() RETURNING id`,
      [job.id, current.id, identity.attempt, identity.owner, next.kind === 'wait' ? 'queued' : 'done',
        JSON.stringify({
          data: { artifactId: artifact.id }, summary: accepted.summary.trim(),
          workforceCompletion: { signature: proposalSignature, owner: identity.owner },
        }), next.kind === 'wait' ? next.reason : null],
    );
    if (!saved.rowCount) throw new ConflictError('The step lost its lease before accepting output.', 'AGENT_ATTEMPT_CONFLICT');
    let updated: Assignment;
    let nextJobId: string | null = null;
    if (next.kind === 'next') {
      const successorInput = Object.fromEntries(Object.entries(job.input).filter(([key]) => !['workforceBlogOutput', 'blogCheckpoint', 'workforceBlogProjectionSignature'].includes(key)));
      nextJobId = await insertAssignmentStep(client, {
        assignmentId: current.id, brief: current.brief, workerPool: current.workerPool,
        definition: next.step, specialist: job.specialist, subjectTitle: job.subject_title, subjectUrl: job.subject_url,
        input: { ...successorInput, workforceArtifactIds: [...inputs.rows.map(input => input.id), artifact.id] }, dependsOn: job.id,
      });
      await client.query('UPDATE agent_assignments SET revision=revision+1 WHERE id=$1', [current.id]);
      updated = await lockAssignment(client, current.id);
      await client.query(
        `INSERT INTO agent_assignment_events(id,assignment_id,assignment_revision,kind) VALUES($1,$2,$3,'step-completed')`,
        [randomUUID(), updated.id, updated.revision],
      );
    } else {
      updated = await transitionAssignment(client, current.id, current.revision, 'running',
        next.kind === 'wait' ? 'waiting' : 'completed', {
          readiness: next.kind === 'wait' ? 'blocked' : next.readiness, reason: next.reason,
        });
    }
    const timely = await client.query(
      `SELECT a.id FROM agent_assignments a JOIN agent_budget_profiles p ON p.id=a.budget_profile_id
        WHERE a.id=$1 AND a.deadline>clock_timestamp() AND p.enabled AND $2::timestamptz>clock_timestamp()`,
      [current.id, job.lease_until],
    );
    if (!timely.rowCount) throw new ConflictError('The assignment stopped before acceptance could commit.', 'AGENT_ATTEMPT_CONFLICT');
    signal.throwIfAborted();
    return { assignment: updated, artifact, nextJobId, replayed: false };
  }));
}
