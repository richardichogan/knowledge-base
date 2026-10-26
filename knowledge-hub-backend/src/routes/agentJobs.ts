/**
 * routes/agentJobs.ts — hand work to a specialist and follow it live.
 *
 * GET /stream sends every live job, then pushes each change. It also rechecks
 * the database every few seconds so jobs run by another server (production and
 * local development share a database) still update.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { ValidationError } from '../types/errors.js';
import { acknowledgeAgentJob, agentJobEvents, getAgentJob, handOff, listAgentJobs, listLiveAgentJobs, listSpecialists, type AgentJob } from '../agents/index.js';

export const agentJobsRouter = Router();
const HEARTBEAT_MS = 15_000;
const RECHECK_MS = 5_000;
const MAX_TEXT = 200;

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

agentJobsRouter.get('/specialists', wrap(() => Promise.resolve(listSpecialists().map(({ id, name, description, subjectType }) => ({ id, name, description, subjectType })))));

agentJobsRouter.post('/', wrap((req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
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

agentJobsRouter.get('/:id', wrap((req) => getAgentJob(getDb(), jobId(req))));

agentJobsRouter.post('/:id/ack', wrap(async (req) => {
  await acknowledgeAgentJob(getDb(), jobId(req));
  return { acknowledged: true };
}));
