import { ValidationError } from '../types/errors.js';
export const JOB_LIMITS = {
  path: 2048, name: 200, timezone: 100, weekdays: 7, lastWeekday: 6, times: 8, prompt: 16000,
  evidenceExcerpt: 5000, promptTokens: 6000, packageTokens: 8000, socialCopy: 1000, linkedinCopy: 2700,
  markdown: 100000, dateChars: 10, slackText: 50000, slackTimeoutMs: 15000, workers: 2,
  serverErrorStatus: 500, requestTimeoutStatus: 408, historyOffset: 1000000, status: 50,
  dateInput: 40, folderCount: 100, deviceError: 2000, report: 250000,
} as const;

export type JobKind = 'content-sync' | 'm365-import' | 'weekly-microsoft' | 'prompt';
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
  if (kind !== 'content-sync' && kind !== 'm365-import' && kind !== 'weekly-microsoft' && kind !== 'prompt') throw new ValidationError('Unknown job action.');
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
