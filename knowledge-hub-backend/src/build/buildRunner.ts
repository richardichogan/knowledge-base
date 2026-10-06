/**
 * build/buildRunner.ts
 * Drives running build specs: dispatches ready tasks to cloud agents, follows
 * each agent's PR, asks the agent to fix failing checks / conflicts, squash-
 * merges green PRs and releases dependent tasks.
 *
 * Safety rails:
 *  - auto-merge only when at least one check ran and every check passed;
 *  - PRs touching .github/workflows/** always wait for the user;
 *  - at most MAX_FIX_ATTEMPTS fix requests per task, then it's blocked;
 *  - a failed merge call (e.g. branch protection) blocks the task, never retries blindly;
 *  - tasks are claimed atomically before dispatch so two runners can't double-dispatch.
 */
import { env } from '../config/env.js';
import { AGENT_MENTION, getAgentGitHub, type AgentGitHub, type AgentPullRequest } from './githubAgents.js';
import * as store from './buildStore.js';
import {
  ACTIVE_TASK_STATUSES, SATISFIED_TASK_STATUSES, targetBranchOf,
  type BuildSpec, type BuildTask, type TaskStatus,
} from './buildStore.js';

export const MAX_FIX_ATTEMPTS = 2;
const MINUTE = 60_000;
/* eslint-disable @typescript-eslint/no-magic-numbers -- timeouts read best as minutes */
/** Agent should open its (draft) PR within minutes of assignment. */
export const NO_PR_TIMEOUT_MS = 120 * MINUTE;
/** How long to wait for the agent to push after a fix request. */
export const NUDGE_TIMEOUT_MS = 180 * MINUTE;
/** How long to wait for CI to appear once the agent has finished. */
export const CHECKS_GRACE_MS = 15 * MINUTE;
/* eslint-enable @typescript-eslint/no-magic-numbers */

export interface RunnerStore {
  getSpec(id: string): Promise<BuildSpec | null>;
  listTasks(specId: string): Promise<BuildTask[]>;
  updateTask(id: string, patch: Partial<BuildTask>): Promise<BuildTask | null>;
  updateSpec(id: string, patch: Partial<BuildSpec>): Promise<BuildSpec | null>;
  claimTask(id: string, from: TaskStatus, to: TaskStatus): Promise<boolean>;
  addEvent(specId: string, taskId: string | null, kind: string, message: string, payload?: Record<string, unknown>): Promise<void>;
}

export interface RunnerDeps { gh: AgentGitHub; store: RunnerStore; now: () => Date }

const defaultStore: RunnerStore = {
  getSpec: (id) => store.getSpec(id),
  listTasks: (specId) => store.listTasks(specId),
  updateTask: (id, patch) => store.updateTask(id, patch),
  updateSpec: (id, patch) => store.updateSpec(id, patch),
  claimTask: (id, from, to) => store.claimTask(id, from, to),
  addEvent: (specId, taskId, kind, message, payload) => store.addEvent(specId, taskId, kind, message, payload),
};

function defaultDeps(): RunnerDeps {
  return { gh: getAgentGitHub(), store: defaultStore, now: () => new Date() };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const elapsed = (deps: RunnerDeps, since: string | null): number => (since === null ? 0 : deps.now().getTime() - new Date(since).getTime());

function taskIssueBody(spec: BuildSpec, task: BuildTask, all: BuildTask[]): string {
  const deps = all.filter((t) => task.dependsOn.includes(t.id));
  const lines = [
    task.bodyMarkdown,
    '',
    '---',
    `_Task ${task.seq.toString()} of ${all.length.toString()} in build spec **${spec.title}**, orchestrated by Knowledge Hub._`,
  ];
  if (deps.length > 0) {
    lines.push('', `Already merged into \`${targetBranchOf(spec)}\` (build on these, do not redo them):`);
    for (const d of deps) lines.push(`- ${d.title}${d.prNumber !== null ? ` (#${d.prNumber.toString()})` : ''}`);
  }
  lines.push('', `Open exactly one pull request against \`${targetBranchOf(spec)}\` that implements only this task.`);
  return lines.join('\n');
}

const CUSTOM_INSTRUCTIONS =
  'Follow the repository\'s existing conventions and any copilot-instructions / AGENTS.md files. ' +
  'Keep the pull request focused on this issue only. Run the project\'s type-check, lint and tests before finishing, ' +
  'and fix anything you broke.';

async function block(deps: RunnerDeps, spec: BuildSpec, task: BuildTask, reason: string, status: TaskStatus = 'blocked'): Promise<void> {
  await deps.store.updateTask(task.id, { status, lastError: reason });
  await deps.store.addEvent(spec.id, task.id, status, `${task.title}: ${reason}`);
}

async function awaitApproval(deps: RunnerDeps, spec: BuildSpec, task: BuildTask, reason: string): Promise<void> {
  await deps.store.updateTask(task.id, { status: 'awaiting_approval', lastError: reason });
  await deps.store.addEvent(spec.id, task.id, 'awaiting_approval', `${task.title}: ${reason}`);
}

/** Asks the agent (by PR comment mention) to fix something, or blocks once attempts run out. */
async function nudge(deps: RunnerDeps, spec: BuildSpec, task: BuildTask, pr: AgentPullRequest, reason: string): Promise<void> {
  if (task.fixAttempts >= MAX_FIX_ATTEMPTS) {
    await block(deps, spec, task, `${reason} — still failing after ${MAX_FIX_ATTEMPTS.toString()} fix requests`);
    return;
  }
  await deps.gh.comment(spec.repo, pr.number, `${AGENT_MENTION[task.agent]} ${reason}. Please fix this on the same branch and push.`);
  await deps.store.updateTask(task.id, {
    nudgedSha: pr.headSha, nudgedAt: deps.now().toISOString(), fixAttempts: task.fixAttempts + 1, doneSeenAt: null, lastError: reason,
  });
  await deps.store.addEvent(spec.id, task.id, 'fix_requested', `${task.title}: asked ${task.agent} to fix — ${reason}`, { pr: pr.number });
}

async function mergeTask(deps: RunnerDeps, spec: BuildSpec, task: BuildTask, pr: AgentPullRequest): Promise<void> {
  try {
    if (pr.draft) await deps.gh.markReadyForReview(spec.repo, pr.number);
    await deps.gh.mergePullRequest(spec.repo, pr.number, task.title);
  } catch (err) {
    await block(deps, spec, task, `Merge failed: ${errMsg(err)}`);
    return;
  }
  await deps.store.updateTask(task.id, { status: 'merged', mergedAt: deps.now().toISOString(), lastError: null });
  await deps.store.addEvent(spec.id, task.id, 'merged', `${task.title}: merged #${pr.number.toString()}`, { pr: pr.number });
  await deps.gh.deleteBranch(spec.repo, pr.headRef).catch(() => undefined);
}

async function followDispatched(deps: RunnerDeps, spec: BuildSpec, task: BuildTask): Promise<void> {
  if (task.issueNumber === null) { await block(deps, spec, task, 'Dispatched without an issue number'); return; }
  const pr = await deps.gh.findPullRequestForIssue(spec.repo, task.issueNumber);
  if (pr === null) {
    if (elapsed(deps, task.dispatchedAt) > NO_PR_TIMEOUT_MS) {
      await block(deps, spec, task, 'The agent has not opened a pull request — check the issue on GitHub');
    }
    return;
  }
  await deps.store.updateTask(task.id, {
    status: 'pr_open', prNumber: pr.number, prUrl: pr.htmlUrl, branch: pr.headRef, headSha: pr.headSha,
  });
  await deps.store.addEvent(spec.id, task.id, 'pr_open', `${task.title}: ${task.agent} opened #${pr.number.toString()}`, { pr: pr.number, url: pr.htmlUrl });
}

/** Evaluates an open PR (or one awaiting approval, which only watches for an external merge/close). */
async function followPullRequest(deps: RunnerDeps, spec: BuildSpec, task: BuildTask): Promise<void> {
  if (task.prNumber === null) { await block(deps, spec, task, 'Missing PR number'); return; }
  const pr = await deps.gh.getPullRequest(spec.repo, task.prNumber);
  if (pr.headSha !== task.headSha) await deps.store.updateTask(task.id, { headSha: pr.headSha, branch: pr.headRef });

  if (pr.merged) {
    await deps.store.updateTask(task.id, { status: 'merged', mergedAt: deps.now().toISOString(), lastError: null });
    await deps.store.addEvent(spec.id, task.id, 'merged', `${task.title}: #${pr.number.toString()} was merged on GitHub`, { pr: pr.number });
    return;
  }
  if (pr.state === 'closed') { await block(deps, spec, task, `PR #${pr.number.toString()} was closed without merging`); return; }
  if (task.status === 'awaiting_approval') return;

  const activity = await deps.gh.getAgentActivity(spec.repo, pr.number);
  if (activity.working) {
    if (task.doneSeenAt !== null) await deps.store.updateTask(task.id, { doneSeenAt: null });
    return;
  }
  // Draft with no "finished" signal yet → the agent is still going.
  if (pr.draft && activity.lastFinishedAt === null) return;

  if (task.nudgedSha !== null && pr.headSha === task.nudgedSha) {
    const respondedWithoutCommit = activity.lastFinishedAt !== null && task.nudgedAt !== null
      && new Date(activity.lastFinishedAt).getTime() > new Date(task.nudgedAt).getTime();
    if (!respondedWithoutCommit) {
      if (elapsed(deps, task.nudgedAt) > NUDGE_TIMEOUT_MS) await block(deps, spec, task, 'The agent did not push a fix');
      return;
    }
  }

  const doneSeenAt = task.doneSeenAt ?? deps.now().toISOString();
  if (task.doneSeenAt === null) await deps.store.updateTask(task.id, { doneSeenAt });

  const checks = await deps.gh.getChecks(spec.repo, pr.headSha);
  if (checks.pending > 0) return;
  if (checks.failed > 0) {
    await nudge(deps, spec, { ...task, doneSeenAt }, pr, `These checks are failing: ${checks.failedNames.join(', ')}`);
    return;
  }
  if (pr.mergeableState === 'dirty') {
    const target = targetBranchOf(spec);
    await nudge(deps, spec, { ...task, doneSeenAt }, pr,
      `This branch has merge conflicts with \`${target}\`. Merge \`${target}\` into it and resolve the conflicts`);
    return;
  }
  if (checks.total === 0) {
    if (elapsed(deps, doneSeenAt) < CHECKS_GRACE_MS) return;
    await awaitApproval(deps, spec, task,
      'No CI checks ran on this PR (workflows may need approval for agent PRs) — review and merge manually');
    return;
  }
  if (pr.changedFiles.some((f) => f.startsWith('.github/workflows/'))) {
    await awaitApproval(deps, spec, task, 'Changes GitHub Actions workflows — needs your review');
    return;
  }
  if (!spec.autoMerge) { await awaitApproval(deps, spec, task, 'Checks passed — auto-merge is off'); return; }
  if (pr.mergeableState === 'unknown') return;
  await mergeTask(deps, spec, task, pr);
}

async function dispatch(deps: RunnerDeps, spec: BuildSpec, task: BuildTask, all: BuildTask[]): Promise<boolean> {
  if (!await deps.store.claimTask(task.id, 'pending', 'dispatched')) return false;
  try {
    const issue = await deps.gh.createAgentIssue({
      repo: spec.repo, title: task.title, body: taskIssueBody(spec, task, all), agent: task.agent,
      baseRef: targetBranchOf(spec), model: task.model, customInstructions: CUSTOM_INSTRUCTIONS,
    });
    await deps.store.updateTask(task.id, {
      issueNumber: issue.number, issueUrl: issue.url, dispatchedAt: deps.now().toISOString(), lastError: null,
    });
    await deps.store.addEvent(spec.id, task.id, 'dispatched', `${task.title}: assigned to ${task.agent} as #${issue.number.toString()}`, { issue: issue.number, url: issue.url });
    return true;
  } catch (err) {
    await block(deps, spec, task, `Dispatch failed: ${errMsg(err)}`);
    return false;
  }
}

/** One pass over a running spec. Safe to call repeatedly. */
export async function runSpecOnce(specId: string, deps: RunnerDeps = defaultDeps()): Promise<void> {
  const spec = await deps.store.getSpec(specId);
  if (spec?.status === 'done') { await followFinalPullRequest(deps, spec); return; }
  if (spec?.status !== 'running') return;

  for (const task of await deps.store.listTasks(specId)) {
    try {
      if (task.status === 'dispatched') await followDispatched(deps, spec, task);
      else if (task.status === 'pr_open' || task.status === 'awaiting_approval') await followPullRequest(deps, spec, task);
    } catch (err) {
      // Transient GitHub errors: record and try again next tick rather than blocking.
      await deps.store.updateTask(task.id, { lastError: errMsg(err) });
      await deps.store.addEvent(spec.id, task.id, 'error', `${task.title}: ${errMsg(err)}`);
    }
  }

  const tasks = await deps.store.listTasks(specId);
  const satisfied = new Set(tasks.filter((t) => SATISFIED_TASK_STATUSES.includes(t.status)).map((t) => t.id));
  if (tasks.length > 0 && satisfied.size === tasks.length) {
    if (spec.workBranch !== null && spec.finalPrNumber === null && !await openFinalPullRequest(deps, spec, tasks)) return;
    await deps.store.updateSpec(spec.id, { status: 'done', lastError: null });
    await deps.store.addEvent(spec.id, null, 'done', 'All tasks merged — build complete');
    return;
  }

  let active = tasks.filter((t) => ACTIVE_TASK_STATUSES.includes(t.status)).length;
  for (const task of tasks) {
    if (active >= spec.maxParallel) break;
    if (task.status !== 'pending' || !task.dependsOn.every((d) => satisfied.has(d))) continue;
    if (await dispatch(deps, spec, task, tasks)) active += 1;
  }
}

// ── Integration branch ────────────────────────────────────────────────────

/** Integration branch name for a spec: build/<slug>-<id prefix>. */
export function workBranchName(spec: Pick<BuildSpec, 'id' | 'title'>): string {
  const SLUG_MAX = 40;
  const ID_PREFIX = 6;
  const slug = spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
  return `build/${slug === '' ? 'spec' : slug}-${spec.id.slice(0, ID_PREFIX)}`;
}

/** Creates the spec's integration branch from its base branch (idempotent). Returns the updated spec. */
export async function ensureWorkBranch(spec: BuildSpec, deps: RunnerDeps = defaultDeps()): Promise<BuildSpec> {
  if (!spec.useWorkBranch || spec.workBranch !== null) return spec;
  const branch = workBranchName(spec);
  await deps.gh.createBranch(spec.repo, branch, spec.baseBranch);
  const updated = await deps.store.updateSpec(spec.id, { workBranch: branch });
  await deps.store.addEvent(spec.id, null, 'branch_created', `Created integration branch ${branch} from ${spec.baseBranch}`, { branch });
  return updated ?? { ...spec, workBranch: branch };
}

function finalPrBody(spec: BuildSpec, tasks: BuildTask[]): string {
  const lines = [`Integration PR for build spec **${spec.title}**, orchestrated by Knowledge Hub.`, '', 'Tasks:'];
  for (const t of tasks) {
    const ref = t.prNumber !== null ? ` (#${t.prNumber.toString()})` : '';
    lines.push(`- [${t.status === 'merged' ? 'x' : ' '}] ${t.title}${ref}${t.status === 'cancelled' ? ' — cancelled' : ''}`);
  }
  return lines.join('\n');
}

/** Opens the integration → base PR. Returns false (spec stays running, retried next tick) on failure. */
async function openFinalPullRequest(deps: RunnerDeps, spec: BuildSpec, tasks: BuildTask[]): Promise<boolean> {
  if (spec.workBranch === null) return true;
  try {
    const pr = await deps.gh.createPullRequest(spec.repo, spec.workBranch, spec.baseBranch, `Build: ${spec.title}`, finalPrBody(spec, tasks));
    if (pr === null) {
      await deps.store.addEvent(spec.id, null, 'final_pr', `Nothing to merge from ${spec.workBranch} into ${spec.baseBranch}`);
      await deps.gh.deleteBranch(spec.repo, spec.workBranch).catch(() => undefined);
      return true;
    }
    await deps.store.updateSpec(spec.id, { finalPrNumber: pr.number, finalPrUrl: pr.url });
    await deps.store.addEvent(spec.id, null, 'final_pr',
      `Opened #${pr.number.toString()} to merge ${spec.workBranch} into ${spec.baseBranch}`, { pr: pr.number, url: pr.url });
    return true;
  } catch (err) {
    await deps.store.updateSpec(spec.id, { lastError: `Could not open the final PR: ${errMsg(err)}` });
    return false;
  }
}

async function recordFinalMerged(deps: RunnerDeps, spec: BuildSpec, how: string): Promise<void> {
  await deps.store.updateSpec(spec.id, { finalPrMergedAt: deps.now().toISOString(), lastError: null });
  await deps.store.addEvent(spec.id, null, 'final_merged',
    `${spec.workBranch ?? 'Integration branch'} ${how} into ${spec.baseBranch}`, { pr: spec.finalPrNumber });
  if (spec.workBranch !== null) await deps.gh.deleteBranch(spec.repo, spec.workBranch).catch(() => undefined);
}

/** Watches a done spec's final PR so a merge made on GitHub is reflected here. */
async function followFinalPullRequest(deps: RunnerDeps, spec: BuildSpec): Promise<void> {
  if (spec.finalPrNumber === null || spec.finalPrMergedAt !== null) return;
  const pr = await deps.gh.getPullRequest(spec.repo, spec.finalPrNumber);
  if (pr.merged) await recordFinalMerged(deps, spec, `was merged (#${pr.number.toString()}) on GitHub`);
}

/** Merges the final PR (merge commit, keeping each task's commit) and deletes the integration branch. */
export async function mergeFinalPullRequest(spec: BuildSpec, deps: RunnerDeps = defaultDeps()): Promise<void> {
  if (spec.finalPrNumber === null || spec.finalPrMergedAt !== null) return;
  const pr = await deps.gh.getPullRequest(spec.repo, spec.finalPrNumber);
  if (!pr.merged) {
    if (pr.state === 'closed') throw new Error(`#${pr.number.toString()} was closed without merging — reopen it on GitHub first`);
    if (pr.draft) await deps.gh.markReadyForReview(spec.repo, pr.number);
    await deps.gh.mergePullRequest(spec.repo, pr.number, `Build: ${spec.title}`, 'merge');
  }
  await recordFinalMerged(deps, spec, `merged (#${pr.number.toString()})`);
}

// ── Scheduler integration ─────────────────────────────────────────────────

const runningSpecs = new Set<string>();

/** Runs one spec under an in-process lock (shared by the tick and the "sync now" route). */
export async function runSpecLocked(specId: string, deps?: RunnerDeps): Promise<void> {
  if (runningSpecs.has(specId)) return;
  runningSpecs.add(specId);
  try { await runSpecOnce(specId, deps); } finally { runningSpecs.delete(specId); }
}

export function buildRunnerEnabled(): boolean {
  return !env.isDevelopment || env.BUILD_RUNNER_ENABLED === 'true';
}

let ticking = false;
/** Scheduler tick: advances every running spec. No-op when nothing is running. */
export async function tickBuildRunner(): Promise<void> {
  if (ticking || !buildRunnerEnabled()) return;
  ticking = true;
  try {
    const ids = [...await store.listRunningSpecIds(), ...await store.listAwaitingFinalMergeIds()];
    if (ids.length === 0) return;
    const deps = defaultDeps();
    for (const id of ids) {
      await runSpecLocked(id, deps).catch(async (err: unknown) => {
        console.error(`[BuildRunner] Spec ${id} failed:`, errMsg(err));
        await store.updateSpec(id, { lastError: errMsg(err) }).catch(() => undefined);
      });
    }
  } finally {
    ticking = false;
  }
}
