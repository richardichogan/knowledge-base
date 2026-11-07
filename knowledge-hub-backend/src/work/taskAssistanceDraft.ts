import type { Pool } from 'pg';
import type { SpecialistContext } from '../agents/registry.js';
import { currentAgentAttempt, lockAgentAttempt } from '../agents/attempt.js';
import { ConflictError, ValidationError } from '../types/errors.js';

const MAX_DRAFT_CHARS = 60_000;
const MAX_EVIDENCE_CHARS = 48_000;
const MAX_SOURCE_CHARS = MAX_EVIDENCE_CHARS;

export interface TaskSourceEvidence {
  tool: string;
  excerpt: string;
  truncated: boolean;
}

export function retainTaskSourceEvidence(sources: TaskSourceEvidence[], tool: string, evidence: unknown): void {
  const raw = JSON.stringify(evidence);
  if (!raw) return;
  const identity = (text: string): string => {
    try {
      const value = JSON.parse(text) as { record?: { ref?: unknown }; url?: string };
      return JSON.stringify(value.record?.ref ?? value.url ?? text);
    } catch { return text; }
  };
  const key = identity(raw);
  const previous = sources.findIndex(source => source.tool === tool && identity(source.excerpt) === key);
  if (previous !== -1) sources.splice(previous, 1);
  const remaining = MAX_EVIDENCE_CHARS - sources.reduce((sum, source) => sum + source.excerpt.length, 0);
  if (remaining <= 0) return;
  sources.push({ tool, excerpt: raw.slice(0, remaining), truncated: raw.length > remaining });
}

export interface TaskDraftCheckpoint {
  proposalId: string;
  taskSignature: string;
  direction: string;
  body: string;
  sourceEvidence: TaskSourceEvidence[];
  sourcesRead: number;
  publicSearches: number;
  publicSourcesRead: number;
  capturedAt: string;
  reviewFeedback: string;
}

export function parseTaskDraftCheckpoint(raw: unknown): TaskDraftCheckpoint {
  if (!raw || typeof raw !== 'object') throw new ValidationError('The retained task draft is invalid.');
  const value = raw as Record<string, unknown>;
  for (const field of ['proposalId', 'taskSignature', 'direction', 'body', 'capturedAt', 'reviewFeedback']) {
    if (typeof value[field] !== 'string' || value[field].length > MAX_DRAFT_CHARS) {
      throw new ValidationError(`Invalid retained task draft ${field}.`);
    }
  }
  if (!String(value['body']).trim() || !Number.isFinite(Date.parse(String(value['capturedAt'])))) {
    throw new ValidationError('The retained task draft is empty or has no capture date.');
  }
  for (const field of ['sourcesRead', 'publicSearches', 'publicSourcesRead']) {
    if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0) throw new ValidationError(`Invalid retained evidence ${field}.`);
  }
  const sourceEvidence: TaskSourceEvidence[] = [];
  if (!Array.isArray(value['sourceEvidence'])) throw new ValidationError('The retained source evidence is invalid.');
  for (const rawSource of value['sourceEvidence']) {
    if (!rawSource || typeof rawSource !== 'object') throw new ValidationError('The retained source evidence is invalid.');
    const source = rawSource as Record<string, unknown>;
    if (typeof source['tool'] !== 'string' || typeof source['excerpt'] !== 'string'
      || source['excerpt'].length > MAX_SOURCE_CHARS || typeof source['truncated'] !== 'boolean') {
      throw new ValidationError('The retained source evidence is invalid.');
    }
    sourceEvidence.push({ tool: source['tool'], excerpt: source['excerpt'], truncated: source['truncated'] });
  }
  if (sourceEvidence.reduce((sum, source) => sum + source.excerpt.length, 0) > MAX_EVIDENCE_CHARS
    || Number(value['sourcesRead']) > 0 && !sourceEvidence.length) {
    throw new ValidationError('The retained source evidence is missing or too large.');
  }
  return { proposalId: String(value['proposalId']), taskSignature: String(value['taskSignature']),
    direction: String(value['direction']), body: String(value['body']), capturedAt: String(value['capturedAt']),
    reviewFeedback: String(value['reviewFeedback']), sourceEvidence, sourcesRead: Number(value['sourcesRead']),
    publicSearches: Number(value['publicSearches']), publicSourcesRead: Number(value['publicSourcesRead']) };
}

export async function retainedTaskDraft(
  db: Pick<Pool, 'query'>, taskId: string, ownerId: string, taskSignature: string,
): Promise<TaskDraftCheckpoint | undefined> {
  const row = (await db.query<{ checkpoint: unknown }>(`
    SELECT j.input->'taskDraftCheckpoint' AS checkpoint FROM agent_jobs j
    JOIN task_assistance a ON a.id::text=j.input->>'proposalId'
    WHERE a.task_id=$1 AND a.owner_id=$2 AND a.task_signature=$3 AND a.approved_at IS NOT NULL
      AND j.subject_id::text=$1::text AND j.status IN ('failed','done')
      AND j.specialist IN ('task-researcher','task-email-drafter','task-message-drafter','task-preparation-assistant')
      AND j.input ? 'taskDraftCheckpoint' AND j.updated_at>now()-INTERVAL '1 day'
    ORDER BY j.updated_at DESC LIMIT 1`, [taskId, ownerId, taskSignature])).rows[0];
  if (!row) return undefined;
  const checkpoint = parseTaskDraftCheckpoint(row.checkpoint);
  if (checkpoint.taskSignature !== taskSignature) throw new ConflictError('The retained task evidence is stale.', 'TASK_ASSISTANCE_STALE');
  return checkpoint;
}

export async function saveTaskDraft(context: SpecialistContext, checkpoint: TaskDraftCheckpoint): Promise<void> {
  parseTaskDraftCheckpoint(checkpoint);
  const client = await context.db.connect();
  try {
    await client.query('BEGIN');
    await lockAgentAttempt(client);
    const saved = await client.query(`UPDATE agent_jobs SET
      input=jsonb_set(input,'{taskDraftCheckpoint}',$3::jsonb),updated_at=now()
      WHERE id=$1 AND attempts=$2 AND status='running' AND lease_until>clock_timestamp()
        AND ($4::uuid IS NULL OR lease_owner=$4) RETURNING id`,
    [context.jobId, context.attempt, JSON.stringify(checkpoint), currentAgentAttempt()?.owner ?? null]);
    if (!saved.rowCount) throw new ConflictError('This attempt no longer owns the retained task draft.', 'AGENT_ATTEMPT_CONFLICT');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
