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
import { abortable } from './abortable.js';
import { AI_BACKGROUND_TURN_BUDGET_MS } from '../config/constants.js';

export type TurnEvent =
  | { type: 'snapshot'; message: string; activity: string; text: string }
  | { type: 'activity'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'done'; data: unknown }
  | { type: 'error'; message: string; stopped: boolean }
  /** The turn became a background task: the chat is free for new messages. */
  | { type: 'background' }
  /** A background task is about to save edits to this note: save any typing first, then ack. */
  | { type: 'edits-ready'; noteId: string };

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
  background: boolean;
  /** Set once the reply is ready: after this the turn can no longer move to the background. */
  claimed: boolean;
  noteId: string | null;
  finished: Promise<void>;
  flushAck: (() => void) | null;
}

/** A turn still running this long moves to the background so the chat isn't held up. */
export const BACKGROUND_AFTER_MS = 15_000;
const FLUSH_WAIT_MS = 8_000;

const KEEP_FINISHED_MS = 10 * 60_000;
const jobs = new Map<string, TurnJob>();
const jobBySession = new Map<string, string>();
let stopping = false;

export function stopTurnJobs(): void {
  stopping = true;
  for (const job of jobs.values()) {
    if (job.outcome === null) job.controller.abort(new Error('The server is restarting. This turn was interrupted and will not be replayed automatically.'));
  }
}

function emit(job: TurnJob, e: TurnEvent): void {
  if (e.type === 'activity') job.activity = e.text;
  if (e.type === 'delta') job.text += e.text;
  if (e.type === 'reset') job.text = '';
  if (e.type === 'done' || e.type === 'error') job.outcome = e;
  if (e.type === 'background') job.background = true;
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
  /** false for side jobs (e.g. "Ask another model") that aren't the chat's current turn. */
  trackForSession = true,
  budgetMs = AI_BACKGROUND_TURN_BUDGET_MS,
  /** Called when the turn moves to the background (frees the chat for the next message). */
  onBackground?: () => void,
): { id: string; startedAt: string } {
  let finish: () => void = () => undefined;
  const job: TurnJob = {
    id, sessionId, message, startedAt: new Date().toISOString(),
    activity: 'Thinking', text: '', outcome: null, listeners: new Set(), controller: new AbortController(),
    background: false, claimed: false, noteId: null, finished: new Promise<void>(resolve => { finish = resolve; }), flushAck: null,
  };
  jobs.set(job.id, job);
  if (trackForSession) jobBySession.set(sessionId, job.id);
  type BackgroundEvent = { reason: 'timer' | 'predicted'; afterMs: number };
  let promoted: BackgroundEvent | null = null;
  let recordBackground: ((event: BackgroundEvent) => void) | null = null;
  const promote = (reason: BackgroundEvent['reason']): void => {
    if (!trackForSession || job.background || job.claimed || job.outcome !== null || job.controller.signal.aborted) return;
    emit(job, { type: 'background' });
    if (jobBySession.get(sessionId) === job.id) jobBySession.delete(sessionId);
    onBackground?.();
    promoted = { reason, afterMs: Date.now() - Date.parse(job.startedAt) };
    recordBackground?.(promoted);
  };
  const backgroundTimer = trackForSession ? setTimeout(() => promote('timer'), BACKGROUND_AFTER_MS) : undefined;
  backgroundTimer?.unref();

  let deadline: ReturnType<typeof setTimeout>;
  const refreshDeadline = (): void => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      job.controller.abort(new Error('Athena took too long without making progress. Any reading checkpoints were preserved; continue from the saved reading rather than starting over.'));
    }, budgetMs);
  };
  const hooks: TurnHooks = {
    onDelta: (text) => { if (!job.controller.signal.aborted) emit(job, { type: 'delta', text }); },
    onReset: () => { if (!job.controller.signal.aborted) emit(job, { type: 'reset' }); },
    onActivity: (text) => { if (!job.controller.signal.aborted) emit(job, { type: 'activity', text }); },
    onReadingProgress: refreshDeadline,
    signal: job.controller.signal,
    promoteToBackground: () => promote('predicted'),
    traceBackground: (record) => { recordBackground = record; if (promoted) record(promoted); },
    onTargetNote: (noteId) => { job.noteId = noteId; },
    turnId: job.id,
  };
  refreshDeadline();
  void abortable(Promise.resolve().then(() => {
    job.controller.signal.throwIfAborted();
    return run(hooks);
  }), job.controller.signal)
    .then((data) => { emit(job, { type: 'done', data }); })
    .catch((err: unknown) => {
      const stopped = err instanceof AiStoppedError || (job.controller.signal.aborted && job.controller.signal.reason instanceof AiStoppedError);
      if (!stopped) console.error('[turn] failed:', err);
      emit(job, { type: 'error', stopped, message: stopped ? 'Stopped' : err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      clearTimeout(deadline);
      clearTimeout(backgroundTimer);
      finish();
      if (!stopping) onFinished();
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
  if (job.background) listener({ type: 'background' });
  if (job.outcome !== null) {
    listener(job.outcome);
    return () => { /* finished */ };
  }
  job.listeners.add(listener);
  return () => { job.listeners.delete(listener); };
}

/**
 * Called when the reply is ready. Fixes where the turn's note edits are saved:
 * on the server for a background task, otherwise by the open editor (and the
 * turn can no longer move to the background).
 */
export function claimDelivery(id: string): 'background' | 'foreground' {
  const job = jobs.get(id);
  if (job === undefined) return 'foreground';
  job.claimed = true;
  return job.background ? 'background' : 'foreground';
}

/**
 * A background task is about to save edits to a note: asks any open chat to
 * save his typing in that note first, waiting a few seconds for the reply.
 */
export async function requestNoteFlush(id: string, noteId: string): Promise<void> {
  const job = jobs.get(id);
  if (job === undefined || job.listeners.size === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { job.flushAck = null; resolve(); }, FLUSH_WAIT_MS);
    job.flushAck = () => { clearTimeout(timer); job.flushAck = null; resolve(); };
    emit(job, { type: 'edits-ready', noteId });
  });
}

/** The chat saved the open note: the background task can save its edits now. */
export function ackNoteFlush(id: string): boolean {
  const ack = jobs.get(id)?.flushAck;
  if (!ack) return false;
  ack();
  return true;
}

/** Waits for background tasks still changing this note (so edits don't overlap). */
export async function waitForNoteTasks(noteId: string, exceptId: string | undefined, signal?: AbortSignal, onWait?: () => void): Promise<boolean> {
  const busy = [...jobs.values()].filter(job => job.background && job.outcome === null && job.noteId === noteId && job.id !== exceptId);
  if (busy.length === 0) return false;
  onWait?.();
  const aborted = new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve(); }, { once: true }); });
  await Promise.race([Promise.all(busy.map(job => job.finished)), aborted]);
  signal?.throwIfAborted();
  return true;
}

/** Background tasks for a chat that are still running (task cards after a reload). */
export function listBackgroundJobs(sessionId: string): Array<{ id: string; message: string; startedAt: string; activity: string }> {
  return [...jobs.values()]
    .filter(job => job.sessionId === sessionId && job.background && job.outcome === null)
    .map(job => ({ id: job.id, message: job.message, startedAt: job.startedAt, activity: job.activity }));
}

/** Background tasks for a chat, for Athena's own context. */
export function describeBackgroundJobs(sessionId: string, exceptId?: string): string {
  const running = listBackgroundJobs(sessionId).filter(job => job.id !== exceptId);
  if (running.length === 0) return '';
  return `## Background tasks still running in this chat\nThese earlier requests are still being worked on separately; their replies will appear when they finish. Don't redo them. If he asks about one, say it's still going and what it's doing.\n${
    running.map(job => `- "${job.message.slice(0, 300)}" (started ${job.startedAt}; now: ${job.activity})`).join('\n')}`;
}

/** Stops a running job (the Stop button). */
export function cancelTurnJob(id: string): boolean {
  const job = jobs.get(id);
  if (job === undefined || job.outcome !== null) return false;
  job.controller.abort(new AiStoppedError());
  return true;
}
