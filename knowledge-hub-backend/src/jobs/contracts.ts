import { ValidationError } from '../types/errors.js';
export const JOB_LIMITS = {
  path: 2048, name: 200, timezone: 100, weekdays: 7, lastWeekday: 6, times: 8, prompt: 16000,
  evidenceExcerpt: 5000, promptTokens: 6000, packageTokens: 20000, socialCopy: 1000, linkedinCopy: 2700,
  markdown: 100000, dateChars: 10, slackText: 50000, slackTimeoutMs: 15000, workers: 2,
  serverErrorStatus: 500, requestTimeoutStatus: 408, historyOffset: 1000000, status: 50,
  dateInput: 40, folderCount: 100, deviceError: 2000, report: 250000,
} as const;

export type JobKind = 'content-sync' | 'm365-import' | 'weekly-microsoft' | 'prompt' | 'discover-picks' | 'task-review' | 'publishing-picks' | 'goals-brief' | 'goals-scorecard';
export interface JobDefinition {
  name: string;
  kind: JobKind;
  prompt: string;
  schedule: { timezone: string; days: number[]; times: string[] };
  approval: 'required' | 'automatic';
  deviceId: string;
  inputFolder: string;
  outputFolder: string;
  outputs: Array<'think' | 'slack' | 'blog' | 'bluesky' | 'linkedin' | 'file'>;
}
export interface ManagedJob {
  id: string; revision: number; enabled: boolean; archived: boolean;
  definition: JobDefinition; nextAt: string | null; updatedAt: string;
}
export interface JobStep {
  key: string; status: 'running' | 'succeeded' | 'failed' | 'unconfirmed';
  startedAt: string; finishedAt?: string; result?: unknown; error?: string;
}
export type RunStatus = 'queued' | 'running' | 'waiting-file' | 'waiting-device' | 'awaiting-approval'
  | 'succeeded' | 'failed' | 'partial' | 'missed' | 'rejected' | 'unconfirmed';
export interface JobRun {
  id: string; jobId: string; revision: number; definition: JobDefinition; scheduledAt: string;
  deadline: string; status: RunStatus; preview: boolean; steps: JobStep[];
  artifacts: Record<string, unknown>; approvedAt: string | null; createdAt: string; updatedAt: string;
  diagnostics?: JobRunDiagnostics;
}

export interface JobRunDiagnostics {
  sourceWarnings: Array<{ source: string; errors: number; failures: unknown[] }>;
  startedAt: string | null; finishedAt: string | null; startDelayMs: number | null;
  elapsedFromScheduleMs: number | null; deadlineExceeded: boolean; blockingStage: string | null;
  note: string;
}

export function withRunDiagnostics(run: JobRun, now = new Date()): JobRun {
  const record = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : null;
  const sync = record(run.artifacts.sync);
  const sources = Array.isArray(sync?.results) ? sync.results
    : Array.isArray(run.artifacts.sourceWarnings) ? run.artifacts.sourceWarnings : [];
  const sourceWarnings = sources.flatMap(value => {
    const source = record(value);
    return source && typeof source.source === 'string' && typeof source.errors === 'number' && source.errors > 0
      ? [{ source: source.source, errors: source.errors, failures: Array.isArray(source.failures) ? source.failures : [] }] : [];
  });
  const starts = run.steps.map(s => Date.parse(s.startedAt)).filter(Number.isFinite);
  const ends = run.steps.flatMap(s => s.finishedAt ? [Date.parse(s.finishedAt)] : []).filter(Number.isFinite);
  const finished = ['succeeded', 'failed', 'partial', 'missed', 'rejected'].includes(run.status);
  const start = starts.length ? Math.min(...starts) : null;
  const end = finished && ends.length ? Math.max(...ends) : null;
  const scheduled = new Date(run.scheduledAt).getTime();
  const deadline = new Date(run.deadline).getTime();
  const asIso = (value: number | null): string | null => value === null ? null : new Date(value).toISOString();
  return { ...run, diagnostics: {
    sourceWarnings, startedAt: asIso(start), finishedAt: asIso(end),
    startDelayMs: start === null ? null : Math.max(0, start - scheduled),
    elapsedFromScheduleMs: end === null ? null : Math.max(0, end - scheduled),
    deadlineExceeded: Number.isFinite(deadline) && (end ?? (finished ? new Date(run.updatedAt).getTime() : now.getTime())) > deadline,
    blockingStage: run.status === 'succeeded' || run.status === 'rejected' ? null
      : run.steps.find(s => s.status === 'running' || s.status === 'failed' || s.status === 'unconfirmed')?.key ?? (finished ? null : run.status),
    note: 'Execution success is not complete source coverage or confirmed delivery. Finish is the last recorded step finish in a stopped run, not proof of completed delivery; missing timestamps are unknown. Schedule elapsed time is not a lateness policy; deadline exceeded uses the saved occurrence deadline.',
  } };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max: number = JOB_LIMITS.path): string {
  if (typeof value !== 'string' || value.length > max) throw new ValidationError(`Invalid ${label}.`);
  return value.trim();
}
export function parseJob(value: unknown): JobDefinition {
  const v = object(value);
  const name = text(v.name, 'job name', JOB_LIMITS.name);
  if (!name) throw new ValidationError('Give the job a name.');
  const kind = v.kind;
  if (kind !== 'content-sync' && kind !== 'm365-import' && kind !== 'weekly-microsoft' && kind !== 'prompt' && kind !== 'discover-picks' && kind !== 'task-review' && kind !== 'publishing-picks' && kind !== 'goals-brief' && kind !== 'goals-scorecard') throw new ValidationError('Unknown job action.');
  const s = object(v.schedule);
  const timezone = text(s.timezone, 'timezone', JOB_LIMITS.timezone);
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(); }
  catch { throw new ValidationError('Choose a valid IANA timezone.'); }
  if (!Array.isArray(s.days) || !s.days.length || s.days.length > JOB_LIMITS.weekdays || s.days.some(d => !Number.isInteger(d) || d < 0 || d > JOB_LIMITS.lastWeekday)) throw new ValidationError('Choose weekdays (0 Sunday to 6 Saturday).');
  if (!Array.isArray(s.times) || !s.times.length || s.times.length > JOB_LIMITS.times || s.times.some(t => typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new ValidationError('Choose one to eight valid HH:mm times.');
  if (v.approval !== 'required' && v.approval !== 'automatic') throw new ValidationError('Choose an approval mode.');
  const allowed = ['think', 'slack', 'blog', 'bluesky', 'linkedin', 'file'] as const;
  if (!Array.isArray(v.outputs)) throw new ValidationError('Choose output destinations.');
  const rawOutputs: unknown[] = v.outputs;
  if (rawOutputs.some(o => !allowed.some(choice => choice === o))) throw new ValidationError('Unknown output destination.');
  const outputs = allowed.filter(o => rawOutputs.includes(o));
  if (outputs.some(o => o === 'bluesky' || o === 'linkedin') && !outputs.includes('blog')) throw new ValidationError('Social workflows require a published blog link.');
  if (kind === 'content-sync' && outputs.length) throw new ValidationError('Content sync has no publishing outputs.');
  if (kind === 'discover-picks' && outputs.length) throw new ValidationError('Discover picks only refresh the Today list; they have no publishing outputs.');
  if (kind === 'publishing-picks' && outputs.length) throw new ValidationError('Publishing picks only choose drafts worth approving; they have no publishing outputs.');
  if ((kind === 'goals-brief' || kind === 'goals-scorecard') && outputs.length) throw new ValidationError('Goal briefs and scorecards stay on Today; they have no publishing outputs and nothing is sent.');
  if (kind === 'task-review' && outputs.length) throw new ValidationError('Task review only proposes help on Plan tasks; drafts stay in Plan > Drafts and nothing is sent.');
  if (kind === 'm365-import' && outputs.length) throw new ValidationError('Daily Insights outputs are its imported tasks, meetings and audit results; additional publishing/file outputs belong in a prompt job.');
  const prompt = text(v.prompt ?? '', 'prompt', JOB_LIMITS.prompt);
  if (kind === 'prompt' && !prompt) throw new ValidationError('A scheduled prompt needs instructions.');
  return { name, kind, prompt, schedule: { timezone, days: [...new Set<number>(s.days)], times: [...new Set<string>(s.times)].sort() },
    approval: v.approval, deviceId: text(v.deviceId ?? '', 'device'), inputFolder: text(v.inputFolder ?? '', 'input folder'),
    outputFolder: text(v.outputFolder ?? '', 'output folder'), outputs };
}

export function readyToEnable(d: JobDefinition): void {
  if ((d.kind === 'm365-import' || d.outputs.includes('file')) && !d.deviceId) throw new ValidationError('Select the authorised desktop device.');
  if (d.kind === 'm365-import' && !d.inputFolder) throw new ValidationError('Select the authorised Daily Insights folder.');
  if (d.outputs.includes('file') && !d.outputFolder) throw new ValidationError('Select an authorised output folder.');
}
