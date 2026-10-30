/**
 * routes/agentJobs.ts — hand work to a specialist and follow it live.
 *
 * GET /stream sends every live job, then pushes each change. It also rechecks
 * the database every few seconds so jobs run by another server (production and
 * local development share a database) still update.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { ForbiddenError, UnauthorisedError, ValidationError } from '../types/errors.js';
import { acknowledgeAgentJob, agentJobEvents, getAgentJob, handOff, listAgentJobs, listLiveAgentJobs, listSpecialists, type AgentJob } from '../agents/index.js';
import { queueBlogRecheck } from '../services/blogJobs.js';
import { acknowledgeAssignmentNotice, getAssignmentSummary, listAssignmentNotices, listAssignmentSummaries } from '../agents/workforce/status.js';
import { cancelAssignment } from '../agents/workforce/store.js';
import { hasManualBlogExecutor, resumeConfiguredAssignment } from '../agents/workforce/dispatcher.js';
import { commissionManualBlogRecheck, commissionPreparedManualBlog, prepareManualBlogCommission, startManualBlogCommission, type TrustedBlogCommissionContext } from '../agents/workforce/blogCommission.js';
import { workerPool } from '../agents/engine.js';
import { beginManualBlogEdit } from '../agents/workforce/blogDomain.js';
import { record } from '../agents/workforce/contracts.js';

export const agentJobsRouter = Router();
const HEARTBEAT_MS = 15_000;
const RECHECK_MS = 5_000;
const MAX_TEXT = 200;
const MAX_EDITOR_SIGNATURE_CHARS = 200_000;

const wrap = (run: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction): void => {
  void run(req).then((data) => { res.json({ success: true, data }); }).catch(next);
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw new ValidationError(`${label} is required.`);
  return value.trim();
};
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const jobId = (req: Request): string => {
  const id = req.params['id'];
  if (typeof id !== 'string' || !UUID.test(id)) throw new ValidationError('A valid job ID is required.');
  return id;
};
const optionalText = (value: unknown, label: string): string | undefined => value === undefined || value === null || value === '' ? undefined : text(value, label);
const ownerId = (req: Request): string => {
  if (!('userId' in req) || typeof req.userId !== 'string' || !req.userId.trim()) throw new UnauthorisedError();
  return req.userId;
};
const assignmentRevision = (body: Record<string, unknown>): number => {
  const value = body['revision'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ValidationError('The current assignment revision is required.');
  return value;
};

function appCommissionContext(req: Request, scopeValue: unknown, requestId: unknown): TrustedBlogCommissionContext {
  if (!hasManualBlogExecutor()) throw new ForbiddenError('The manual blog workforce pilot has not been enabled.');
  const scope = record(scopeValue, 'Commission scope');
  if (scope['projectId'] !== null && typeof scope['projectId'] !== 'string') throw new ValidationError('The exact project boundary is required.');
  if (scope['readOnly'] !== false || !Array.isArray(scope['excludedSourceIds'])
    || !scope['excludedSourceIds'].every((id: unknown) => typeof id === 'string')) throw new ValidationError('An explicit mutating action and exact source exclusions are required.');
  return {
    ownerId: ownerId(req), origin: { kind: 'app', requestId: text(requestId, 'Commission request ID') },
    projectId: scope['projectId'], excludedSourceIds: scope['excludedSourceIds'], readOnly: false,
  };
}

agentJobsRouter.get('/specialists', wrap(() => Promise.resolve(listSpecialists().map(({ id, name, description, subjectType }) => ({ id, name, description, subjectType })))));

agentJobsRouter.get('/assignments', wrap(req => listAssignmentSummaries(getDb(), ownerId(req))));
agentJobsRouter.get('/workforce-capabilities', wrap(req => {
  ownerId(req);
  return Promise.resolve({ manualBlog: hasManualBlogExecutor() });
}));
agentJobsRouter.post('/assignments/manual-blog/start', wrap(async req => {
  const body = record(req.body, 'Manual blog action');
  const context = appCommissionContext(req, { projectId: null, excludedSourceIds: [], readOnly: false }, body['requestId']);
  const result = await startManualBlogCommission(getDb(), workerPool(), body, context);
  agentJobEvents.emit('assignment', result.assignment.id);
  return { assignment: await getAssignmentSummary(getDb(), result.assignment.id, context.ownerId), existing: result.existing };
}));
agentJobsRouter.post('/assignments/manual-blog/preview', wrap(req => {
  const body = record(req.body, 'Manual blog request');
  return prepareManualBlogCommission(getDb(), body, appCommissionContext(req, body['scope'], body['requestId']));
}));
agentJobsRouter.post('/assignments/manual-blog', wrap(async req => {
  const body = record(req.body, 'Manual blog commission');
  const prepared = record(body['prepared'], 'Prepared commission');
  const brief = record(prepared['brief'], 'Prepared brief');
  const context = appCommissionContext(req, brief['scope'], body['requestId']);
  const result = await commissionPreparedManualBlog(getDb(), workerPool(), prepared, context);
  agentJobEvents.emit('assignment', result.assignment.id);
  return { assignment: await getAssignmentSummary(getDb(), result.assignment.id, context.ownerId), existing: result.existing };
}));
agentJobsRouter.get('/assignment-notices', wrap(req => listAssignmentNotices(getDb(), ownerId(req))));
agentJobsRouter.post('/assignment-notices/:id/ack', wrap(async req => {
  await acknowledgeAssignmentNotice(getDb(), jobId(req), ownerId(req));
  return { acknowledged: true };
}));
agentJobsRouter.get('/assignments/:id', wrap(req => getAssignmentSummary(getDb(), jobId(req), ownerId(req))));
agentJobsRouter.post('/assignments/:id/cancel', wrap(async req => {
  const owner = ownerId(req);
  const body = record(req.body, 'Cancellation');
  const id = jobId(req);
  await cancelAssignment(getDb(), id, owner, assignmentRevision(body));
  agentJobEvents.emit('assignment', id);
  return getAssignmentSummary(getDb(), id, owner);
}));
agentJobsRouter.post('/assignments/:id/resume', wrap(async req => {
  const owner = ownerId(req);
  const body = record(req.body, 'Resume request');
  const id = jobId(req);
  await resumeConfiguredAssignment(getDb(), id, owner, assignmentRevision(body), text(body['requestId'], 'Resume request ID'));
  agentJobEvents.emit('assignment', id);
  return getAssignmentSummary(getDb(), id, owner);
}));

agentJobsRouter.post('/', wrap((req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body['specialist'] === 'blog-writer' && hasManualBlogExecutor()) {
    throw new ForbiddenError('Use the explicit manual-blog workforce action. The enabled pilot cannot fall back to a legacy manual writer.');
  }
  const input = body['input'];
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) throw new ValidationError('Job input must be an object.');
  return handOff(getDb(), {
    specialist: text(body['specialist'], 'Specialist'),
    subjectId: text(body['subjectId'], 'Subject'),
    input: (input ?? {}) as Record<string, unknown>,
    requestedBy: 'app',
    confirmed: body['confirmed'] === true,
  });
}));

agentJobsRouter.get('/', wrap((req) => listAgentJobs(getDb(), {
  subjectType: optionalText(req.query['subjectType'], 'Subject type'),
  subjectId: optionalText(req.query['subjectId'], 'Subject'),
  limit: Number(req.query['limit']) || undefined,
})));

agentJobsRouter.get('/stream', (_req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const sent = new Map<string, string>();
  const send = (job: AgentJob): void => {
    const json = JSON.stringify(job);
    if (res.destroyed || sent.get(job.id) === json) return;
    sent.set(job.id, json);
    res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`);
  };
  let checking = false;
  const recheck = (): void => {
    if (checking) return;
    checking = true;
    void listLiveAgentJobs(getDb()).then((jobs) => {
      for (const job of jobs) send(job);
      // Jobs that dropped off the live list (acknowledged elsewhere) are fetched once more so the app sees their end state.
      const live = new Set(jobs.map((job) => job.id));
      const gone = [...sent.keys()].filter((id) => !live.has(id) && !(JSON.parse(sent.get(id)!) as AgentJob).acknowledged);
      return Promise.all(gone.map((id) => getAgentJob(getDb(), id).then(send).catch(() => { sent.delete(id); })));
    }).catch((error: unknown) => { console.error('[agents] Live job check failed:', error); })
      .finally(() => { checking = false; });
  };
  agentJobEvents.on('job', send);
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
  const poll = setInterval(recheck, RECHECK_MS);
  recheck();
  res.on('close', () => {
    agentJobEvents.off('job', send);
    clearInterval(heartbeat);
    clearInterval(poll);
  });
});

agentJobsRouter.get('/:id', wrap((req) => getAgentJob(getDb(), jobId(req), ownerId(req))));

agentJobsRouter.post('/:id/blog-recheck', wrap(async req => {
  const id = jobId(req);
  const job = await getAgentJob(getDb(), id, ownerId(req));
  if (job.result && typeof job.result === 'object' && 'workforceAssignmentId' in job.result) {
    throw new ForbiddenError('Use the bounded workforce recheck action for this draft. No legacy recheck was started.');
  }
  return queueBlogRecheck(getDb(), id, req.body);
}));

agentJobsRouter.post('/:id/workforce-blog-recheck', wrap(async req => {
  if (!hasManualBlogExecutor()) throw new ForbiddenError('The manual blog workforce pilot has not been enabled. No legacy recheck was started.');
  const body = record(req.body, 'Workforce recheck action');
  const result = await commissionManualBlogRecheck(getDb(), workerPool(), jobId(req), ownerId(req),
    text(body['requestId'], 'Recheck action ID'), body['post']);
  agentJobEvents.emit('assignment', result.assignment.id);
  return { assignment: await getAssignmentSummary(getDb(), result.assignment.id, ownerId(req)), existing: result.existing };
}));

agentJobsRouter.post('/:id/blog-edit-start', wrap(async req => {
  const body = record(req.body, 'Blog editor action');
  if (typeof body['draftSignature'] !== 'string' || !body['draftSignature'] || body['draftSignature'].length > MAX_EDITOR_SIGNATURE_CHARS) {
    throw new ValidationError('The exact original editor draft signature is required.');
  }
  const result = await beginManualBlogEdit(getDb(), jobId(req), ownerId(req), body['draftSignature'], text(body['requestId'], 'Editor action ID'));
  agentJobEvents.emit('assignment', result.assignmentId);
  return result;
}));

agentJobsRouter.post('/:id/ack', wrap(async (req) => {
  const id = jobId(req);
  await getAgentJob(getDb(), id, ownerId(req));
  await acknowledgeAgentJob(getDb(), id);
  return { acknowledged: true };
}));
