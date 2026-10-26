/**
 * agentJobStore — follows specialist jobs live for the whole app.
 *
 * One stream per tab. When a job finishes it is announced once (across tabs and
 * reloads, via the server's acknowledgement), the chat it came from is refreshed,
 * and pages working on the same subject are told so they can reload.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import { announceAthenaJob } from '../components/athena/AthenaJobNotice';
import { isActiveAgentJob, type AgentJob } from '../types/agentJobs';

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const CLAIM_PREFIX = 'athena-agent-job-announced:';

const jobs = new Map<string, AgentJob>();
const listeners = new Set<() => void>();
const finishListeners = new Set<(job: AgentJob) => void>();
let snapshot: AgentJob[] = [];
let holders = 0;
let controller: AbortController | null = null;
let retryTimer: number | undefined;

function changed(): void {
  snapshot = [...jobs.values()];
  for (const listener of listeners) listener();
}

/** True for the first tab to claim the job, so only one tab chimes. */
function claim(id: string): boolean {
  try {
    const key = `${CLAIM_PREFIX}${id}`;
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, String(Date.now()));
    return true;
  } catch { return true; }
}

function receive(job: AgentJob): void {
  const previous = jobs.get(job.id);
  jobs.set(job.id, job);
  changed();
  if (isActiveAgentJob(job) || (previous && previous.status === job.status)) return;
  for (const listener of finishListeners) listener(job);
  if (job.conversationId) window.dispatchEvent(new CustomEvent('athena-conversation-updated', { detail: { sessionId: job.conversationId } }));
  if (job.acknowledged) return;
  if (!job.isStep || job.status === 'failed') {
    if (claim(job.id)) {
      const url = typeof job.result?.['url'] === 'string' ? job.result['url'] : job.subjectUrl;
      announceAthenaJob({
        id: job.id, always: true, ok: job.status === 'done', tag: `agent-job-${job.subjectId}`,
        startedAt: Date.parse(job.startedAt ?? job.createdAt),
        title: job.status === 'done' ? `${job.specialistName} finished` : `${job.specialistName} could not finish`,
        body: job.status === 'done'
          ? `${job.subjectTitle ? `${job.subjectTitle}: ` : ''}${job.summary ?? 'The work is ready.'}`
          : job.error ?? 'Something went wrong. Nothing else was changed.',
        url: url || '/',
      });
    }
  }
  void api.acknowledgeAgentJob(job.id).catch(() => { /* the next tab or reload acknowledges it */ });
}

function connect(retryMs = RETRY_MIN_MS): void {
  const current = new AbortController();
  controller = current;
  let healthy = false;
  void api.streamAgentJobs(job => { healthy = true; receive(job); }, current.signal)
    .catch(() => undefined)
    .finally(() => {
      if (controller !== current || current.signal.aborted) return;
      const delay = healthy ? RETRY_MIN_MS : Math.min(retryMs * 2, RETRY_MAX_MS);
      retryTimer = window.setTimeout(() => { if (controller === current) connect(delay); }, delay);
    });
}

/** Keeps the live stream open while anything holds it. */
export function holdAgentJobFeed(): () => void {
  holders += 1;
  if (holders === 1) connect();
  return () => {
    holders -= 1;
    if (holders > 0) return;
    window.clearTimeout(retryTimer);
    controller?.abort();
    controller = null;
  };
}

/** Adds or updates a job straight away, e.g. from a handoff response, before the stream catches up. */
export function rememberAgentJob(job: AgentJob): void {
  if (jobs.has(job.id)) return;
  jobs.set(job.id, job);
  changed();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const release = holdAgentJobFeed();
  return () => { listeners.delete(listener); release(); };
};

/** Jobs for one subject: the one in progress (if any) and the most recent. */
export function useAgentJobs(subjectId: string | undefined): { active: AgentJob | undefined; jobs: AgentJob[] } {
  const all = useSyncExternalStore(subscribe, () => snapshot);
  return useMemo(() => {
    const mine = subjectId ? all.filter(job => job.subjectId === subjectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
    const running = mine.filter(isActiveAgentJob);
    return { active: running.find(job => job.status === 'running') ?? running[0], jobs: mine };
  }, [all, subjectId]);
}

/** Calls back when any job on the subject finishes (done or failed). */
export function useAgentJobFinished(subjectId: string | undefined, onFinished: (job: AgentJob) => void): void {
  useEffect(() => {
    if (!subjectId) return;
    const listener = (job: AgentJob): void => { if (job.subjectId === subjectId) onFinished(job); };
    finishListeners.add(listener);
    return () => { finishListeners.delete(listener); };
  }, [subjectId, onFinished]);
}

/** Keeps the job stream open for the signed-in app so finished work is announced on any page. */
export function AgentJobFeed(): null {
  useEffect(() => holdAgentJobFeed(), []);
  return null;
}
