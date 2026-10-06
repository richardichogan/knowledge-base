/**
 * routes/build.ts
 * The Build pipeline: a GHCP spec → dependency-ordered tasks → GitHub cloud
 * agents (Copilot / Claude) → PRs auto-merged when green.
 *
 * GET    /api/build/specs                          list specs with task counts
 * POST   /api/build/specs                          create { title, specMarkdown, repo, baseBranch?, projectId?, maxParallel?, autoMerge? }
 * POST   /api/build/specs/from-note                { noteId, repo, baseBranch? } → spec from a Think note
 * POST   /api/build/specs/from-output              { outputId, repo, baseBranch? } → spec from an Athena chat output
 * GET    /api/build/specs/:id                      spec + tasks
 * PATCH  /api/build/specs/:id                      update title / spec / repo / branch / maxParallel / autoMerge (not while running)
 * DELETE /api/build/specs/:id                      delete (not while running)
 * POST   /api/build/specs/:id/decompose            AI decomposition → replaces tasks (draft/decomposed/failed only)
 * POST   /api/build/specs/:id/start                decomposed|paused → running
 * POST   /api/build/specs/:id/pause                running → paused (in-flight agents keep working)
 * POST   /api/build/specs/:id/sync                 run one runner pass now
 * GET    /api/build/specs/:id/events               activity log
 * PATCH  /api/build/tasks/:id                      { title?, bodyMarkdown?, agent?, model?, dependsOn? } (pending tasks only)
 * POST   /api/build/tasks/:id/retry                blocked/failed → back into the loop
 * POST   /api/build/tasks/:id/cancel               close the issue, mark cancelled (counts as satisfied)
 * POST   /api/build/tasks/:id/merge                merge an awaiting_approval/blocked PR now
 * GET    /api/build/agents?repo=owner/name         which cloud agents can be assigned in that repo
 * GET    /api/build/branches?repo=owner/name       { defaultBranch, branches } (default first)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { HTTP_STATUS } from '../config/constants.js';
import { getDb } from '../db/db.js';
import { ValidationError, NotFoundError, ConflictError } from '../types/errors.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import * as store from '../build/buildStore.js';
import { decomposeSpec, validateTaskGraph, type TaskDraft } from '../build/decompose.js';
import { BUILD_AGENTS, getAgentGitHub, type BuildAgent } from '../build/githubAgents.js';
import { runSpecLocked } from '../build/buildRunner.js';
import type { BuildSpec, BuildTask } from '../build/buildStore.js';

export const buildRouter = Router();

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_SPEC_CHARS = 60_000;
const MAX_TITLE_CHARS = 200;
const MAX_FIELD_CHARS = 500;
const MAX_PARALLEL_LIMIT = 5;
const MIN_SPEC_CHARS = 40;
const EDITABLE_SPEC_STATUSES: readonly store.SpecStatus[] = ['draft', 'decomposed', 'paused', 'failed', 'done'];
const DECOMPOSABLE_STATUSES: readonly store.SpecStatus[] = ['draft', 'decomposed', 'failed'];

type Handler = (req: Request, res: Response) => Promise<void>;
const handle = (fn: Handler) => (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try { await fn(req, res); } catch (err) { next(err); }
  })();
};

const param = (req: Request, name: string): string => req.params[name] as string;
const body = (req: Request): Record<string, unknown> => (typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {});

function str(v: unknown, field: string, { required = false, max = MAX_FIELD_CHARS } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new ValidationError(`${field} is required`, { [field]: 'required' });
    return undefined;
  }
  if (typeof v !== 'string') throw new ValidationError(`${field} must be a string`, { [field]: 'must be a string' });
  const t = v.trim();
  if (required && t === '') throw new ValidationError(`${field} is required`, { [field]: 'required' });
  if (t.length > max) throw new ValidationError(`${field} is too long`, { [field]: `max ${max.toString()} characters` });
  return t;
}

function repoOf(v: unknown, required: boolean): string | undefined {
  const r = str(v, 'repo', { required, max: 200 });
  if (r !== undefined && !REPO_RE.test(r)) throw new ValidationError('repo must be owner/name', { repo: 'expected owner/name' });
  return r;
}

function branchOf(v: unknown): string | undefined {
  const b = str(v, 'baseBranch', { max: 200 });
  if (b !== undefined && !BRANCH_RE.test(b)) throw new ValidationError('Invalid branch name', { baseBranch: 'invalid' });
  return b === '' ? undefined : b;
}

function maxParallelOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_PARALLEL_LIMIT) {
    throw new ValidationError('maxParallel must be 1–5', { maxParallel: '1–5' });
  }
  return v;
}

function boolOf(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`${field} must be true or false`, { [field]: 'boolean' });
  return v;
}

async function requireSpec(id: string): Promise<BuildSpec> {
  const spec = await store.getSpec(id);
  if (spec === null) throw new NotFoundError('Build spec');
  return spec;
}

async function requireTask(id: string): Promise<{ task: BuildTask; spec: BuildSpec }> {
  const task = await store.getTask(id);
  if (task === null) throw new NotFoundError('Build task');
  return { task, spec: await requireSpec(task.specId) };
}

function assertStatus(spec: BuildSpec, allowed: readonly store.SpecStatus[], action: string): void {
  if (!allowed.includes(spec.status)) {
    throw new ConflictError(`Can't ${action} a spec that is ${spec.status}`, 'BUILD_SPEC_STATUS', { status: spec.status });
  }
}

const sendSpec = async (res: Response, id: string, status: number = HTTP_STATUS.OK): Promise<void> => {
  res.status(status).json({ success: true, data: await store.getSpecWithTasks(id) });
};

// ── Specs ──────────────────────────────────────────────────────────────────

buildRouter.get('/specs', handle(async (_req, res) => {
  res.json({ success: true, data: await store.listSpecs() });
}));

buildRouter.post('/specs', handle(async (req, res) => {
  const b = body(req);
  const spec = await store.createSpec({
    title: str(b['title'], 'title', { required: true, max: 200 }) as string,
    specMarkdown: str(b['specMarkdown'], 'specMarkdown', { max: MAX_SPEC_CHARS }) ?? '',
    repo: repoOf(b['repo'], true) as string,
    baseBranch: branchOf(b['baseBranch']),
    projectId: str(b['projectId'], 'projectId', { max: 100 }) ?? null,
    maxParallel: maxParallelOf(b['maxParallel']),
    autoMerge: boolOf(b['autoMerge'], 'autoMerge'),
  });
  await store.addEvent(spec.id, null, 'created', 'Spec created');
  await sendSpec(res, spec.id, HTTP_STATUS.CREATED);
}));

buildRouter.post('/specs/from-note', handle(async (req, res) => {
  const b = body(req);
  const noteId = str(b['noteId'], 'noteId', { required: true, max: 100 }) as string;
  const db = getDb();
  const { rows } = await db.query<{ content: string; project_id: string | null }>(
    `SELECT content, project_id FROM notes WHERE id::text = $1 AND status = 'active'`, [noteId]);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Note');
  const text = (await renderNoteAsText(db, row.content)).trim();
  const firstLine = text.split('\n').find((l) => l.trim() !== '')?.replace(/^#+\s*/, '').trim() ?? 'Untitled spec';
  const spec = await store.createSpec({
    title: firstLine.slice(0, MAX_TITLE_CHARS), specMarkdown: text.slice(0, MAX_SPEC_CHARS),
    repo: repoOf(b['repo'], true) as string, baseBranch: branchOf(b['baseBranch']),
    projectId: row.project_id, noteId,
  });
  await store.addEvent(spec.id, null, 'created', 'Spec created from a Think note');
  await sendSpec(res, spec.id, HTTP_STATUS.CREATED);
}));

buildRouter.post('/specs/from-output', handle(async (req, res) => {
  const b = body(req);
  const outputId = str(b['outputId'], 'outputId', { required: true, max: 100 }) as string;
  const { rows } = await getDb().query<{ title: string; content: string }>(
    `SELECT o.title, v.content
       FROM chat_outputs o
       JOIN LATERAL (SELECT content FROM chat_output_versions WHERE output_id = o.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE o.id::text = $1`, [outputId]);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Chat output');
  const spec = await store.createSpec({
    title: row.title.slice(0, MAX_TITLE_CHARS), specMarkdown: row.content.slice(0, MAX_SPEC_CHARS),
    repo: repoOf(b['repo'], true) as string, baseBranch: branchOf(b['baseBranch']),
    projectId: str(b['projectId'], 'projectId', { max: 100 }) ?? null, chatOutputId: outputId,
  });
  await store.addEvent(spec.id, null, 'created', 'Spec created from an Athena output');
  await sendSpec(res, spec.id, HTTP_STATUS.CREATED);
}));

buildRouter.get('/specs/:id', handle(async (req, res) => {
  const spec = await store.getSpecWithTasks(param(req, 'id'));
  if (spec === null) throw new NotFoundError('Build spec');
  res.json({ success: true, data: spec });
}));

buildRouter.patch('/specs/:id', handle(async (req, res) => {
  const spec = await requireSpec(param(req, 'id'));
  assertStatus(spec, EDITABLE_SPEC_STATUSES, 'edit');
  const b = body(req);
  const patch: Partial<BuildSpec> = {};
  const title = str(b['title'], 'title', { max: 200 });
  if (title !== undefined) {
    if (title === '') throw new ValidationError('title is required', { title: 'required' });
    patch.title = title;
  }
  const md = str(b['specMarkdown'], 'specMarkdown', { max: MAX_SPEC_CHARS });
  if (md !== undefined) patch.specMarkdown = md;
  const repo = repoOf(b['repo'], false);
  if (repo !== undefined) patch.repo = repo;
  const branch = branchOf(b['baseBranch']);
  if (branch !== undefined) patch.baseBranch = branch;
  const mp = maxParallelOf(b['maxParallel']);
  if (mp !== undefined) patch.maxParallel = mp;
  const am = boolOf(b['autoMerge'], 'autoMerge');
  if (am !== undefined) patch.autoMerge = am;
  if ('projectId' in b) patch.projectId = str(b['projectId'], 'projectId', { max: 100 }) || null;
  await store.updateSpec(spec.id, patch);
  await sendSpec(res, spec.id);
}));

buildRouter.delete('/specs/:id', handle(async (req, res) => {
  const spec = await requireSpec(param(req, 'id'));
  if (spec.status === 'running' || spec.status === 'decomposing') {
    throw new ConflictError('Pause the build before deleting it', 'BUILD_SPEC_STATUS', { status: spec.status });
  }
  await store.deleteSpec(spec.id);
  res.json({ success: true, data: { id: spec.id } });
}));

buildRouter.post('/specs/:id/decompose', handle(async (req, res) => {
  const spec = await requireSpec(param(req, 'id'));
  assertStatus(spec, DECOMPOSABLE_STATUSES, 'decompose');
  if (spec.specMarkdown.trim().length < MIN_SPEC_CHARS) {
    throw new ValidationError('Write the spec before decomposing it', { specMarkdown: 'too short' });
  }
  await store.updateSpec(spec.id, { status: 'decomposing', lastError: null });
  try {
    const context = str(body(req)['context'], 'context', { max: 4000 });
    const result = await decomposeSpec({ title: spec.title, specMarkdown: spec.specMarkdown, repo: spec.repo, context });
    await store.replaceTasks(spec.id, result.tasks);
    await store.updateSpec(spec.id, { status: 'decomposed', planNotes: result.planNotes });
    await store.addEvent(spec.id, null, 'decomposed', `Decomposed into ${result.tasks.length.toString()} tasks`,
      { reviewNotes: result.reviewNotes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.updateSpec(spec.id, { status: 'failed', lastError: `Decomposition failed: ${message}` });
    await store.addEvent(spec.id, null, 'error', `Decomposition failed: ${message}`);
    throw err;
  }
  await sendSpec(res, spec.id);
}));

buildRouter.post('/specs/:id/start', handle(async (req, res) => {
  const spec = await requireSpec(param(req, 'id'));
  assertStatus(spec, ['decomposed', 'paused'], 'start');
  const tasks = await store.listTasks(spec.id);
  if (tasks.length === 0) throw new ValidationError('Decompose the spec first', { tasks: 'none' });
  const available = await getAgentGitHub().listAvailableAgents(spec.repo);
  const missing = [...new Set(tasks.filter((t) => t.status === 'pending').map((t) => t.agent))].filter((a) => !available.includes(a));
  if (missing.length > 0) {
    throw new ConflictError(
      `${missing.join(' and ')} can't be assigned in ${spec.repo} — enable the agent for the repo or switch those tasks`,
      'BUILD_AGENT_UNAVAILABLE', { missing: missing.join(',') });
  }
  await store.updateSpec(spec.id, { status: 'running', lastError: null });
  await store.addEvent(spec.id, null, 'started', spec.status === 'paused' ? 'Resumed' : 'Started');
  await runSpecLocked(spec.id);
  await sendSpec(res, spec.id);
}));

buildRouter.post('/specs/:id/pause', handle(async (req, res) => {
  const spec = await requireSpec(param(req, 'id'));
  assertStatus(spec, ['running'], 'pause');
  await store.updateSpec(spec.id, { status: 'paused' });
  await store.addEvent(spec.id, null, 'paused', 'Paused — agents already working will finish, nothing new is dispatched or merged');
  await sendSpec(res, spec.id);
}));

buildRouter.post('/specs/:id/sync', handle(async (req, res) => {
  const spec = await requireSpec(param(req, 'id'));
  await runSpecLocked(spec.id);
  await sendSpec(res, spec.id);
}));

buildRouter.get('/specs/:id/events', handle(async (req, res) => {
  const spec = await requireSpec(param(req, 'id'));
  res.json({ success: true, data: await store.listEvents(spec.id) });
}));

// ── Tasks ──────────────────────────────────────────────────────────────────

buildRouter.patch('/tasks/:id', handle(async (req, res) => {
  const { task, spec } = await requireTask(param(req, 'id'));
  if (task.status !== 'pending') {
    throw new ConflictError('Only tasks that haven\'t been dispatched can be edited', 'BUILD_TASK_STATUS', { status: task.status });
  }
  const b = body(req);
  const patch: Partial<BuildTask> = {};
  const title = str(b['title'], 'title', { max: 200 });
  if (title !== undefined && title !== '') patch.title = title;
  const md = str(b['bodyMarkdown'], 'bodyMarkdown', { max: 20_000 });
  if (md !== undefined) patch.bodyMarkdown = md;
  if (b['agent'] !== undefined) {
    if (!BUILD_AGENTS.includes(b['agent'] as BuildAgent)) throw new ValidationError('Unknown agent', { agent: BUILD_AGENTS.join(' | ') });
    patch.agent = b['agent'] as BuildAgent;
  }
  const model = str(b['model'], 'model', { max: 100 });
  if (model !== undefined) patch.model = model;
  if (b['dependsOn'] !== undefined) {
    const deps = b['dependsOn'];
    if (!Array.isArray(deps) || !deps.every((d): d is string => typeof d === 'string')) {
      throw new ValidationError('dependsOn must be a list of task ids', { dependsOn: 'string[]' });
    }
    const all = await store.listTasks(spec.id);
    const drafts: TaskDraft[] = all.map((t) => ({
      key: t.id, title: t.title, body: t.bodyMarkdown, agent: t.agent, agentReason: t.agentReason, size: t.size,
      dependsOn: t.id === task.id ? deps : t.dependsOn,
    }));
    try { validateTaskGraph(drafts); } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : 'Invalid dependencies', { dependsOn: 'invalid' });
    }
    patch.dependsOn = [...new Set(deps)];
  }
  await store.updateTask(task.id, patch);
  await sendSpec(res, spec.id);
}));

buildRouter.post('/tasks/:id/retry', handle(async (req, res) => {
  const { task, spec } = await requireTask(param(req, 'id'));
  if (task.status !== 'blocked' && task.status !== 'failed' && task.status !== 'awaiting_approval') {
    throw new ConflictError('Only blocked, failed or waiting tasks can be retried', 'BUILD_TASK_STATUS', { status: task.status });
  }
  const reset = { fixAttempts: 0, nudgedSha: null, nudgedAt: null, doneSeenAt: null, lastError: null };
  if (task.prNumber !== null) {
    await store.updateTask(task.id, { ...reset, status: 'pr_open' });
  } else if (task.issueNumber !== null) {
    await store.updateTask(task.id, { ...reset, status: 'dispatched', dispatchedAt: new Date().toISOString() });
  } else {
    await store.updateTask(task.id, { ...reset, status: 'pending' });
  }
  await store.addEvent(spec.id, task.id, 'retry', `${task.title}: retried`);
  await sendSpec(res, spec.id);
}));

buildRouter.post('/tasks/:id/cancel', handle(async (req, res) => {
  const { task, spec } = await requireTask(param(req, 'id'));
  if (task.status === 'merged' || task.status === 'cancelled') {
    throw new ConflictError(`Task is already ${task.status}`, 'BUILD_TASK_STATUS', { status: task.status });
  }
  if (task.issueNumber !== null) await getAgentGitHub().closeIssue(spec.repo, task.issueNumber).catch(() => undefined);
  await store.updateTask(task.id, { status: 'cancelled' });
  await store.addEvent(spec.id, task.id, 'cancelled', `${task.title}: cancelled — dependent tasks will proceed without it`);
  await sendSpec(res, spec.id);
}));

buildRouter.post('/tasks/:id/merge', handle(async (req, res) => {
  const { task, spec } = await requireTask(param(req, 'id'));
  if (task.prNumber === null || (task.status !== 'awaiting_approval' && task.status !== 'blocked' && task.status !== 'pr_open')) {
    throw new ConflictError('There is no open PR to merge for this task', 'BUILD_TASK_STATUS', { status: task.status });
  }
  const gh = getAgentGitHub();
  const pr = await gh.getPullRequest(spec.repo, task.prNumber);
  if (!pr.merged) {
    if (pr.state === 'closed') throw new ConflictError('The PR is closed', 'BUILD_PR_CLOSED', {});
    if (pr.draft) await gh.markReadyForReview(spec.repo, pr.number);
    await gh.mergePullRequest(spec.repo, pr.number, task.title);
    await gh.deleteBranch(spec.repo, pr.headRef).catch(() => undefined);
  }
  await store.updateTask(task.id, { status: 'merged', mergedAt: new Date().toISOString(), lastError: null });
  await store.addEvent(spec.id, task.id, 'merged', `${task.title}: merged #${pr.number.toString()} (manual)`, { pr: pr.number });
  if (spec.status === 'running') await runSpecLocked(spec.id);
  await sendSpec(res, spec.id);
}));

buildRouter.get('/agents', handle(async (req, res) => {
  const repo = repoOf(req.query['repo'], true) as string;
  res.json({ success: true, data: await getAgentGitHub().listAvailableAgents(repo) });
}));

buildRouter.get('/branches', handle(async (req, res) => {
  const repo = repoOf(req.query['repo'], true) as string;
  res.json({ success: true, data: await getAgentGitHub().listBranches(repo) });
}));
