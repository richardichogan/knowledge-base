/**
 * agents/engine.ts — runs specialist jobs in the background.
 *
 * Athena (or a button in the app) hands work off with handOff(); the job is
 * saved, any prerequisite jobs are queued ahead of it, and this server's worker
 * picks it up. Progress and results are saved as they happen and pushed to the
 * app live. When a handoff came from a chat, Athena posts the outcome there.
 *
 * Local development shares the production database, so every job belongs to a
 * worker pool and a server only runs its own pool's jobs.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import { ConflictError, KnowledgeHubError, NotFoundError, ValidationError } from '../types/errors.js';
import { appendAssistantMessage } from '../ai/chatSessionStore.js';
import { getSpecialist, type Prerequisite } from './registry.js';
import { withAiWorkflow } from '../ai/aiWorkflow.js';
import { withAgentAttempt } from './attempt.js';
import { AGENT_HEARTBEAT_MS, AGENT_LEASE_MS, AGENT_MAX_ATTEMPTS, AGENT_PROTOCOL_VERSION, contentSignature } from './workforce/contracts.js';
import { claimConfiguredAssignment, recoverConfiguredAssignments, runConfiguredAssignment } from './workforce/dispatcher.js';
import { deliverAssignmentNotices } from './workforce/notices.js';

export type AgentJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AgentJob {
  id: string;
  specialist: string;
  specialistName: string;
  subjectType: string;
  subjectId: string;
  subjectTitle: string;
  subjectUrl: string;
  status: AgentJobStatus;
  progress: string[];
  summary: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  dependsOn: string | null;
  isStep: boolean;
  conversationId: string | null;
  requestedBy: 'app' | 'chat';
  acknowledged: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PlannedStep { specialist: string; specialistName: string; reason: string; overwrites: boolean }

export type HandOffResult =
  | { status: 'queued'; job: AgentJob; steps: AgentJob[] }
  | { status: 'already_running'; job: AgentJob }
  | { status: 'needs_confirmation'; plan: PlannedStep[]; message: string };

interface JobRow {
  id: string; specialist: string; subject_type: string; subject_id: string; subject_title: string; subject_url: string;
  input: Record<string, unknown>; status: AgentJobStatus; progress: string[]; result: Record<string, unknown> | null;
  error: string | null; depends_on: string | null; is_step: boolean; conversation_id: string | null;
  requested_by: 'app' | 'chat'; attempts: number; acknowledged_at: Date | null; created_at: Date;
  started_at: Date | null; finished_at: Date | null;
  lease_owner: string | null; lease_until: Date | null; assignment_id: string | null;
}

const CONCURRENCY = 2;
const POLL_MS = 5_000;
const MAX_PROGRESS = 30;
const ACTIVE = ['queued', 'running'];
const MAX_LISTENERS = 100;
const DEFAULT_LIST = 10;
const MAX_LIST = 50;
const MAX_PROGRESS_CHARS = 300;

export const agentJobEvents = new EventEmitter();
agentJobEvents.setMaxListeners(MAX_LISTENERS);

export function workerPool(): string {
  if (env.ATHENA_AGENT_POOL) return env.ATHENA_AGENT_POOL;
  return env.isProduction ? 'production' : `local-${hostname()}`;
}

function toJob(row: JobRow): AgentJob {
  const result = row.result;
  return {
    id: row.id,
    specialist: row.specialist,
    specialistName: getSpecialist(row.specialist)?.name ?? row.specialist,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectTitle: row.subject_title,
    subjectUrl: row.subject_url,
    status: row.status,
    progress: row.progress,
    summary: typeof result?.['summary'] === 'string' ? result['summary'] : null,
    result: result && typeof result['data'] === 'object' ? result['data'] as Record<string, unknown> : null,
    error: row.error,
    dependsOn: row.depends_on,
    isStep: row.is_step,
    conversationId: row.conversation_id,
    requestedBy: row.requested_by,
    acknowledged: row.acknowledged_at !== null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function emit(row: JobRow): AgentJob {
  const job = toJob(row);
  agentJobEvents.emit('job', job);
  return job;
}

export async function getAgentJob(db: Pool, id: string, ownerId?: string): Promise<AgentJob> {
  const { rows } = await db.query<JobRow>(
    `SELECT * FROM agent_jobs j WHERE j.id=$1 AND (j.assignment_id IS NULL
      OR EXISTS(SELECT 1 FROM agent_assignments a WHERE a.id=j.assignment_id AND a.owner_id=$2))`, [id, ownerId ?? null],
  );
  if (!rows[0]) throw new NotFoundError('Specialist job');
  return toJob(rows[0]);
}

/** Jobs still running anywhere plus finished ones the app has not shown yet. */
export async function listLiveAgentJobs(db: Pool): Promise<AgentJob[]> {
  const { rows } = await db.query<JobRow>(
    `SELECT * FROM agent_jobs
      WHERE assignment_id IS NULL AND (status = ANY($1) OR (acknowledged_at IS NULL AND finished_at > NOW() - INTERVAL '1 day'))
      ORDER BY created_at`,
    [ACTIVE],
  );
  return rows.map(toJob);
}

export async function listAgentJobs(db: Pool, filter: { subjectType?: string | undefined; subjectId?: string | undefined; limit?: number | undefined }): Promise<AgentJob[]> {
  const { rows } = await db.query<JobRow>(
    `SELECT * FROM agent_jobs
      WHERE assignment_id IS NULL AND ($1::text IS NULL OR subject_type = $1) AND ($2::text IS NULL OR subject_id = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [filter.subjectType ?? null, filter.subjectId ?? null, Math.min(Math.max(filter.limit ?? DEFAULT_LIST, 1), MAX_LIST)],
  );
  return rows.map(toJob);
}

export async function acknowledgeAgentJob(db: Pool, id: string): Promise<void> {
  await db.query(`UPDATE agent_jobs SET acknowledged_at = COALESCE(acknowledged_at, NOW()) WHERE id = $1`, [id]);
}

interface HandOffRequest {
  specialist: string;
  subjectId: string;
  input?: Record<string, unknown>;
  conversationId?: string | null;
  requestedBy: 'app' | 'chat';
  /** The user agreed to the plan, including anything it overwrites. */
  confirmed?: boolean;
}

/** Hands work to a specialist. Queues prerequisites first and wakes the worker. */
export async function handOff(db: Pool, request: HandOffRequest): Promise<HandOffResult> {
  const specialist = getSpecialist(request.specialist);
  if (!specialist) throw new ValidationError(`There is no specialist called ${request.specialist}.`);
  const subject = await specialist.resolveSubject(db, request.subjectId);
  const input = specialist.parseInput ? specialist.parseInput(request.input ?? {}) : request.input ?? {};
  const prerequisites: Prerequisite[] = specialist.prerequisites ? await specialist.prerequisites(db, subject.id, input) : [];
  const overwrites = specialist.overwrites ? await specialist.overwrites(db, subject.id, input) : false;
  const plan: PlannedStep[] = [
    ...prerequisites.map((step) => ({
      specialist: step.specialist,
      specialistName: getSpecialist(step.specialist)?.name ?? step.specialist,
      reason: step.reason,
      overwrites: step.overwrites,
    })),
    { specialist: specialist.id, specialistName: specialist.name, reason: specialist.description, overwrites },
  ];

  const client = await db.connect();
  const created: JobRow[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-subject:${specialist.subjectType}:${subject.id}`]);
    const { rows: active } = await client.query<JobRow>(
      `SELECT * FROM agent_jobs WHERE subject_type = $1 AND subject_id = $2 AND status = ANY($3)
        AND assignment_id IS NULL ORDER BY created_at`,
      [specialist.subjectType, subject.id, ACTIVE],
    );
    const same = active.find((row) => row.specialist === specialist.id && !row.is_step)
      ?? active.find((row) => row.specialist === specialist.id);
    if (same) {
      const previousInput = specialist.parseInput ? specialist.parseInput(same.input) : same.input;
      if (contentSignature(previousInput) !== contentSignature(input)) {
        throw new ConflictError('This specialist is already working on a different request for this subject.', 'AGENT_SUBJECT_BUSY');
      }
      await client.query('COMMIT');
      return { status: 'already_running', job: toJob(same) };
    }
    if (active[0]) {
      const busy = getSpecialist(active[0].specialist)?.name ?? 'Another specialist';
      throw new ConflictError(`${busy} is already working on ${subject.title || 'this'}. Try again when it finishes.`, 'AGENT_SUBJECT_BUSY');
    }
    const assignment = await client.query(
      `SELECT id FROM agent_assignments WHERE subject_type=$1 AND subject_id=$2 AND status IN ('queued','running','waiting')`,
      [specialist.subjectType, subject.id],
    );
    if (assignment.rowCount) throw new ConflictError('An Athena assignment already owns this subject.', 'AGENT_SUBJECT_BUSY');

    if (!request.confirmed && plan.some((step) => step.overwrites)) {
      const replaced = plan.filter((step) => step.overwrites).map((step) => `${step.specialistName}: ${step.reason}`);
      await client.query('COMMIT');
      return { status: 'needs_confirmation', plan, message: `This replaces existing work. ${replaced.join(' ')}` };
    }

    const pool = workerPool();
    let previous: string | null = null;
    for (const step of prerequisites) {
      const stepSpecialist = getSpecialist(step.specialist);
      if (!stepSpecialist) throw new Error(`Unregistered prerequisite specialist ${step.specialist}`);
      const row = await insertJob(client, {
        specialist: step.specialist, subjectType: stepSpecialist.subjectType, subject, input: step.input,
        dependsOn: previous, isStep: true, request, pool,
      });
      created.push(row);
      previous = row.id;
    }
    created.push(await insertJob(client, {
      specialist: specialist.id, subjectType: specialist.subjectType, subject, input, dependsOn: previous, isStep: false, request, pool,
    }));
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { console.error('[agents] Handoff rollback failed:', rollbackError); }
    throw error;
  } finally {
    client.release();
  }
  const jobs = created.map(emit);
  wakeWorker();
  return { status: 'queued', job: jobs[jobs.length - 1]!, steps: jobs.slice(0, -1) };
}

async function insertJob(client: PoolClient, job: {
  specialist: string; subjectType: string; subject: { id: string; title: string; url: string };
  input: Record<string, unknown>; dependsOn: string | null; isStep: boolean; request: HandOffRequest; pool: string;
}): Promise<JobRow> {
  const { rows } = await client.query<JobRow>(
    `INSERT INTO agent_jobs (id, specialist, subject_type, subject_id, subject_title, subject_url, input,
       depends_on, is_step, conversation_id, requested_by, worker_pool, protocol_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 2) RETURNING *`,
    [randomUUID(), job.specialist, job.subjectType, job.subject.id, job.subject.title, job.subject.url,
      JSON.stringify(job.input), job.dependsOn, job.isStep, job.request.conversationId ?? null, job.request.requestedBy, job.pool],
  );
  return rows[0]!;
}

// ── Worker ───────────────────────────────────────────────────────────────────

let workerDb: Pool | null = null;
let timer: NodeJS.Timeout | null = null;
let running = 0;
let draining = false;
let filling: Promise<void> | undefined;
let shutdown = new AbortController();
let workerOwner = randomUUID();
const inFlight = new Set<Promise<void>>();

function wakeWorker(): void {
  if (!workerDb || draining || filling) return;
  filling = fill().finally(() => { filling = undefined; });
}

async function fill(): Promise<void> {
  const db = workerDb;
  if (!db || draining) return;
  try {
    await recoverExpiredJobs(db);
    await recoverConfiguredAssignments(db, workerPool());
    try { await deliverAssignmentNotices(db, workerPool()); }
    catch (error) {
      console.error('[workforce] Chat notice delivery failed; pending events will be retried without stopping job execution:', error);
    }
    await failBlockedJobs(db);
    while (running < CONCURRENCY && !shutdown.signal.aborted) {
      const row = await claim(db);
      const assignment = row ? null : await claimConfiguredAssignment(db, workerPool(), workerOwner, shutdown.signal);
      if (!row && !assignment) break;
      running += 1;
      let execution: Promise<void>;
      if (row) execution = runJob(db, row, workerOwner);
      else if (assignment) execution = runConfiguredAssignment(db, assignment, completion => { agentJobEvents.emit('assignment', completion.assignment.id); });
      else break;
      const work = execution.catch((error: unknown) => {
        // An unrecorded result is recoverable only after this owner's lease expires.
        console.error(`[agents] Job ${row?.id ?? assignment?.identity.jobId} could not record its outcome:`, error);
      }).finally(() => {
        running -= 1;
        inFlight.delete(work);
        wakeWorker();
      });
      inFlight.add(work);
    }
  } catch (error) {
    console.error('[agents] Worker could not claim jobs:', error);
  }
}

async function claim(db: Pool): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE agent_jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1, updated_at = NOW(),
        lease_owner=$2,lease_until=clock_timestamp()+$3*INTERVAL '1 millisecond',protocol_version=$4
      WHERE id = (
        SELECT j.id FROM agent_jobs j LEFT JOIN agent_jobs d ON d.id = j.depends_on
         WHERE j.worker_pool = $1 AND j.status = 'queued' AND j.protocol_version<=$4 AND j.assignment_id IS NULL
           AND (j.depends_on IS NULL OR d.status = 'done')
         ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
      RETURNING *`,
    [workerPool(), workerOwner, AGENT_LEASE_MS, AGENT_PROTOCOL_VERSION],
  );
  if (!rows[0]) return null;
  emit(rows[0]);
  return rows[0];
}

async function recoverExpiredJobs(db: Pool): Promise<void> {
  const failed = await db.query<JobRow>(
    `UPDATE agent_jobs SET status='failed',finished_at=clock_timestamp(),updated_at=clock_timestamp(),
      lease_owner=NULL,lease_until=NULL,error='It was interrupted too many times and stopped.'
      WHERE worker_pool=$1 AND assignment_id IS NULL AND protocol_version<=$3 AND status='running'
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND attempts>=$2 RETURNING *`,
    [workerPool(), AGENT_MAX_ATTEMPTS, AGENT_PROTOCOL_VERSION],
  );
  for (const row of failed.rows) await finish(db, row);
  const recovered = await db.query<JobRow>(
    `UPDATE agent_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE worker_pool=$1 AND assignment_id IS NULL AND protocol_version<=$2 AND status='running'
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *`,
    [workerPool(), AGENT_PROTOCOL_VERSION],
  );
  for (const row of recovered.rows) emit(row);
}

/** Fails jobs whose prerequisite failed, so a handoff never waits forever. */
async function failBlockedJobs(db: Pool): Promise<void> {
  const { rows } = await db.query<JobRow & { blocker: string; blocker_error: string | null }>(
    `UPDATE agent_jobs j SET status = 'failed', finished_at = NOW(), updated_at = NOW(), error = 'An earlier step did not finish.'
       FROM agent_jobs d
      WHERE d.id = j.depends_on AND j.status = 'queued' AND d.status = 'failed' AND j.worker_pool = $1
        AND j.assignment_id IS NULL AND d.assignment_id IS NULL AND j.protocol_version <= $2
      RETURNING j.*, d.specialist AS blocker, d.error AS blocker_error`,
    [workerPool(), AGENT_PROTOCOL_VERSION],
  );
  for (const row of rows) {
    const name = getSpecialist(row.blocker)?.name ?? 'An earlier step';
    const message = `It could not start because ${name} did not finish. ${row.blocker_error ?? ''}`.trim();
    const { rows: updated } = await db.query<JobRow>(`UPDATE agent_jobs SET error = $2 WHERE id = $1 RETURNING *`, [row.id, message]);
    await finish(db, updated[0] ?? row);
  }
}

const RECORD_ATTEMPTS = 4;
const RECORD_BACKOFF_MS = 2_000;

/** Writes a job's outcome, retrying briefly so a database blip doesn't lose finished work. */
async function record(db: Pool, sql: string, params: unknown[]): Promise<JobRow | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { rows } = await db.query<JobRow>(sql, params);
      return rows[0];
    } catch (error) {
      if (attempt >= RECORD_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, RECORD_BACKOFF_MS * attempt));
    }
  }
}

async function runJob(db: Pool, row: JobRow, owner: string): Promise<void> {
  const specialist = getSpecialist(row.specialist);
  const lease = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, lease.signal]);
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || signal.aborted) return;
    renewing = true;
    void db.query(
      `UPDATE agent_jobs SET lease_until=clock_timestamp()+$4*INTERVAL '1 millisecond'
        WHERE id=$1 AND attempts=$2 AND lease_owner=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING id`,
      [row.id, row.attempts, owner, AGENT_LEASE_MS],
    ).then(result => {
      if (!result.rowCount) lease.abort(new ConflictError('The specialist lost ownership of this attempt.', 'AGENT_ATTEMPT_CONFLICT'));
    }).catch((error: unknown) => {
      console.error('[agents] Lease renewal failed; stopping this attempt:', row.id, error);
      lease.abort(new ConflictError('The specialist could not renew its ownership lease.', 'AGENT_ATTEMPT_CONFLICT'));
    }).finally(() => { renewing = false; });
  }, AGENT_HEARTBEAT_MS);
  heartbeat.unref();
  let writes = Promise.resolve();
  const progress = (message: string): void => {
    const text = message.trim().slice(0, MAX_PROGRESS_CHARS);
    if (!text || signal.aborted) return;
    writes = writes.then(async () => {
      const { rows } = await db.query<JobRow>(
        `UPDATE agent_jobs SET updated_at = NOW(),
                progress = (SELECT COALESCE(jsonb_agg(value ORDER BY n), '[]'::jsonb) FROM (
                  SELECT value, n FROM jsonb_array_elements(progress || jsonb_build_array($2::text)) WITH ORDINALITY AS p(value, n)
                   ORDER BY n DESC LIMIT ${MAX_PROGRESS}) recent)
          WHERE id = $1 AND status = 'running' AND attempts = $3 AND lease_owner=$4
            AND lease_until>clock_timestamp() RETURNING *`,
        [row.id, text, row.attempts, owner],
      );
      if (rows[0]) emit(rows[0]);
    }).catch((error: unknown) => { console.error('[agents] Could not save progress:', error); });
  };
  try {
    if (!specialist) throw new ValidationError(`The ${row.specialist} specialist is not available on this server.`);
    const done = await withAgentAttempt({ jobId: row.id, attempt: row.attempts, owner, assignmentId: row.assignment_id, signal, budgetDb: db },
      () => withAiWorkflow(db, { feature: row.specialist, jobId: row.id, attempt: row.attempts, signal }, async () => {
        signal.throwIfAborted();
        const outcome = await specialist.run({ db, jobId: row.id, attempt: row.attempts, subjectId: row.subject_id, input: row.input, progress, signal });
        await writes;
        signal.throwIfAborted();
        const saved = await record(db,
          `UPDATE agent_jobs SET status = 'done', result = $2, error = NULL, finished_at = NOW(), updated_at = NOW(),lease_until=NULL,lease_owner=NULL
            WHERE id = $1 AND status = 'running' AND attempts = $3 AND lease_owner=$4 AND lease_until>clock_timestamp() RETURNING *`,
          [row.id, JSON.stringify({ data: outcome.data, summary: outcome.summary }), row.attempts, owner],
        );
        if (!saved) throw new ConflictError('The specialist attempt stopped before its outcome was saved.', 'AGENT_ATTEMPT_CONFLICT');
        return saved;
      }));
    if (done) await finish(db, done);
  } catch (error) {
    await writes;
    if (shutdown.signal.aborted) {
      await record(db, `UPDATE agent_jobs SET status = 'queued', updated_at = NOW(),lease_owner=NULL,lease_until=NULL
        WHERE id = $1 AND status = 'running' AND attempts = $2 AND lease_owner=$3 AND lease_until>clock_timestamp() RETURNING *`, [row.id, row.attempts, owner]);
      return;
    }
    if (lease.signal.aborted) return;
    const message = error instanceof KnowledgeHubError ? error.message : 'The specialist hit an unexpected error.';
    if (!(error instanceof KnowledgeHubError)) console.error(`[agents] ${row.specialist} job ${row.id} failed:`, error);
    const failed = await record(db,
      `UPDATE agent_jobs SET status = 'failed', error = $2, finished_at = NOW(), updated_at = NOW(),lease_owner=NULL,lease_until=NULL
        WHERE id = $1 AND status = 'running' AND attempts = $3 AND lease_owner=$4 AND lease_until>clock_timestamp() RETURNING *`,
      [row.id, message, row.attempts, owner],
    );
    if (failed) await finish(db, failed);
  } finally { clearInterval(heartbeat); }
}

/** Publishes the outcome and, for the last job of a chat handoff, has Athena report back in that chat. */
async function finish(db: Pool, row: JobRow): Promise<void> {
  const job = toJob(row);
  if (row.conversation_id && row.requested_by === 'chat' && (!row.is_step || row.status === 'failed')) {
    const data = row.result?.['data'];
    const resultUrl = data && typeof data === 'object' && 'url' in data && typeof data.url === 'string' ? data.url : row.subject_url;
    const link = resultUrl ? `[${row.subject_title || 'Open it'}](${resultUrl})` : row.subject_title;
    const text = row.status === 'done'
      ? `${job.specialistName} has finished${link ? ` on ${link}` : ''}. ${job.summary ?? ''}`.trim()
      : `${job.specialistName} could not finish${link ? ` on ${link}` : ''}. ${row.error ?? ''}`.trim();
    try {
      await appendAssistantMessage(db, row.conversation_id, text);
    } catch (error) {
      console.error('[agents] Could not post the job outcome to the chat:', error);
    }
  }
  if (row.status === 'failed') wakeWorker();
  agentJobEvents.emit('job', job);
}

/** Starts this worker without stealing another process's unexpired jobs. */
export function startAgentWorker(db: Pool): Promise<void> {
  if (workerDb) return Promise.reject(new ConflictError('The specialist worker is already started.', 'AGENT_WORKER_STARTED'));
  workerDb = db;
  draining = false;
  shutdown = new AbortController();
  workerOwner = randomUUID();
  const pool = workerPool();
  timer = setInterval(wakeWorker, POLL_MS);
  timer.unref();
  console.warn(`[agents] Specialist worker started for pool ${pool}.`);
  wakeWorker();
  return Promise.resolve();
}

/** Stops claiming work; running jobs are returned to the queue for the next start. */
export async function stopAgentWorker(): Promise<void> {
  draining = true;
  if (timer) clearInterval(timer);
  timer = null;
  shutdown.abort();
  await filling;
  await Promise.allSettled([...inFlight]);
  workerDb = null;
}
