import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTaskGraph, normaliseDrafts, type TaskDraft } from '../src/build/decompose.js';
import {
  runSpecOnce, ensureWorkBranch, mergeFinalPullRequest, workBranchName,
  MAX_FIX_ATTEMPTS, CHECKS_GRACE_MS, NO_PR_TIMEOUT_MS, type RunnerDeps, type RunnerStore,
} from '../src/build/buildRunner.js';
import type { AgentGitHub, AgentPullRequest, CheckSummary, AgentActivity } from '../src/build/githubAgents.js';
import type { BuildSpec, BuildTask, TaskStatus } from '../src/build/buildStore.js';

// ── validateTaskGraph ──────────────────────────────────────────────────────

const draft = (key: string, dependsOn: string[] = []): TaskDraft => ({
  key, title: `Task ${key}`, body: 'Do it', agent: 'copilot', agentReason: '', size: 'S', dependsOn,
});

test('validateTaskGraph orders tasks topologically', () => {
  const ordered = validateTaskGraph([draft('c', ['b']), draft('a'), draft('b', ['a'])]);
  assert.deepEqual(ordered.map((d) => d.key), ['a', 'b', 'c']);
});

test('validateTaskGraph rejects cycles, unknown deps, self deps and duplicate keys', () => {
  assert.throws(() => validateTaskGraph([draft('a', ['b']), draft('b', ['a'])]), /cycle/i);
  assert.throws(() => validateTaskGraph([draft('a', ['zzz'])]), /unknown/i);
  assert.throws(() => validateTaskGraph([draft('a', ['a'])]), /itself|self/i);
  assert.throws(() => validateTaskGraph([draft('a'), draft('a')]), /duplicate/i);
  assert.throws(() => validateTaskGraph([]), /task/i);
});

test('normaliseDrafts defaults bad agents and sizes', () => {
  const [d] = normaliseDrafts([{ key: 'x', title: 'X', body: 'b', agent: 'gemini', size: 'XL', depends_on: 'nope' }]);
  assert.equal(d?.agent, 'copilot');
  assert.equal(d?.size, 'M');
  assert.deepEqual(d?.dependsOn, []);
});

// ── Runner ─────────────────────────────────────────────────────────────────

const T0 = new Date('2026-01-01T00:00:00Z');

function makeSpec(over: Partial<BuildSpec> = {}): BuildSpec {
  return {
    id: 'spec', projectId: null, noteId: null, chatOutputId: null, title: 'Spec', specMarkdown: 'x', repo: 'o/r',
    baseBranch: 'main', useWorkBranch: false, workBranch: null, finalPrNumber: null, finalPrUrl: null, finalPrMergedAt: null,
    status: 'running', maxParallel: 2, autoMerge: true, planNotes: '', lastError: null,
    createdAt: T0.toISOString(), updatedAt: T0.toISOString(), ...over,
  };
}

function makeTask(id: string, seq: number, over: Partial<BuildTask> = {}): BuildTask {
  return {
    id, specId: 'spec', seq, title: `Task ${id}`, bodyMarkdown: 'body', agent: 'copilot', agentReason: '', model: '',
    size: 'S', dependsOn: [], status: 'pending', issueNumber: null, issueUrl: null, prNumber: null, prUrl: null,
    branch: null, headSha: null, nudgedSha: null, nudgedAt: null, doneSeenAt: null, fixAttempts: 0, lastError: null,
    dispatchedAt: null, mergedAt: null, createdAt: T0.toISOString(), updatedAt: T0.toISOString(), ...over,
  };
}

function makePr(over: Partial<AgentPullRequest> = {}): AgentPullRequest {
  return {
    number: 10, state: 'open', merged: false, draft: false, mergeableState: 'clean', headRef: 'copilot/x',
    headSha: 'sha1', htmlUrl: 'https://github.com/o/r/pull/10', changedFiles: ['src/a.ts'], ...over,
  };
}

interface Harness {
  deps: RunnerDeps;
  spec: BuildSpec;
  tasks: Map<string, BuildTask>;
  calls: string[];
  gh: { pr: AgentPullRequest | null; checks: CheckSummary; activity: AgentActivity; mergeFails: boolean; finalPr: { number: number; url: string } | null; baseRefs: string[] };
  clock: { now: Date };
}

function harness(spec: BuildSpec, tasks: BuildTask[]): Harness {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const calls: string[] = [];
  const clock = { now: T0 };
  const ghState: Harness['gh'] = {
    pr: null, checks: { total: 1, pending: 0, failed: 0, failedNames: [] },
    activity: { working: false, lastFinishedAt: T0.toISOString() }, mergeFails: false,
    finalPr: { number: 99, url: 'https://github.com/o/r/pull/99' }, baseRefs: [],
  };
  let issueNo = 100;
  const gh: AgentGitHub = {
    createAgentIssue: (input) => { ghState.baseRefs.push(input.baseRef); calls.push(`issue:${input.title}:${input.agent}`); issueNo += 1; return Promise.resolve({ number: issueNo, url: `u/${issueNo.toString()}` }); },
    findPullRequestForIssue: () => Promise.resolve(ghState.pr),
    getPullRequest: () => { if (ghState.pr === null) throw new Error('no pr'); return Promise.resolve(ghState.pr); },
    getAgentActivity: () => Promise.resolve(ghState.activity),
    getChecks: () => Promise.resolve(ghState.checks),
    markReadyForReview: () => { calls.push('ready'); return Promise.resolve(); },
    mergePullRequest: (_r, _n, _t, method) => { calls.push(method === 'merge' ? 'merge-commit' : 'merge'); return ghState.mergeFails ? Promise.reject(new Error('protected')) : Promise.resolve(); },
    deleteBranch: (_r, b) => { calls.push(b.startsWith('build/') ? `delete-branch:${b}` : 'delete-branch'); return Promise.resolve(); },
    createBranch: (_r, b, from) => { calls.push(`branch:${b}:${from}`); return Promise.resolve(); },
    createPullRequest: (_r, head, base) => { calls.push(`final-pr:${head}:${base}`); return Promise.resolve(ghState.finalPr); },
    comment: (_r, n, body) => { calls.push(`comment:${n.toString()}:${body}`); return Promise.resolve(); },
    closeIssue: () => Promise.resolve(),
    listAvailableAgents: () => Promise.resolve(['copilot', 'claude']),
    listBranches: () => Promise.resolve({ defaultBranch: 'main', branches: ['main'] }),
  };
  let specState = spec;
  const store: RunnerStore = {
    getSpec: () => Promise.resolve(specState),
    listTasks: () => Promise.resolve([...map.values()].sort((a, b) => a.seq - b.seq)),
    updateTask: (id, patch) => { const t = { ...(map.get(id) as BuildTask), ...patch }; map.set(id, t); return Promise.resolve(t); },
    updateSpec: (_id, patch) => { specState = { ...specState, ...patch }; h.spec = specState; return Promise.resolve(specState); },
    claimTask: (id, from, to) => {
      const t = map.get(id);
      if (t?.status !== from) return Promise.resolve(false);
      map.set(id, { ...t, status: to });
      return Promise.resolve(true);
    },
    addEvent: () => Promise.resolve(),
  };
  const h: Harness = { deps: { gh, store, now: () => clock.now }, spec, tasks: map, calls, gh: ghState, clock };
  return h;
}

const status = (h: Harness, id: string): TaskStatus => (h.tasks.get(id) as BuildTask).status;
const later = (ms: number): Date => new Date(T0.getTime() + ms);

test('runner dispatches only ready tasks, up to maxParallel', async () => {
  const h = harness(makeSpec({ maxParallel: 1 }), [
    makeTask('a', 1), makeTask('b', 2), makeTask('c', 3, { dependsOn: ['a'] }),
  ]);
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'dispatched');
  assert.equal(status(h, 'b'), 'pending');
  assert.equal(status(h, 'c'), 'pending');
  assert.equal(h.tasks.get('a')?.issueNumber, 101);
  assert.deepEqual(h.calls, ['issue:Task a:copilot']);
});

test('runner does nothing for a paused spec', async () => {
  const h = harness(makeSpec({ status: 'paused' }), [makeTask('a', 1)]);
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'pending');
  assert.equal(h.calls.length, 0);
});

test('dispatched task picks up the agent PR, then merges when green and releases dependents', async () => {
  const h = harness(makeSpec(), [
    makeTask('a', 1, { status: 'dispatched', issueNumber: 5, dispatchedAt: T0.toISOString() }),
    makeTask('b', 2, { dependsOn: ['a'] }),
  ]);
  h.gh.pr = makePr();
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'pr_open');
  assert.equal(status(h, 'b'), 'pending');

  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'merged');
  assert.ok(h.calls.includes('merge'));
  assert.ok(h.calls.includes('delete-branch'));
  assert.equal(status(h, 'b'), 'dispatched');
});

test('dispatched task with no PR is blocked after the timeout', async () => {
  const h = harness(makeSpec(), [makeTask('a', 1, { status: 'dispatched', issueNumber: 5, dispatchedAt: T0.toISOString() })]);
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'dispatched');
  h.clock.now = later(NO_PR_TIMEOUT_MS + 1);
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'blocked');
});

const openTask = (over: Partial<BuildTask> = {}): BuildTask =>
  makeTask('a', 1, { status: 'pr_open', issueNumber: 5, prNumber: 10, headSha: 'sha1', ...over });

test('runner waits while the agent is working or checks are pending', async () => {
  const h = harness(makeSpec(), [openTask()]);
  h.gh.pr = makePr();
  h.gh.activity = { working: true, lastFinishedAt: null };
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'pr_open');

  h.gh.activity = { working: false, lastFinishedAt: T0.toISOString() };
  h.gh.checks = { total: 2, pending: 1, failed: 0, failedNames: [] };
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'pr_open');
  assert.ok(!h.calls.includes('merge'));
});

test('failing checks nudge the agent, and block after MAX_FIX_ATTEMPTS', async () => {
  const h = harness(makeSpec(), [openTask()]);
  h.gh.pr = makePr();
  h.gh.checks = { total: 1, pending: 0, failed: 1, failedNames: ['build'] };
  await runSpecOnce('spec', h.deps);
  assert.equal(h.tasks.get('a')?.fixAttempts, 1);
  assert.ok(h.calls.some((c) => c.startsWith('comment:10:@copilot') && c.includes('build')));

  // Same head SHA, agent hasn't finished since the nudge → wait.
  h.gh.activity = { working: false, lastFinishedAt: T0.toISOString() };
  h.clock.now = later(1000);
  await runSpecOnce('spec', h.deps);
  assert.equal(h.tasks.get('a')?.fixAttempts, 1);

  // Agent pushes a new commit, still failing → second nudge, then blocked.
  h.gh.pr = makePr({ headSha: 'sha2' });
  await runSpecOnce('spec', h.deps);
  assert.equal(h.tasks.get('a')?.fixAttempts, MAX_FIX_ATTEMPTS);
  h.gh.pr = makePr({ headSha: 'sha3' });
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'blocked');
});

test('merge conflicts nudge the agent to merge the base branch', async () => {
  const h = harness(makeSpec(), [openTask()]);
  h.gh.pr = makePr({ mergeableState: 'dirty' });
  await runSpecOnce('spec', h.deps);
  assert.ok(h.calls.some((c) => c.includes('merge conflicts')));
  assert.equal(status(h, 'a'), 'pr_open');
});

test('no CI checks → awaiting approval after the grace period, never auto-merged', async () => {
  const h = harness(makeSpec(), [openTask()]);
  h.gh.pr = makePr();
  h.gh.checks = { total: 0, pending: 0, failed: 0, failedNames: [] };
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'pr_open');
  h.clock.now = later(CHECKS_GRACE_MS + 1);
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'awaiting_approval');
  assert.ok(!h.calls.includes('merge'));
});

test('workflow changes and auto-merge off wait for the user', async () => {
  const wf = harness(makeSpec(), [openTask()]);
  wf.gh.pr = makePr({ changedFiles: ['.github/workflows/ci.yml'] });
  await runSpecOnce('spec', wf.deps);
  assert.equal(status(wf, 'a'), 'awaiting_approval');

  const off = harness(makeSpec({ autoMerge: false }), [openTask()]);
  off.gh.pr = makePr();
  await runSpecOnce('spec', off.deps);
  assert.equal(status(off, 'a'), 'awaiting_approval');
  assert.ok(!off.calls.includes('merge'));
});

test('draft PRs are marked ready before merging; failed merges block', async () => {
  const h = harness(makeSpec(), [openTask()]);
  h.gh.pr = makePr({ draft: true });
  await runSpecOnce('spec', h.deps);
  assert.deepEqual(h.calls.slice(0, 2), ['ready', 'merge']);
  assert.equal(status(h, 'a'), 'merged');

  const f = harness(makeSpec(), [openTask()]);
  f.gh.pr = makePr();
  f.gh.mergeFails = true;
  await runSpecOnce('spec', f.deps);
  assert.equal(status(f, 'a'), 'blocked');
});

test('externally merged PRs are recorded and the spec completes', async () => {
  const h = harness(makeSpec(), [openTask(), makeTask('b', 2, { status: 'cancelled' })]);
  h.gh.pr = makePr({ merged: true, state: 'closed' });
  await runSpecOnce('spec', h.deps);
  assert.equal(status(h, 'a'), 'merged');
  assert.equal(h.spec.status, 'done');
});

// ── Integration branch ─────────────────────────────────────────────────────

const WB = 'build/spec-abc123';

test('workBranchName slugs the title and suffixes the id', () => {
  assert.equal(workBranchName({ id: 'abc123def', title: 'Add OAuth login!  (v2)' }), 'build/add-oauth-login-v2-abc123');
  assert.equal(workBranchName({ id: 'abc123def', title: '***' }), 'build/spec-abc123');
});

test('ensureWorkBranch creates the branch from base once', async () => {
  const h = harness(makeSpec({ id: 'abc123def', title: 'My Spec', useWorkBranch: true }), []);
  const updated = await ensureWorkBranch(h.spec, h.deps);
  assert.equal(updated.workBranch, 'build/my-spec-abc123');
  assert.deepEqual(h.calls, ['branch:build/my-spec-abc123:main']);
  await ensureWorkBranch(updated, h.deps);
  assert.equal(h.calls.length, 1);

  const off = harness(makeSpec({ useWorkBranch: false }), []);
  assert.equal((await ensureWorkBranch(off.spec, off.deps)).workBranch, null);
  assert.equal(off.calls.length, 0);
});

test('agents target the integration branch when there is one', async () => {
  const h = harness(makeSpec({ useWorkBranch: true, workBranch: WB }), [makeTask('a', 1)]);
  await runSpecOnce('spec', h.deps);
  assert.deepEqual(h.gh.baseRefs, [WB]);
});

test('when every task is merged the runner opens one PR into the base branch', async () => {
  const h = harness(makeSpec({ useWorkBranch: true, workBranch: WB }), [makeTask('a', 1, { status: 'merged', prNumber: 5 })]);
  await runSpecOnce('spec', h.deps);
  assert.ok(h.calls.includes(`final-pr:${WB}:main`));
  assert.equal(h.spec.status, 'done');
  assert.equal(h.spec.finalPrNumber, 99);

  // Second pass while done: final PR still open → nothing happens.
  h.gh.pr = makePr({ number: 99 });
  await runSpecOnce('spec', h.deps);
  assert.equal(h.spec.finalPrMergedAt, null);
  // Merged on GitHub → recorded and the integration branch is deleted.
  h.gh.pr = makePr({ number: 99, merged: true, state: 'closed' });
  await runSpecOnce('spec', h.deps);
  assert.notEqual(h.spec.finalPrMergedAt, null);
  assert.ok(h.calls.includes(`delete-branch:${WB}`));
});

test('nothing to merge completes the spec without a final PR', async () => {
  const h = harness(makeSpec({ useWorkBranch: true, workBranch: WB }), [makeTask('a', 1, { status: 'cancelled' })]);
  h.gh.finalPr = null;
  await runSpecOnce('spec', h.deps);
  assert.equal(h.spec.status, 'done');
  assert.equal(h.spec.finalPrNumber, null);
});

test('mergeFinalPullRequest uses a merge commit and cleans up', async () => {
  const h = harness(makeSpec({ status: 'done', workBranch: WB, finalPrNumber: 99 }), []);
  h.gh.pr = makePr({ number: 99, draft: true });
  await mergeFinalPullRequest(h.spec, h.deps);
  assert.deepEqual(h.calls, ['ready', 'merge-commit', `delete-branch:${WB}`]);
  assert.notEqual(h.spec.finalPrMergedAt, null);
});
