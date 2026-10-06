/**
 * build/buildStore.ts
 * Postgres access for build_specs / build_tasks / build_events (migration 056).
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDb } from '../db/db.js';
import type { BuildAgent } from './githubAgents.js';
import type { TaskDraft, TaskSize } from './decompose.js';

export const SPEC_STATUSES = ['draft', 'decomposing', 'decomposed', 'running', 'paused', 'done', 'failed'] as const;
export type SpecStatus = typeof SPEC_STATUSES[number];
export const TASK_STATUSES = ['pending', 'dispatched', 'pr_open', 'awaiting_approval', 'merged', 'blocked', 'failed', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

/** Statuses where an agent is working (each holds one of the spec's parallel slots). */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['dispatched', 'pr_open'];
/** Statuses that satisfy a dependency (cancelled = the user chose to skip it). */
export const SATISFIED_TASK_STATUSES: readonly TaskStatus[] = ['merged', 'cancelled'];

const DEFAULT_MAX_PARALLEL = 2;
const MAX_EVENT_MESSAGE_CHARS = 2_000;
const DEFAULT_EVENT_LIMIT = 200;

export interface BuildSpec {
  id: string;
  projectId: string | null;
  noteId: string | null;
  chatOutputId: string | null;
  title: string;
  specMarkdown: string;
  repo: string;
  /** Target branch: the integration branch is cut from it and the final PR goes back into it. */
  baseBranch: string;
  /** Work on a dedicated build/<slug> integration branch (created on start). */
  useWorkBranch: boolean;
  workBranch: string | null;
  finalPrNumber: number | null;
  finalPrUrl: string | null;
  finalPrMergedAt: string | null;
  status: SpecStatus;
  maxParallel: number;
  autoMerge: boolean;
  planNotes: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildTask {
  id: string;
  specId: string;
  seq: number;
  title: string;
  bodyMarkdown: string;
  agent: BuildAgent;
  agentReason: string;
  model: string;
  size: TaskSize;
  dependsOn: string[];
  status: TaskStatus;
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  headSha: string | null;
  nudgedSha: string | null;
  nudgedAt: string | null;
  doneSeenAt: string | null;
  fixAttempts: number;
  lastError: string | null;
  dispatchedAt: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildEvent {
  id: string;
  specId: string;
  taskId: string | null;
  kind: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BuildSpecWithTasks extends BuildSpec { tasks: BuildTask[] }
export interface BuildSpecSummary extends BuildSpec { taskCounts: Partial<Record<TaskStatus, number>>; taskTotal: number }

type Row = Record<string, unknown>;
type Db = Pool | PoolClient;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

function toSpec(r: Row): BuildSpec {
  return {
    id: r['id'] as string,
    projectId: (r['project_id'] as string | null) ?? null,
    noteId: (r['note_id'] as string | null) ?? null,
    chatOutputId: (r['chat_output_id'] as string | null) ?? null,
    title: r['title'] as string,
    specMarkdown: r['spec_markdown'] as string,
    repo: r['repo'] as string,
    baseBranch: r['base_branch'] as string,
    useWorkBranch: (r['use_work_branch'] as boolean | null) ?? true,
    workBranch: (r['work_branch'] as string | null) ?? null,
    finalPrNumber: (r['final_pr_number'] as number | null) ?? null,
    finalPrUrl: (r['final_pr_url'] as string | null) ?? null,
    finalPrMergedAt: iso(r['final_pr_merged_at']),
    status: r['status'] as SpecStatus,
    maxParallel: r['max_parallel'] as number,
    autoMerge: r['auto_merge'] as boolean,
    planNotes: r['plan_notes'] as string,
    lastError: (r['last_error'] as string | null) ?? null,
    createdAt: iso(r['created_at']) ?? '',
    updatedAt: iso(r['updated_at']) ?? '',
  };
}

function toTask(r: Row): BuildTask {
  return {
    id: r['id'] as string,
    specId: r['spec_id'] as string,
    seq: r['seq'] as number,
    title: r['title'] as string,
    bodyMarkdown: r['body_markdown'] as string,
    agent: r['agent'] as BuildAgent,
    agentReason: r['agent_reason'] as string,
    model: r['model'] as string,
    size: r['size'] as TaskSize,
    dependsOn: (r['depends_on'] as string[] | null) ?? [],
    status: r['status'] as TaskStatus,
    issueNumber: (r['issue_number'] as number | null) ?? null,
    issueUrl: (r['issue_url'] as string | null) ?? null,
    prNumber: (r['pr_number'] as number | null) ?? null,
    prUrl: (r['pr_url'] as string | null) ?? null,
    branch: (r['branch'] as string | null) ?? null,
    headSha: (r['head_sha'] as string | null) ?? null,
    nudgedSha: (r['nudged_sha'] as string | null) ?? null,
    nudgedAt: iso(r['nudged_at']),
    doneSeenAt: iso(r['done_seen_at']),
    fixAttempts: r['fix_attempts'] as number,
    lastError: (r['last_error'] as string | null) ?? null,
    dispatchedAt: iso(r['dispatched_at']),
    mergedAt: iso(r['merged_at']),
    createdAt: iso(r['created_at']) ?? '',
    updatedAt: iso(r['updated_at']) ?? '',
  };
}

export async function listSpecs(db: Db = getDb()): Promise<BuildSpecSummary[]> {
  const { rows } = await db.query<Row>(
    `SELECT s.*, COALESCE(c.counts, '{}'::jsonb) AS task_counts, COALESCE(c.total, 0)::int AS task_total
       FROM build_specs s
       LEFT JOIN (
         SELECT spec_id, jsonb_object_agg(status, n) AS counts, SUM(n) AS total
           FROM (SELECT spec_id, status, COUNT(*)::int AS n FROM build_tasks GROUP BY spec_id, status) x
          GROUP BY spec_id
       ) c ON c.spec_id = s.id
      ORDER BY s.updated_at DESC`,
  );
  return rows.map((r) => ({
    ...toSpec(r),
    taskCounts: r['task_counts'] as Partial<Record<TaskStatus, number>>,
    taskTotal: r['task_total'] as number,
  }));
}

export async function getSpec(id: string, db: Db = getDb()): Promise<BuildSpec | null> {
  const { rows } = await db.query<Row>('SELECT * FROM build_specs WHERE id = $1', [id]);
  return rows[0] === undefined ? null : toSpec(rows[0]);
}

export async function listTasks(specId: string, db: Db = getDb()): Promise<BuildTask[]> {
  const { rows } = await db.query<Row>('SELECT * FROM build_tasks WHERE spec_id = $1 ORDER BY seq', [specId]);
  return rows.map(toTask);
}

export async function getSpecWithTasks(id: string, db: Db = getDb()): Promise<BuildSpecWithTasks | null> {
  const spec = await getSpec(id, db);
  return spec === null ? null : { ...spec, tasks: await listTasks(id, db) };
}

export async function getTask(id: string, db: Db = getDb()): Promise<BuildTask | null> {
  const { rows } = await db.query<Row>('SELECT * FROM build_tasks WHERE id = $1', [id]);
  return rows[0] === undefined ? null : toTask(rows[0]);
}

export interface CreateSpecInput {
  title: string; specMarkdown: string; repo: string; baseBranch?: string | undefined;
  projectId?: string | null | undefined; noteId?: string | null | undefined; chatOutputId?: string | null | undefined;
  maxParallel?: number | undefined; autoMerge?: boolean | undefined; useWorkBranch?: boolean | undefined;
}

export async function createSpec(input: CreateSpecInput, db: Db = getDb()): Promise<BuildSpec> {
  const { rows } = await db.query<Row>(
    `INSERT INTO build_specs (title, spec_markdown, repo, base_branch, project_id, note_id, chat_output_id, max_parallel, auto_merge, use_work_branch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [input.title, input.specMarkdown, input.repo, input.baseBranch ?? 'main', input.projectId ?? null,
      input.noteId ?? null, input.chatOutputId ?? null, input.maxParallel ?? DEFAULT_MAX_PARALLEL, input.autoMerge ?? true,
      input.useWorkBranch ?? true],
  );
  return toSpec(rows[0] as Row);
}

const SPEC_COLUMNS: Record<string, string> = {
  title: 'title', specMarkdown: 'spec_markdown', repo: 'repo', baseBranch: 'base_branch', projectId: 'project_id',
  status: 'status', maxParallel: 'max_parallel', autoMerge: 'auto_merge', planNotes: 'plan_notes', lastError: 'last_error',
  useWorkBranch: 'use_work_branch', workBranch: 'work_branch', finalPrNumber: 'final_pr_number', finalPrUrl: 'final_pr_url',
  finalPrMergedAt: 'final_pr_merged_at',
};

/** Branch the agents target: the integration branch once created, else the base branch. */
export const targetBranchOf = (spec: Pick<BuildSpec, 'workBranch' | 'baseBranch'>): string => spec.workBranch ?? spec.baseBranch;

/** Specs that are done but whose final PR hasn't been merged yet (the runner watches these too). */
export async function listAwaitingFinalMergeIds(db: Db = getDb()): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM build_specs WHERE status = 'done' AND final_pr_number IS NOT NULL AND final_pr_merged_at IS NULL ORDER BY updated_at",
  );
  return rows.map((r) => r.id);
}

export async function updateSpec(id: string, patch: Partial<BuildSpec>, db: Db = getDb()): Promise<BuildSpec | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(SPEC_COLUMNS)) {
    if (key in patch) { values.push((patch as Record<string, unknown>)[key]); sets.push(`${column} = $${values.length}`); }
  }
  if (sets.length === 0) return getSpec(id, db);
  values.push(id);
  const { rows } = await db.query<Row>(
    `UPDATE build_specs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values,
  );
  return rows[0] === undefined ? null : toSpec(rows[0]);
}

export async function deleteSpec(id: string, db: Db = getDb()): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM build_specs WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

const TASK_COLUMNS: Record<string, string> = {
  title: 'title', bodyMarkdown: 'body_markdown', agent: 'agent', agentReason: 'agent_reason', model: 'model', size: 'size',
  dependsOn: 'depends_on', status: 'status', issueNumber: 'issue_number', issueUrl: 'issue_url', prNumber: 'pr_number',
  prUrl: 'pr_url', branch: 'branch', headSha: 'head_sha', nudgedSha: 'nudged_sha', nudgedAt: 'nudged_at',
  doneSeenAt: 'done_seen_at', fixAttempts: 'fix_attempts', lastError: 'last_error', dispatchedAt: 'dispatched_at',
  mergedAt: 'merged_at',
};

export async function updateTask(id: string, patch: Partial<BuildTask>, db: Db = getDb()): Promise<BuildTask | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(TASK_COLUMNS)) {
    if (key in patch) { values.push((patch as Record<string, unknown>)[key]); sets.push(`${column} = $${values.length}`); }
  }
  if (sets.length === 0) return getTask(id, db);
  values.push(id);
  const { rows } = await db.query<Row>(
    `UPDATE build_tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values,
  );
  return rows[0] === undefined ? null : toTask(rows[0]);
}

/** Replaces all tasks of a spec with validated, topologically ordered drafts (keys → new uuids). */
export async function replaceTasks(specId: string, drafts: TaskDraft[], pool: Pool = getDb()): Promise<BuildTask[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM build_tasks WHERE spec_id = $1', [specId]);
    const idByKey = new Map<string, string>(drafts.map((d) => [d.key, randomUUID()]));
    for (const [i, d] of drafts.entries()) {
      await client.query(
        `INSERT INTO build_tasks (id, spec_id, seq, title, body_markdown, agent, agent_reason, size, depends_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [idByKey.get(d.key), specId, i + 1, d.title, d.body, d.agent, d.agentReason, d.size,
          d.dependsOn.map((k) => idByKey.get(k)).filter((v): v is string => v !== undefined)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return listTasks(specId, pool);
}

export async function addEvent(
  specId: string, taskId: string | null, kind: string, message: string, payload: Record<string, unknown> = {}, db: Db = getDb(),
): Promise<void> {
  await db.query(
    'INSERT INTO build_events (spec_id, task_id, kind, message, payload) VALUES ($1, $2, $3, $4, $5)',
    [specId, taskId, kind, message.slice(0, MAX_EVENT_MESSAGE_CHARS), JSON.stringify(payload)],
  );
}

export async function listEvents(specId: string, limit = DEFAULT_EVENT_LIMIT, db: Db = getDb()): Promise<BuildEvent[]> {
  const { rows } = await db.query<Row>(
    'SELECT * FROM build_events WHERE spec_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [specId, limit],
  );
  return rows.map((r) => ({
    id: String(r['id']),
    specId: r['spec_id'] as string,
    taskId: (r['task_id'] as string | null) ?? null,
    kind: r['kind'] as string,
    message: r['message'] as string,
    payload: (r['payload'] as Record<string, unknown> | null) ?? {},
    createdAt: iso(r['created_at']) ?? '',
  }));
}

export async function listRunningSpecIds(db: Db = getDb()): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM build_specs WHERE status = 'running' ORDER BY updated_at");
  return rows.map((r) => r.id);
}

/**
 * Atomically moves a task from `from` to `to`. Returns false when another
 * runner (or a user action) changed it first — prevents double dispatch.
 */
export async function claimTask(id: string, from: TaskStatus, to: TaskStatus, db: Db = getDb()): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE build_tasks SET status = $3, updated_at = NOW() WHERE id = $1 AND status = $2', [id, from, to],
  );
  return (rowCount ?? 0) > 0;
}
