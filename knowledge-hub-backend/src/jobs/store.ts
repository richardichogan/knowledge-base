import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError as BaseConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { parseJob, readyToEnable, type JobRun, type ManagedJob } from './contracts.js';
import { nextOccurrence, occurrences, JOB_LOOKAHEAD_DAYS } from './schedule.js';
import { MS_PER_DAY } from '../config/constants.js';

type Db = Pool | PoolClient;
class ConflictError extends BaseConflictError {
  constructor(message: string) { super(message, 'JOB_CONFLICT'); }
}
const jobColumns = `id, revision, enabled, archived, definition, next_at AS "nextAt", updated_at AS "updatedAt"`;
export const runColumns = `id, job_id AS "jobId", revision, definition, scheduled_at AS "scheduledAt", deadline,
 status, preview, steps, artifacts, approved_at AS "approvedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
export async function audit(db: Db, jobId: string | null, runId: string | null, actor: string, event: string, detail: unknown = {}): Promise<void> {
  await db.query('INSERT INTO managed_job_events(job_id,run_id,actor,event,detail) VALUES($1,$2,$3,$4,$5)', [jobId, runId, actor, event, JSON.stringify(detail)]);
}
export async function listJobs(db: Db): Promise<ManagedJob[]> {
  return (await db.query<ManagedJob>(`SELECT ${jobColumns} FROM managed_jobs WHERE NOT archived ORDER BY definition->>'name'`)).rows;
}
export async function getJob(db: Db, id: string): Promise<ManagedJob> {
  const job = (await db.query<ManagedJob>(`SELECT ${jobColumns} FROM managed_jobs WHERE id=$1`, [id])).rows[0];
  if (!job) throw new NotFoundError('Job');
  return job;
}
export async function getRun(db: Db, id: string): Promise<JobRun> {
  const run = (await db.query<JobRun>(`SELECT ${runColumns} FROM managed_job_runs WHERE id=$1`, [id])).rows[0];
  if (!run) throw new NotFoundError('Job run');
  return run;
}
export async function saveJob(db: Pool, id: string | undefined, revision: number, value: unknown, enabled: boolean, actor: string): Promise<ManagedJob> {
  const definition = parseJob(value);
  if (enabled) readyToEnable(definition);
  if (enabled && (definition.kind === 'm365-import' || definition.outputs.includes('file'))) {
    const device = (await db.query<{ folders: Array<{ path: string }> }>('SELECT folders FROM managed_job_devices WHERE id=$1', [definition.deviceId])).rows[0];
    const paths = device?.folders.map(f => f.path) ?? [];
    if ((definition.kind === 'm365-import' && !paths.includes(definition.inputFolder))
      || (definition.outputs.includes('file') && !paths.includes(definition.outputFolder))) {
      throw new ValidationError('Select folders already authorised on the registered desktop. Grant new folders in Athena Desktop first.');
    }
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const nextAt = enabled ? nextOccurrence(definition.schedule, new Date()) : null;
    const jobId = id ?? randomUUID();
    const result = id
      ? await client.query(`UPDATE managed_jobs SET definition=$3, enabled=$4, revision=revision+1, next_at=$5, updated_at=NOW()
          WHERE id=$1 AND revision=$2 AND NOT archived RETURNING id`, [id, revision, JSON.stringify(definition), enabled, nextAt])
      : await client.query('INSERT INTO managed_jobs(id,definition,enabled,next_at) VALUES($1,$2,$3,$4) RETURNING id', [jobId, JSON.stringify(definition), enabled, nextAt]);
    if (!result.rows.length) throw new ConflictError('The job changed. Reload its current revision.');
    const job = await getJob(client, jobId);
    await client.query('INSERT INTO managed_job_revisions(job_id,revision,definition) VALUES($1,$2,$3)', [jobId, job.revision, JSON.stringify(definition)]);
    if (enabled && definition.kind === 'm365-import') await client.query('UPDATE managed_job_devices SET managed_import=TRUE WHERE id=$1', [definition.deviceId]);
    // Already generated artifacts belong to the old revision, not new permissions.
    await client.query(`UPDATE managed_job_runs SET status='rejected', updated_at=NOW()
      WHERE job_id=$1 AND revision<>$2 AND status IN ('awaiting-approval','queued','waiting-device','waiting-file')`, [jobId, job.revision]);
    await audit(client, jobId, null, actor, id ? 'configuration-updated' : 'created', { revision: job.revision, definition, enabled });
    await client.query('COMMIT');
    return job;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function pauseJob(db: Pool, id: string, actor: string, archive = false): Promise<void> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await getJob(c, id);
    await c.query('UPDATE managed_jobs SET enabled=FALSE, archived=$2, next_at=NULL, updated_at=NOW() WHERE id=$1', [id, archive]);
    await audit(c, id, null, actor, archive ? 'archived' : 'paused');
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
export async function enqueue(db: Db, job: ManagedJob, at: Date, key: string, preview: boolean, actor: string): Promise<JobRun> {
  if (!preview) readyToEnable(job.definition);
  if (!preview && !job.enabled) throw new ValidationError('Enable the saved job before running it. Preview is available while paused.');
  const deadline = nextOccurrence(job.definition.schedule, at);
  const result = await db.query<JobRun>(`INSERT INTO managed_job_runs(job_id,revision,definition,scheduled_at,deadline,occurrence_key,preview)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(job_id,occurrence_key) DO UPDATE SET occurrence_key=EXCLUDED.occurrence_key RETURNING ${runColumns}`,
  [job.id, job.revision, JSON.stringify(job.definition), at, deadline, key, preview]);
  const run = result.rows[0]!;
  await audit(db, job.id, run.id, actor, preview ? 'preview-requested' : 'run-requested', { scheduledAt: at });
  return run;
}
export async function scheduleDueJobs(db: Pool, now = new Date()): Promise<void> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const jobs = await c.query<ManagedJob>(`SELECT ${jobColumns} FROM managed_jobs WHERE enabled AND NOT archived AND next_at <= $1 FOR UPDATE SKIP LOCKED`, [now]);
    for (const job of jobs.rows) {
      const due = new Date(job.nextAt!);
      // Initial migration uses NOW as a marker: never create a surprise off-schedule run.
      const slots = occurrences(job.definition.schedule, new Date(Math.max(due.getTime(), now.getTime() - JOB_LOOKAHEAD_DAYS * MS_PER_DAY)), now);
      const latest = slots[slots.length - 1];
      if (latest) {
        if (slots.length > 1 || now.getTime() - due.getTime() > JOB_LOOKAHEAD_DAYS * MS_PER_DAY) await audit(c, job.id, null, 'scheduler', 'missed-occurrences', { from: due, until: latest, countInRecentWindow: slots.length - 1 });
        const run = await enqueue(c, job, latest, latest.toISOString(), false, 'scheduler');
        if (job.definition.kind === 'weekly-microsoft') {
          const state = await c.query<{ last_cursor: string | null }>("SELECT last_cursor FROM sync_state WHERE source='weekly-microsoft-digest'");
          const stored = state.rows[0]?.last_cursor;
          if (stored) {
            const parsed: unknown = JSON.parse(stored);
            if (parsed && typeof parsed === 'object' && 'generatedAt' in parsed && typeof parsed.generatedAt === 'string'
              && new Date(parsed.generatedAt) >= latest) {
              await c.query("UPDATE managed_job_runs SET status='succeeded', artifacts=$2 WHERE id=$1", [run.id, JSON.stringify({ migrated: true, previous: parsed })]);
              await audit(c, job.id, run.id, 'migration', 'existing-digest-preserved');
            }
          }
        }
      }
      await c.query('UPDATE managed_jobs SET next_at=$2 WHERE id=$1', [job.id, nextOccurrence(job.definition.schedule, now)]);
    }
    const missed = await c.query<{ id: string; job_id: string }>(`UPDATE managed_job_runs SET status='missed', updated_at=NOW() WHERE status IN ('waiting-file','waiting-device')
      AND deadline <= $1 AND (lease_until IS NULL OR lease_until < NOW()) RETURNING id,job_id`, [now]);
    for (const run of missed.rows) await audit(c, run.job_id, run.id, 'scheduler', 'missed', { reason: 'The device or dated file was unavailable before the next occurrence.' });
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
export async function leaseRun(db: Pool, deviceId?: string, sourceWorkBusy = false): Promise<{ run: JobRun; lease: string } | null> {
  const lease = randomUUID();
  const r = await db.query<JobRun>(`UPDATE managed_job_runs r SET lease=$1, lease_until=NOW()+INTERVAL '15 minutes', updated_at=NOW()
    WHERE r.id=(SELECT q.id FROM managed_job_runs q JOIN managed_jobs j ON j.id=q.job_id
      WHERE (q.status IN ('queued','waiting-file','waiting-device') OR (q.status='running' AND q.lease_until<NOW()))
      AND (q.lease_until IS NULL OR q.lease_until<NOW()) AND NOT j.archived
      AND (q.preview OR j.enabled)
      AND q.revision=j.revision
      ${!deviceId && sourceWorkBusy ? "AND q.definition->>'kind' NOT IN ('content-sync','weekly-microsoft')" : ''}
      AND pg_try_advisory_xact_lock(hashtext(q.job_id::text))
      AND ${deviceId ? "q.definition->>'deviceId'=$2 AND q.status IN ('waiting-file','waiting-device') AND q.deadline>NOW()" : "(q.status <> 'waiting-device' AND q.status <> 'waiting-file')"}
      AND NOT EXISTS(SELECT 1 FROM managed_job_runs other WHERE other.job_id=q.job_id AND other.id<>q.id AND other.lease_until>NOW())
      ORDER BY q.created_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
    RETURNING ${runColumns}`, deviceId ? [lease, deviceId] : [lease]);
  return r.rows[0] ? { run: r.rows[0], lease } : null;
}
export async function persistRun(db: Pool, run: JobRun, lease: string): Promise<void> {
  const r = await db.query(`UPDATE managed_job_runs SET status=$3,steps=$4,artifacts=$5,updated_at=NOW()
    WHERE id=$1 AND lease=$2 AND lease_until>NOW()`, [run.id, lease, run.status, JSON.stringify(run.steps), JSON.stringify(run.artifacts)]);
  if (!r.rowCount) throw new ConflictError('The run lease expired. No further action is permitted.');
}
export async function releaseRun(db: Pool, id: string, lease: string): Promise<void> {
  await db.query('UPDATE managed_job_runs SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2', [id, lease]);
}
export async function decideRun(db: Pool, id: string, approve: boolean, actor: string): Promise<void> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const run = await getRun(c, id);
    const job = await getJob(c, run.jobId);
    if (run.status !== 'awaiting-approval' || job.revision !== run.revision || !job.enabled) throw new ConflictError('Approval is no longer current or the job is paused.');
    const r = await c.query(`UPDATE managed_job_runs SET approved_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
      status=CASE WHEN $2 THEN 'queued' ELSE 'rejected' END,updated_at=NOW() WHERE id=$1 AND status='awaiting-approval' RETURNING id`, [id, approve]);
    if (!r.rowCount) throw new ConflictError('This decision was already handled.');
    await audit(c, run.jobId, id, actor, approve ? 'approved' : 'rejected', { revision: run.revision });
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
export async function retryRun(db: Pool, id: string, actor: string): Promise<void> {
  const run = await getRun(db, id);
  const job = await getJob(db, run.jobId);
  if (!job.enabled || job.archived || job.revision !== run.revision) throw new ValidationError('Enable the unchanged job before retrying; changed configurations need a new run.');
  if (!['failed', 'partial'].includes(run.status)) throw new ValidationError('Only definitively failed runs can be retried. Reconcile unconfirmed external delivery first.');
  const r = await db.query(`UPDATE managed_job_runs SET status='queued',steps=$2,updated_at=NOW()
    WHERE id=$1 AND status IN ('failed','partial') AND (lease_until IS NULL OR lease_until<NOW()) RETURNING id`,
  [id, JSON.stringify(run.steps.filter(s => s.status === 'succeeded' || s.status === 'unconfirmed'))]);
  if (!r.rowCount) throw new ConflictError('This run changed.');
  await db.query("UPDATE publishing_deliveries SET next_attempt_at=NOW() WHERE identity IN ($1,$2) AND status='failed'", [`jobs:${id}:bluesky`, `jobs:${id}:linkedin`]);
  await audit(db, run.jobId, id, actor, 'retry-requested');
}
export async function proposeJob(db: Pool, sessionId: string, payload: unknown): Promise<unknown> {
  const result = await db.query<Record<string, unknown>>('INSERT INTO managed_job_proposals(session_id,payload) VALUES($1,$2) RETURNING id,payload,created_at', [sessionId, JSON.stringify(payload)]);
  return { confirmationRequired: true, proposal: result.rows[0], message: 'Review the job confirmation card in this chat. Nothing is enabled or published until confirmed.' };
}
