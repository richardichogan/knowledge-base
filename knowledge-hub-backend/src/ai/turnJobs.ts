/**
 * ai/turnJobs.ts — chat turns run as background jobs on the server, so a
 * long answer isn't lost when the browser times out, refreshes or closes.
 * The browser follows a job's live events (activity lines, streamed text)
 * and can reattach to it later. Jobs live in memory — production runs a
 * single replica — and are forgotten a while after they finish (the answer
 * itself is saved to the chat history by the turn).
 */
import { AiStoppedError } from './foundryClient.js';
import type { TurnHooks } from './conversationService.js';

export type TurnEvent =
  | { type: 'snapshot'; message: string; activity: string; text: string }
  | { type: 'activity'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; data: unknown }
  | { type: 'error'; message: string; stopped: boolean };

interface TurnJob {
  id: string;
  sessionId: string;
  message: string;
  startedAt: string;
  activity: string;
  text: string;
  outcome: TurnEvent | null;
  listeners: Set<(e: TurnEvent) => void>;
  controller: AbortController;
}

const KEEP_FINISHED_MS = 10 * 60_000;
const jobs = new Map<string, TurnJob>();
const jobBySession = new Map<string, string>();

function emit(job: TurnJob, e: TurnEvent): void {
  if (e.type === 'activity') job.activity = e.text;
  if (e.type === 'delta') job.text += e.text;
  if (e.type === 'reset') job.text = '';
  if (e.type === 'done' || e.type === 'error') job.outcome = e;
  for (const listener of job.listeners) listener(e);
}

/**
 * Starts a turn in the background. `run` receives the live hooks to pass to
 * handleConversationTurn and resolves with the reply payload.
 */
export function startTurnJob(
  id: string,
  sessionId: string,
  message: string,
  run: (hooks: TurnHooks) => Promise<unknown>,
  onFinished: () => void,
): { id: string; startedAt: string } {
  const job: TurnJob = {
    id, sessionId, message, startedAt: new Date().toISOString(),
    activity: 'Thinking', text: '', outcome: null, listeners: new Set(), controller: new AbortController(),
  };
  jobs.set(job.id, job);
  jobBySession.set(sessionId, job.id);

  const hooks: TurnHooks = {
    onDelta: (text) => { emit(job, { type: 'delta', text }); },
    onReset: () => { emit(job, { type: 'reset' }); },
    onActivity: (text) => { emit(job, { type: 'activity', text }); },
    signal: job.controller.signal,
  };
  void run(hooks)
    .then((data) => { emit(job, { type: 'done', data }); })
    .catch((err: unknown) => {
      const stopped = err instanceof AiStoppedError || job.controller.signal.aborted;
      if (!stopped) console.error('[turn] failed:', err);
      emit(job, { type: 'error', stopped, message: stopped ? 'Stopped' : err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      onFinished();
      if (jobBySession.get(sessionId) === job.id) jobBySession.delete(sessionId);
      setTimeout(() => { jobs.delete(job.id); }, KEEP_FINISHED_MS).unref();
    });
  return { id: job.id, startedAt: job.startedAt };
}

/** The running job for a session, if any. */
export function getSessionTurnJob(sessionId: string): { id: string; message: string; startedAt: string } | null {
  const id = jobBySession.get(sessionId);
  const job = id !== undefined ? jobs.get(id) : undefined;
  return job !== undefined && job.outcome === null ? { id: job.id, message: job.message, startedAt: job.startedAt } : null;
}

/**
 * Follows a job: the listener first gets a snapshot (message, current
 * activity, text so far), then live events; a finished job sends its outcome
 * straight away. Returns an unsubscribe function, or null if the job is gone.
 */
export function subscribeTurnJob(id: string, listener: (e: TurnEvent) => void): (() => void) | null {
  const job = jobs.get(id);
  if (job === undefined) return null;
  listener({ type: 'snapshot', message: job.message, activity: job.activity, text: job.text });
  if (job.outcome !== null) {
    listener(job.outcome);
    return () => { /* finished */ };
  }
  job.listeners.add(listener);
  return () => { job.listeners.delete(listener); };
}

/** Stops a running job (the Stop button). */
export function cancelTurnJob(id: string): boolean {
  const job = jobs.get(id);
  if (job === undefined || job.outcome !== null) return false;
  job.controller.abort();
  return true;
}
