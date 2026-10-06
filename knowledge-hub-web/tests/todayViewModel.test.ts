import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoverItem } from '../src/services/api';
import {
  buildTodayModel, readTodayTasks, relativeTime, safeHref, todayContext, TODAY_LIMITS, workDate,
  type TodayInputs, type TodayTask,
} from '../src/services/todayViewModel';

const now = new Date('2026-10-04T10:00:00Z');
const since = '2026-10-03T10:00:00Z';
function inputs(patch: Partial<TodayInputs> = {}): TodayInputs {
  return { tasks: [], notes: [], projects: [], activity: [], sources: [], discover: [], clusters: [], canvases: [], chats: [], ...patch };
}
function task(id: string, patch: Partial<TodayTask> = {}): TodayTask {
  return { id, title: id, body: '', status: 'todo', priority: 'medium', projectId: '',
    dueDate: null, updatedAt: now.toISOString(), archived: false, ...patch };
}

test('semantic priority outranks source order; no due date does not invent urgency', () => {
  const model = buildTodayModel(inputs({ tasks: [
    task('ordinary'), task('high', { priority: 'high' }), task('today', { dueDate: '2026-10-04' }),
    task('blocked', { status: 'blocked' }), task('overdue', { dueDate: '2026-10-03' }),
    task('urgent', { priority: 'urgent' }), task('feedback', { status: 'awaiting-feedback' }),
    task('near', { dueDate: '2026-10-07' }), task('later', { dueDate: '2026-10-08' }),
  ] }), now, since);
  assert.deepEqual(model.attention.map((i) => i.taskId), ['overdue', 'blocked', 'urgent', 'today', 'near', 'feedback', 'high']);
  assert.equal(model.attention.find((i) => i.taskId === 'today')?.status, 'Due today');
  assert.equal(model.attention.find((i) => i.taskId === 'today')?.tone, 'warning');
  assert.equal(model.attention.find((i) => i.taskId === 'overdue')?.tone, 'danger');
  assert.equal(JSON.parse(todayContext(model)).attention.length, TODAY_LIMITS.attention);
});

test('completed and archived tasks disappear; stale work requires attention without duplicating continuation', () => {
  const model = buildTodayModel(inputs({ tasks: [
    task('done', { status: 'completed', priority: 'urgent' }),
    task('archived', { archived: true, status: 'blocked' }),
    task('stale', { status: 'in-progress', updatedAt: '2026-09-20' }),
    task('active', { status: 'in-progress' }),
  ] }), now, since);
  assert.deepEqual(model.attention.map((i) => i.taskId), ['stale']);
  assert.deepEqual(model.continuing.map((i) => i.taskId), ['active']);
});

test('meaningful recent work is capped; empty canvases and invalid dates never enter continuation', () => {
  const model = buildTodayModel(inputs({
    notes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, title: `Draft ${i}`, contentType: 'note',
      updatedAt: i === 0 ? 'invalid' : now.toISOString() })),
    canvases: [
      { id: 'map', title: 'Ideas', canvasType: 'brainstorm', description: null, project: null, createdAt: since, updatedAt: now.toISOString(), nodeCount: 2, linkedNotes: [] },
      { id: 'empty', title: 'Empty', canvasType: 'brainstorm', description: null, project: null, createdAt: since, updatedAt: now.toISOString(), nodeCount: 0, linkedNotes: [] },
    ],
  }), now, since);
  assert.equal(model.continuing.length, TODAY_LIMITS.continue);
  assert.ok(model.continuing.every((item) => Number.isFinite(item.score)));
  assert.ok(model.continuing.every((item) => item.id !== 'note:n0' && item.id !== 'canvas:empty'));
  const canvas = buildTodayModel(inputs({ canvases: [
    { id: 'map', title: 'Ideas', canvasType: 'brainstorm', description: null, project: null, createdAt: since, updatedAt: now.toISOString(), nodeCount: 2, linkedNotes: [] },
  ] }), now, since).continuing[0];
  assert.equal(canvas?.href, '/think?mapId=map');
});

test('failed automation promotes attention, a newer success resolves it, and routine successes are grouped', () => {
  const run = (id: string, state: string, date: string) => ({
    id, source: 'gitlab-pipeline' as const, sourceId: id, title: 'Build', summary: '', publishedAt: date,
    metadata: { status: state, workflowId: 'build', repo: 'sample' }, url: 'https://example.com/build',
  });

  const failure = run('failed', 'failed', '2026-10-04T08:00:00Z');
  assert.equal(buildTodayModel(inputs({ activity: [failure] }), now, since).attention[0]?.status, 'Failed');
  const resolved = buildTodayModel(inputs({ activity: [
    failure, run('success1', 'success', '2026-10-04T09:00:00Z'),
    run('success2', 'success', '2026-10-03T12:00:00Z'),
    run('running', 'running', '2026-10-03T13:00:00Z'),
  ] }), now, since);
  assert.equal(resolved.attention.length, 0);
  assert.equal(resolved.changes.length, 1);
  assert.match(resolved.changes[0]!.title, /^2 Routine automations completed successfully/);
  assert.equal(resolved.changes[0]!.href, '/my-work');
  assert.equal(buildTodayModel(inputs({ activity: [failure] }), now, now.toISOString()).changes.length, 0);
});

test('diagram continuation describes diagram objects without claiming they are connected cards', () => {
  const model = buildTodayModel(inputs({ canvases: [{
    id: 'architecture', title: 'Enterprise architecture', canvasType: 'diagram', description: null,
    project: null, createdAt: since, updatedAt: now.toISOString(), nodeCount: 11, linkedNotes: [],
  }] }), now, since);
  assert.equal(model.continuing[0]?.type, 'Diagram');
  assert.equal(model.continuing[0]?.reason, '11 diagram objects to develop in Think.');
  assert.equal(model.continuing[0]?.href, '/think?mapId=architecture');
});

test('open decisions suppress the same chat in continuation; saved outputs remain an intentional change summary', () => {
  const chat = {
    session: { id: 's', title: 'Podcast package', startedAt: since, updatedAt: now.toISOString(), preview: '', projectId: 'personal' },
    outputs: [{ id: 'o', sessionId: 's', title: 'Show notes', kind: 'notes', format: 'markdown' as const, version: 1, updatedAt: now.toISOString() }],
    decisions: [{ id: 'd', text: 'Choose a title', status: 'open' as const, source: 'user' as const, createdAt: since, updatedAt: now.toISOString() }],
  };
  const model = buildTodayModel(inputs({ chats: [chat] }), now, since);
  assert.equal(model.attention[0]?.href, '/chat?session=s');
  assert.equal(model.attention[0]?.projectId, 'personal');
  assert.equal(model.continuing.length, 0);
  assert.match(model.changes[0]!.title, /1 Athena output saved/);
});

test('exploration needs a real explanation; only unsurfaced clusters of four or more Sparks qualify', () => {
  const cluster = (id: string, sparkCount: number, surfaced = false, dismissed = false) => ({
    id, theme: id, sparkCount, surfaced, dismissed, surfacedAt: null, createdAt: since, updatedAt: now.toISOString(),
  });
  const model = buildTodayModel(inputs({ clusters: [
    cluster('small', 3), cluster('ready', 4), cluster('shown', 10, true), cluster('dismissed', 10, false, true),
    ...Array.from({ length: 5 }, (_, i) => cluster(`big${i}`, 8)),
  ] }), now, since);
  assert.equal(model.exploration.length, TODAY_LIMITS.explore);
  assert.ok(model.exploration.every((i) => !['cluster:small', 'cluster:shown', 'cluster:dismissed'].includes(i.id)));
  assert.ok(model.exploration.every((i) => i.reason.includes('captured thoughts')));
});

test('source errors are user-facing and empty or missing inputs produce honest empty sections', () => {
  assert.deepEqual(buildTodayModel(inputs(), now, since), { attention: [], continuing: [], changes: [], exploration: [] });
  const model = buildTodayModel(inputs({ sources: [{
    source: 'github', status: 'error', lastSyncAt: since, itemCount: 0, lastError: 'private trace',
    syncCadenceMinutes: 60,
  }] }), now, since);
  assert.equal(model.attention[0]?.status, 'Sync failed');
  assert.ok(!model.attention[0]?.reason.includes('private trace'));
  assert.equal(model.continuing.length, 0);
});

test('Discover review opens the actual article; missing explanations and already-triaged articles are excluded', () => {
  const article: DiscoverItem = {
    id: 'article', sourceId: 'feed', title: 'Relevant research', url: 'https://example.com/research',
    description: null, publishedAt: since, indexedAt: since, sourceTitle: 'Research feed',
    workflowState: 'to-review', relevanceScore: 8, relevanceExplanation: 'Supports the current architecture review.',
    publishedUrl: null, taxonomyTagIds: [], articleType: null, platform: null, sourceType: null,
    spark: false, sparkReason: null, compositeScore: null,
  };
  const model = buildTodayModel(inputs({ discover: [
    article, { ...article, id: 'no-reason', relevanceExplanation: null },
    { ...article, id: 'saved', workflowState: 'saved' },
  ] }), now, since);
  assert.equal(model.exploration.length, 1);
  assert.equal(model.exploration[0]?.href, article.url);
  assert.equal(model.exploration[0]?.reason, article.relevanceExplanation);
});

test('runtime task validation and link validation reject malformed values explicitly', () => {
  assert.throws(() => readTodayTasks([]), /invalid task list/);
  assert.throws(() => readTodayTasks({ items: [{}] }), /missing id/);
  assert.equal(readTodayTasks({ items: [task('a', { dueDate: '2026-10-04T00:00:00Z' })] })[0]?.dueDate, '2026-10-04');
  assert.equal(safeHref('javascript:alert(1)', '/my-work'), '/my-work');
  assert.equal(safeHref('//example.com', '/my-work'), '/my-work');
  assert.equal(safeHref('/\\example.com', '/my-work'), '/my-work');
  assert.equal(safeHref('/plan?taskId=a', '/my-work'), '/plan?taskId=a');
  assert.equal(safeHref('https://example.com/a', '/my-work'), 'https://example.com/a');
  assert.equal(relativeTime('invalid', now), 'Date unavailable');
  assert.equal(workDate(new Date('2026-10-03T23:30:00Z')), '2026-10-04');
});
