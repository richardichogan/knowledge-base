/**
 * ai/aiLedger.ts — the permanent learning record. Every model call (ai_interactions), every user
 * decision on AI work (ai_decisions) and every user edit of AI-written content (ai_authored_content
 * compared at save time) is attributed to the agent that produced it, so the weekly review can
 * propose lessons for that agent. Writes never affect the operation being recorded.
 */
import type { Pool } from 'pg';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { aiWorkflowAttribution } from './aiWorkflow.js';
import { redactTrace } from './turnTrace.js';
import { resolveAgent, type AgentId } from '../agents/agentIdentity.js';

const MAX_ERROR_CHARS = 2_000;
const MAX_DIFF_CHARS = 40_000;
const MAX_DIFF_LINES = 4_000;
const MAX_NOTE_CHARS = 200_000;
const TABLE_TEXT_CHARS = 2_000;

const environment = (): string => env.isDevelopment ? 'dev' : 'prod';

/**
 * The named agent responsible for work in progress: the owner of the calling feature, else of the
 * workflow that started it. Undefined outside a workflow when no feature is given.
 */
export function currentAgent(feature?: string): AgentId | undefined {
  const root = aiWorkflowAttribution()?.feature;
  if (root === undefined && feature === undefined) return undefined;
  return resolveAgent(feature, root);
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try { return JSON.stringify(redactTrace(value)); } catch { return JSON.stringify({ unserialisable: String(value) }); }
}

function logFailure(what: string): (error: unknown) => void {
  return (error: unknown) => { console.error(`[ai-ledger] ${what} was not recorded:`, error); };
}

export interface InteractionRecord {
  feature: string;
  deployment: string;
  api: string;
  request: unknown;
  response?: unknown;
  error?: unknown;
  durationMs: number;
  persona?: string | undefined;
  sessionId?: string | undefined;
}

export function recordAiInteraction(r: InteractionRecord): void {
  try {
    const attribution = aiWorkflowAttribution();
    const error = r.error === undefined ? null
      : (r.error instanceof Error ? r.error.message : String(r.error)).slice(0, MAX_ERROR_CHARS);
    void getDb().query(
      `INSERT INTO ai_interactions (environment, agent, feature, persona, session_id, workflow_run_id, stage, purpose,
         deployment, api, request, response, ok, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15)`,
      [environment(), currentAgent(r.feature) ?? 'athena', r.feature, r.persona ?? null, r.sessionId ?? null,
        attribution?.workflowRunId ?? null, attribution?.stage ?? null, attribution?.purpose ?? null,
        r.deployment, r.api, safeJson(r.request), safeJson(r.response), error === null, error, Math.round(r.durationMs)],
    ).catch(logFailure('Model interaction'));
  } catch (error) { logFailure('Model interaction')(error); }
}

/** Readable text of a note body, so edits compare writing rather than editor JSON. */
export function noteText(content: string): string {
  let wrapper: unknown;
  try { wrapper = JSON.parse(content); } catch { return content; }
  let title = '';
  let blocks: unknown = wrapper;
  if (wrapper !== null && typeof wrapper === 'object' && !Array.isArray(wrapper)) {
    const record = wrapper as Record<string, unknown>;
    title = typeof record['title'] === 'string' ? record['title'] : '';
    try { blocks = typeof record['contentJson'] === 'string' ? JSON.parse(record['contentJson']) : []; } catch { blocks = []; }
  }
  const lines: string[] = title ? [`# ${title}`, ''] : [];
  const inline = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(inline).join('');
    if (value !== null && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      if (typeof item['text'] === 'string') return item['text'];
      if (item['content'] !== undefined) return inline(item['content']);
    }
    return '';
  };
  const walk = (items: unknown, depth: number): void => {
    if (!Array.isArray(items)) return;
    for (const block of items) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const props = (b['props'] ?? {}) as Record<string, unknown>;
      const text = inline(b['content']);
      const indent = '  '.repeat(depth);
      const type = String(b['type'] ?? 'paragraph');
      if (type === 'heading') lines.push(`${'#'.repeat(Number(props['level'] ?? 1))} ${text}`);
      else if (type === 'bulletListItem') lines.push(`${indent}- ${text}`);
      else if (type === 'numberedListItem') lines.push(`${indent}1. ${text}`);
      else if (type === 'checkListItem') lines.push(`${indent}- [${props['checked'] === true ? 'x' : ' '}] ${text}`);
      else if (type === 'codeBlock') lines.push(`\`\`\`${String(props['language'] ?? '')}`, text, '```');
      else if (type === 'sourceCaption') lines.push(`${indent}Source: ${text || '(not given)'}`);
      else if (type === 'table') lines.push(`[table] ${JSON.stringify(b['content']).slice(0, TABLE_TEXT_CHARS)}`);
      else if (text !== '' || type === 'paragraph') lines.push(`${indent}${text}`);
      walk(b['children'], depth + 1);
    }
  };
  walk(blocks, 0);
  return lines.join('\n').slice(0, MAX_NOTE_CHARS);
}

/** Line diff of the AI version against the user's version ('-' removed, '+' added). */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `(Too long for a line diff: ${a.length.toString()} AI lines, ${b.length.toString()} final lines.)`;
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const table: Uint32Array[] = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; continue; }
    if (j < y.length && (i >= x.length || table[i]![j + 1]! >= table[i + 1]![j]!)) out.push(`+ ${y[j++]!}`);
    else out.push(`- ${x[i++]!}`);
  }
  const text = out.join('\n');
  return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : text;
}

/**
 * Snapshots content an agent has just written. Only recorded while an AI workflow is running,
 * unless the caller names the agent explicitly.
 */
export function recordAiAuthored(
  db: Pool, targetType: string, targetId: string, content: string, agent?: string,
): void {
  const who = agent === undefined ? currentAgent() : resolveAgent(agent);
  if (who === undefined || content.trim() === '') return;
  void db.query(
    `INSERT INTO ai_authored_content (environment, agent, workflow_run_id, target_type, target_id, content)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [environment(), who, aiWorkflowAttribution()?.workflowRunId ?? null, targetType, targetId, content],
  ).catch(logFailure('AI-authored snapshot'));
}

/** Records a note written by an agent, as readable text. */
export function recordAiAuthoredNote(db: Pool, noteId: string, content: string, agent?: string): void {
  recordAiAuthored(db, 'note', noteId, noteText(content), agent);
}

/** Readable text of a publishing draft (title, summary, body or post copy), without account metadata. */
export function publishingDraftText(content: Record<string, unknown>): string {
  return Object.entries(content)
    .filter(([key, value]) => typeof value === 'string' && !/^account/i.test(key))
    .map(([key, value]) => `## ${key}\n${String(value)}`).join('\n\n').slice(0, MAX_NOTE_CHARS);
}

/** A publishing draft write: an agent's version is snapshotted; a user's save is compared with it. */
export function recordPublishingDraft(db: Pool, draftId: string, content: Record<string, unknown>, byAgent: boolean): void {
  const text = publishingDraftText(content);
  if (byAgent) recordAiAuthored(db, 'publishing-draft', draftId, text, currentAgent() ?? 'publishing');
  else recordUserEdit(db, 'publishing-draft', draftId, text);
}

interface AuthoredRow { id: string; agent: string; workflow_run_id: string | null; content: string }

async function latestAuthored(db: Pool, targetType: string, targetId: string): Promise<AuthoredRow | undefined> {
  const { rows } = await db.query<AuthoredRow>(
    `SELECT id, agent, workflow_run_id, content FROM ai_authored_content
      WHERE target_type = $1 AND target_id = $2 ORDER BY at DESC LIMIT 1`, [targetType, targetId]);
  return rows[0];
}

/**
 * The user saved content an agent wrote: keep one edit record per AI version, updated to the
 * user's latest save, so the weekly review sees the AI version, the final version and the diff.
 */
export function recordUserEdit(db: Pool, targetType: string, targetId: string, finalContent: string): void {
  if (aiWorkflowAttribution() !== undefined) return;
  void (async (): Promise<void> => {
    const authored = await latestAuthored(db, targetType, targetId);
    if (!authored) return;
    if (authored.content === finalContent) {
      await db.query(`DELETE FROM ai_decisions WHERE authored_id = $1 AND kind = 'edit'`, [authored.id]);
      return;
    }
    await db.query(
      `INSERT INTO ai_decisions (environment, agent, kind, target_type, target_id, workflow_run_id, ai_content, final_content, diff, authored_id)
       VALUES ($1,$2,'edit',$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (authored_id) WHERE kind = 'edit' DO UPDATE
         SET final_content = EXCLUDED.final_content, diff = EXCLUDED.diff, updated_at = clock_timestamp(), reviewed_at = NULL`,
      [environment(), authored.agent, targetType, targetId, authored.workflow_run_id, authored.content, finalContent,
        lineDiff(authored.content, finalContent), authored.id],
    );
  })().catch(logFailure('User edit'));
}

export function recordUserNoteEdit(db: Pool, noteId: string, content: string): void {
  recordUserEdit(db, 'note', noteId, noteText(content));
}

export interface DecisionRecord {
  kind: string;
  targetType: string;
  targetId: string;
  /** Defaults to the agent that last wrote the target, else 'athena'. */
  agent?: string | undefined;
  /** Used when the target has no recorded author, so the lesson reaches the agent responsible for that work. */
  fallbackAgent?: string | undefined;
  actor?: 'user' | 'system';
  note?: string | null | undefined;
  aiContent?: string | null | undefined;
  finalContent?: string | null | undefined;
  sessionId?: string | null | undefined;
  workflowRunId?: string | null | undefined;
  details?: Record<string, unknown>;
}

/** Records a decision about AI work, e.g. an approval, a rejection with reasons or an amendment request. */
export function recordAiDecision(db: Pool, d: DecisionRecord): void {
  void (async (): Promise<void> => {
    const authored = d.agent === undefined || d.aiContent === undefined ? await latestAuthored(db, d.targetType, d.targetId) : undefined;
    const agent = d.agent !== undefined ? resolveAgent(d.agent) : authored ? resolveAgent(authored.agent) : d.fallbackAgent !== undefined ? resolveAgent(d.fallbackAgent) : currentAgent() ?? 'athena';
    await db.query(
      `INSERT INTO ai_decisions (environment, agent, kind, actor, target_type, target_id, workflow_run_id, session_id,
         note, ai_content, final_content, diff, details, authored_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
      [environment(), agent, d.kind, d.actor ?? 'user', d.targetType, d.targetId,
        d.workflowRunId ?? authored?.workflow_run_id ?? aiWorkflowAttribution()?.workflowRunId ?? null, d.sessionId ?? null,
        d.note?.trim() || null, d.aiContent ?? authored?.content ?? null, d.finalContent ?? null,
        d.aiContent && d.finalContent ? lineDiff(d.aiContent, d.finalContent) : null,
        safeJson(d.details ?? {}), d.kind === 'edit' ? null : authored?.id ?? null],
    );
  })().catch(logFailure(`Decision ${d.kind}`));
}
