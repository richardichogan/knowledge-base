import { Router, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { getDb as defaultGetDb } from '../db/db.js';
import type { Pool } from 'pg';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { ConflictError, ValidationError } from '../types/errors.js';
import { env } from '../config/env.js';
import { object, parseJob, text, JOB_LIMITS } from '../jobs/contracts.js';
import { audit, decideRun, enqueue, getJob, getRun, leaseRun, listJobs, pauseJob, persistRun, releaseRun, retryRun, runColumns, saveJob } from '../jobs/store.js';
import { localClock, nextOccurrence } from '../jobs/schedule.js';
import { captureDailyInsights } from '../services/dailyInsights.js';

export function createJobsRouter(getDb: () => Pool = defaultGetDb): Router {
const jobsRouter = Router();
const route = (action: (req: Parameters<RequestHandler>[0]) => unknown): RequestHandler => (req, res, next) => {
  void Promise.resolve().then(() => action(req)).then(data => res.json({ success: true, data })).catch(next);
};
const actor = (req: Parameters<RequestHandler>[0]): string => (req as AuthenticatedRequest).userId;
function revision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new ValidationError('A current job revision is required.');
  return Number(value);
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new ValidationError('Invalid ID.');
  return value;
}
const paging = (v: unknown): number => {
  const n = Number(v ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > JOB_LIMITS.historyOffset) throw new ValidationError('Invalid history offset.');
  return n;
};
function production(): void {
  if (env.NODE_ENV !== 'production') throw new ValidationError('Managed job execution is disabled on development servers. Use isolated tests or the production Jobs screen.');
}

jobsRouter.get('/', route(() => listJobs(getDb())));
jobsRouter.get('/devices', route(async () => (await getDb().query<Record<string, unknown>>('SELECT id,name,folders,seen_at AS "seenAt" FROM managed_job_devices ORDER BY name')).rows));
jobsRouter.get('/proposals', route(async req => {
  const session = text(req.query.sessionId ?? '', 'chat session');
  if (!session) return [];
  return (await getDb().query<Record<string, unknown>>(`SELECT id,payload,created_at AS "createdAt" FROM managed_job_proposals
    WHERE session_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 10`, [session])).rows;
}));
jobsRouter.post('/proposals/:id/confirm', route(async req => {
  production();
  const id = uuid(req.params.id);
  const db = getDb();
  const proposed = await db.query<{ payload: Record<string, unknown> }>("UPDATE managed_job_proposals SET status='confirming' WHERE id=$1 AND status='pending' RETURNING payload", [id]);
  const p = proposed.rows[0]?.payload;
  if (!p) throw new ConflictError('Proposal already handled.', 'JOB_CONFLICT');
  try {
    let result: unknown;
    if (p.operation === 'save') result = await saveJob(db, p.id ? uuid(p.id) : undefined, p.id ? revision(p.revision) : 0, p.definition, p.enabled === true, `chat:${actor(req)}`);
    else if (p.operation === 'approve') { await decideRun(db, uuid(p.runId), true, `chat:${actor(req)}`); result = await getRun(db, uuid(p.runId)); }
    else if (p.operation === 'run') {
      const job = await getJob(db, uuid(p.id));
      if (job.revision !== p.revision) throw new ConflictError('Job changed; request a new run confirmation.', 'JOB_CONFLICT');
      result = await enqueue(db, job, new Date(), `manual:${randomUUID()}`, p.preview === true, `chat:${actor(req)}`);
    }
    else throw new ValidationError('Unknown proposal operation.');
    await db.query("UPDATE managed_job_proposals SET status='confirmed' WHERE id=$1", [id]);
    return result;
  } catch (error) {
    await db.query("UPDATE managed_job_proposals SET status='failed' WHERE id=$1", [id]);
    throw error;
  }
}));
jobsRouter.post('/proposals/:id/reject', route(async req => {
  await getDb().query("UPDATE managed_job_proposals SET status='rejected' WHERE id=$1 AND status='pending'", [uuid(req.params.id)]);
  return { rejected: true };
}));
jobsRouter.post('/', route(req => {
  production();
  const b = object(req.body);
  return saveJob(getDb(), undefined, 0, b.definition, b.enabled === true, actor(req));
}));
jobsRouter.put('/:id', route(req => {
  production();
  const b = object(req.body);
  return saveJob(getDb(), uuid(req.params.id), revision(b.revision), b.definition, b.enabled === true, actor(req));
}));
jobsRouter.post('/:id/pause', route(async req => { production(); await pauseJob(getDb(), uuid(req.params.id), actor(req)); return { paused: true }; }));
jobsRouter.post('/:id/archive', route(async req => { production(); await pauseJob(getDb(), uuid(req.params.id), actor(req), true); return { archived: true }; }));
jobsRouter.post('/:id/run', route(async req => {
  production();
  const job = await getJob(getDb(), uuid(req.params.id));
  return enqueue(getDb(), job, new Date(), `manual:${randomUUID()}`, object(req.body).preview === true, actor(req));
}));
jobsRouter.post('/schedule-preview', route(req => {
  const d = parseJob(object(req.body).definition);
  let at = new Date();
  return Array.from({ length: 5 }, () => { at = nextOccurrence(d.schedule, at); return at.toISOString(); });
}));
jobsRouter.get('/runs', route(async req => {
  const values: unknown[] = [];
  const where: string[] = [];
  if (req.query.jobId) { values.push(uuid(req.query.jobId)); where.push(`job_id=$${values.length}`); }
  if (req.query.status) { values.push(text(req.query.status, 'status', JOB_LIMITS.status)); where.push(`status=$${values.length}`); }
  if (req.query.from) {
    const from = text(req.query.from, 'from date', JOB_LIMITS.dateInput);
    if (!Number.isFinite(Date.parse(from))) throw new ValidationError('Invalid history date.');
    values.push(from); where.push(`created_at >= $${values.length}::timestamptz`);
  }
  values.push(paging(req.query.offset));
  return (await getDb().query<Record<string, unknown>>(`SELECT ${runColumns} FROM managed_job_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT 25 OFFSET $${values.length}`, values)).rows;
}));
jobsRouter.get('/runs/:runId', route(req => getRun(getDb(), uuid(req.params.runId))));
jobsRouter.post('/runs/:runId/decision', route(async req => {
  production();
  const b = object(req.body);
  if (typeof b.approve !== 'boolean') throw new ValidationError('Choose approve or reject.');
  await decideRun(getDb(), uuid(req.params.runId), b.approve, actor(req));
  return getRun(getDb(), uuid(req.params.runId));
}));
jobsRouter.post('/runs/:runId/retry', route(async req => {
  production(); await retryRun(getDb(), uuid(req.params.runId), actor(req)); return { queued: true };
}));
jobsRouter.post('/runs/:runId/reconcile', route(async req => {
  production();
  const db = getDb();
  const run = await getRun(db, uuid(req.params.runId));
  const b = object(req.body);
  const key = text(b.step, 'step', JOB_LIMITS.status);
  const item = run.steps.find(s => s.key === key && (s.status === 'unconfirmed' || s.status === 'running'));
  if (run.status !== 'unconfirmed' || !item) throw new ValidationError('Choose an unconfirmed step.');
  if (typeof b.delivered !== 'boolean') throw new ValidationError('Confirm whether delivery occurred.');
  let result: unknown = { manuallyConfirmed: true };
  if (b.delivered && key === 'blog') {
    const url = new URL(text(b.url, 'published URL'));
    if (url.protocol !== 'https:' || url.username || url.password) throw new ValidationError('Provide the confirmed public HTTPS blog URL.');
    result = { url: url.href, status: 'published' };
  } else if (b.delivered && (key === 'linkedin' || key === 'bluesky')) {
    const url = new URL(text(b.url, 'published post URL'));
    if (url.protocol !== 'https:' || url.username || url.password) throw new ValidationError('Provide a public post URL.');
    result = { url: url.href, manuallyConfirmed: true };
  }
  item.status = b.delivered ? 'succeeded' : 'failed';
  item.result = result;
  item.finishedAt = new Date().toISOString();
  const status = run.steps.some(s => s.status === 'unconfirmed') ? 'unconfirmed' : 'partial';
  const changed = await db.query(`UPDATE managed_job_runs SET status=$3,steps=$2,updated_at=NOW()
    WHERE id=$1 AND status='unconfirmed' AND updated_at=$4 AND (lease_until IS NULL OR lease_until<NOW()) RETURNING id`,
  [run.id, JSON.stringify(run.steps), status, run.updatedAt]);
  if (!changed.rowCount) throw new ConflictError('Run changed; reload before reconciling.', 'JOB_CONFLICT');
  await audit(db, run.jobId, run.id, actor(req), 'delivery-reconciled', { step: key, delivered: b.delivered, result });
  return getRun(db, run.id);
}));
jobsRouter.get('/audit', route(async req => {
  const jobId = req.query.jobId ? uuid(req.query.jobId) : null;
  const from = req.query.from ? text(req.query.from, 'from date', JOB_LIMITS.dateInput) : null;
  if (from && !Number.isFinite(Date.parse(from))) throw new ValidationError('Invalid audit date.');
  const event = req.query.status ? text(req.query.status, 'event status', JOB_LIMITS.status) : null;
  return (await getDb().query<Record<string, unknown>>(`SELECT id,job_id AS "jobId",run_id AS "runId",actor,event,detail,created_at AS "createdAt"
    FROM managed_job_events WHERE ($1::uuid IS NULL OR job_id=$1) AND ($3::timestamptz IS NULL OR created_at >= $3)
      AND ($4::text IS NULL OR event=$4) ORDER BY id DESC LIMIT 50 OFFSET $2`, [jobId, paging(req.query.offset), from, event])).rows;
}));

jobsRouter.post('/desktop/claim', route(async req => {
  production();
  const b = object(req.body);
  const deviceId = text(b.deviceId, 'device ID', JOB_LIMITS.name);
  const name = text(b.deviceName, 'device name', JOB_LIMITS.name);
  if (!deviceId || !Array.isArray(b.folders) || b.folders.length > JOB_LIMITS.folderCount) throw new ValidationError('Invalid device registration.');
  const folders = b.folders.map(f => { const folder = object(f); return { id: text(folder.id, 'folder ID'), path: text(folder.path, 'folder path'), name: text(folder.name, 'folder name') }; });
  await getDb().query(`INSERT INTO managed_job_devices(id,name,folders) VALUES($1,$2,$3)
    ON CONFLICT(id) DO UPDATE SET name=$2,folders=$3,seen_at=NOW()`, [deviceId, name, JSON.stringify(folders)]);
  const managed = await getDb().query<{ managed_import: boolean }>('SELECT managed_import FROM managed_job_devices WHERE id=$1', [deviceId]);
  const claimed = await leaseRun(getDb(), deviceId);
  return { managedImport: managed.rows[0]?.managed_import === true, work: claimed };
}));
jobsRouter.post('/desktop/:runId/result', route(async req => {
  production();
  const db = getDb();
  const b = object(req.body);
  const id = uuid(req.params.runId);
  const lease = uuid(b.lease);
  const deviceId = text(b.deviceId, 'device ID');
  const check = await db.query(`UPDATE managed_job_runs SET status='running' WHERE id=$1 AND lease=$2 AND lease_until>NOW()
    AND definition->>'deviceId'=$3 AND status IN ('waiting-file','waiting-device') RETURNING id`, [id, lease, deviceId]);
  if (!check.rows.length) throw new ConflictError('Device lease expired.', 'JOB_CONFLICT');
  const run = await getRun(db, id);
  const job = await getJob(db, run.jobId);
  if (!job.enabled || job.revision !== run.revision || new Date(run.deadline).getTime() <= Date.now()) {
    run.status = 'rejected';
    run.artifacts.error = 'The desktop result arrived after the job changed, paused or expired. Review any local file output before running again.';
    await persistRun(db, run, lease);
    await audit(db, run.jobId, id, `device:${deviceId}`, 'desktop-result-rejected', { reason: run.artifacts.error });
    await releaseRun(db, id, lease);
    throw new ConflictError('Job paused, changed or its occurrence expired.', 'JOB_CONFLICT');
  }
  try {
    if (b.error) {
      run.status = 'failed'; run.artifacts.error = text(b.error, 'device error', JOB_LIMITS.deviceError);
    } else if (b.waiting === true) {
      run.status = run.definition.kind === 'm365-import' ? 'waiting-file' : 'waiting-device';
    } else if (run.definition.kind === 'm365-import') {
      const expected = `Daily-Briefing-${localClock(new Date(run.scheduledAt), run.definition.schedule.timezone).day}.md`;
      const filename = text(b.filename, 'report filename');
      if (filename.toLowerCase() !== expected.toLowerCase()) throw new ValidationError('The report does not match this scheduled occurrence.');
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > JOB_LIMITS.report) throw new ValidationError('Provide the Markdown report, up to 250,000 characters.');
      const report = b.text;
      const modifiedAt = text(b.modifiedAt, 'file modified time');
      if (!Number.isFinite(Date.parse(modifiedAt))) throw new ValidationError('Invalid file timestamp.');
      const result = await captureDailyInsights(db, filename, report, `${run.definition.inputFolder}/${filename}`, modifiedAt);
      run.artifacts.capture = result; run.status = 'succeeded';
    } else {
      const path = text(b.path, 'output file');
      const normal = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (normal(path) !== normal(`${run.definition.outputFolder}/athena-${run.id}.md`)) throw new ValidationError('Unexpected output path.');
      run.artifacts.file = { path, deviceId }; run.status = 'succeeded';
    }
    await persistRun(db, run, lease);
    if (b.waiting !== true) await audit(db, run.jobId, id, `device:${deviceId}`, run.status, { result: run.artifacts.capture ?? run.artifacts.file ?? run.artifacts.error });
    return { status: run.status };
  } catch (error) {
    run.status = 'failed';
    run.artifacts.error = error instanceof Error ? error.message : 'Desktop processing failed.';
    await persistRun(db, run, lease);
    await audit(db, run.jobId, id, `device:${deviceId}`, 'failed', { error: run.artifacts.error });
    throw error;
  } finally { await releaseRun(db, id, lease); }
}));
return jobsRouter;
}
export const jobsRouter = createJobsRouter();
