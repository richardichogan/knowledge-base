import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { parseJob, text, withRunDiagnostics, type JobRun } from '../jobs/contracts.js';
import { getJob, getRun, listJobs, pauseJob, proposeJob, runColumns } from '../jobs/store.js';
import { ValidationError } from '../types/errors.js';
import { env } from '../config/env.js';

export const JOB_TOOL: LlmToolDefinition = {
  type: 'function',
  function: {
    name: 'manage_scheduled_jobs',
    description: 'Design and manage persistent Athena jobs from ANY chat: scheduled prompts, content sync, M365 Daily Insights ingestion and weekly Microsoft workflows. First inspect existing jobs/devices. Discuss purpose and refine prompts collaboratively; ask only for missing consequential choices. Save proposes an exact configuration confirmation card, never enables it silently. Read returns run artifacts/audit. Inputs/outputs are explicit typed steps, not shell commands. Local files require a registered authorised desktop folder; ingestion does NOT make M365 generate a report. Approval/automatic is per job. Publishing uses blog then its public link for Bluesky/LinkedIn. Preview never publishes. Do not invent job IDs or devices.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'read', 'devices', 'save', 'pause', 'run', 'preview', 'approve', 'audit'] },
      id: { type: 'string', description: 'Job UUID from list.' },
      runId: { type: 'string' },
      revision: { type: 'integer', description: 'Current revision from read/list; required for updates.' },
      enabled: { type: 'boolean', description: 'Propose enabling only after discussing the complete schedule and permissions.' },
      definition: { type: 'object', description: 'Complete job: name,kind (content-sync,m365-import,weekly-microsoft,prompt,discover-picks,task-review,publishing-picks,goals-brief,goals-scorecard,deal-desk,meeting-prep,content-packages,cfp-shortlist — deal-desk updates the Imagine deal-desk notes; meeting-prep builds meeting cards, promises, chases and cadence nudges from the Daily Briefing; content-packages drafts one blog+LinkedIn package for approval; cfp-shortlist refreshes the CFP shortlist and drafts confirmed abstracts; goals-brief proposes the Monday move per goal; goals-scorecard writes the Friday scorecard and tidy-up batch for approval; discover-picks chooses the three Discover articles worth posting; task-review has Athena review new or changed open tasks, propose help and start proposed research; both require empty outputs),prompt,schedule:{timezone:IANA,days:[0 Sunday..6 Saturday],times:[HH:mm]},approval:required|automatic,deviceId,inputFolder,outputFolder,outputs:[think,slack,blog,bluesky,linkedin,file]. Empty local fields are valid for cloud jobs. Retain existing settings when editing.', additionalProperties: true },
    }, required: ['action'] },
  },
};

function id(value: unknown): string {
  const s = text(value, 'job/run ID');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s)) throw new ValidationError('Use the real job or run UUID.');
  return s;
}
export async function executeJobTool(db: Pool, args: Record<string, unknown>, sessionId?: string): Promise<unknown> {
  if (!['list', 'read', 'devices', 'audit'].includes(String(args.action)) && env.NODE_ENV !== 'production') {
    throw new ValidationError('Manage live schedules through the production Athena backend. Development servers cannot change or run production jobs.');
  }
  switch (args.action) {
    case 'list': return { jobs: await listJobs(db) };
    case 'devices': return (await db.query<Record<string, unknown>>('SELECT id,name,folders,seen_at AS "seenAt" FROM managed_job_devices ORDER BY name')).rows;
    case 'read': return args.runId ? getRun(db, id(args.runId)) : {
      job: await getJob(db, id(args.id)),
      runs: (await db.query<JobRun>(`SELECT ${runColumns} FROM managed_job_runs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 10`, [id(args.id)])).rows.map(run => withRunDiagnostics(run)),
    };
    case 'audit': return (await db.query<Record<string, unknown>>(`SELECT actor,event,detail,created_at FROM managed_job_events
      WHERE ${args.runId ? 'run_id' : 'job_id'}=$1 ORDER BY id DESC LIMIT 50`, [id(args.runId ?? args.id)])).rows;
    case 'pause': await pauseJob(db, id(args.id), `chat:${sessionId ?? 'unsaved'}`); return { paused: true };
    case 'save': {
      if (!sessionId) throw new ValidationError('Save the chat before proposing a job.');
      const definition = parseJob(args.definition);
      if (args.id) {
        const job = await getJob(db, id(args.id));
        if (args.revision !== job.revision) throw new ValidationError('Read the current revision before changing the job.');
      }
      return proposeJob(db, sessionId, { operation: 'save', ...(args.id ? { id: id(args.id), revision: args.revision } : {}), definition, enabled: args.enabled === true });
    }
    case 'run':
    case 'preview': {
      if (!sessionId) throw new ValidationError('Save the chat before proposing a run.');
      const job = await getJob(db, id(args.id));
      return proposeJob(db, sessionId, { operation: 'run', id: job.id, revision: job.revision, definition: job.definition, preview: args.action === 'preview' });
    }
    case 'approve': {
      if (!sessionId) throw new ValidationError('Save the chat before approving a run.');
      const run = await getRun(db, id(args.runId));
      return proposeJob(db, sessionId, { operation: 'approve', runId: run.id, revision: run.revision, artifacts: run.artifacts, definition: run.definition });
    }
    default: throw new ValidationError('Unknown job-management action.');
  }
}
