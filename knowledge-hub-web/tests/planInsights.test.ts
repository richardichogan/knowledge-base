import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseTask, type PlanTask } from '../src/types/task';
import { groupForFocus, isRecentlyCompleted, originHref, originLabel, planContextDetail, taskHealth } from '../src/features/plan/taskInsights';

const NOW = new Date('2026-10-13T12:00:00Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function task(patch: Partial<PlanTask>): PlanTask {
  return {
    id: 't1', title: 'Task', body: '', status: 'backlog', projectId: 'p1', tags: [], priority: 'normal', task_type: 'standard',
    dueDate: null, startDate: null, endDate: null, externalUrl: null, linkedTagId: null, taxonomyTagIds: [],
    recurringCadence: null, archived: false, createdAt: daysAgo(30), updatedAt: daysAgo(1), ...patch,
  };
}

test('Plan health flags only open tasks untouched for two weeks; waiting statuses read as Waiting', () => {
  assert.equal(taskHealth(task({ updatedAt: daysAgo(13) }), NOW), null);
  assert.equal(taskHealth(task({ status: 'completed', updatedAt: daysAgo(90) }), NOW), null);
  assert.deepEqual(taskHealth(task({ updatedAt: daysAgo(15) }), NOW)?.label, 'Idle 2 wk');
  assert.deepEqual(taskHealth(task({ status: 'waiting', updatedAt: daysAgo(150) }), NOW)?.label, 'Waiting 5 mo');
  assert.equal(taskHealth(task({ status: 'waiting', updatedAt: daysAgo(20) }), NOW)?.kind, 'waiting');
});

test('Plan keeps only this week\'s completed tasks visible by default', () => {
  assert.equal(isRecentlyCompleted(task({ status: 'completed', updatedAt: daysAgo(6) }), NOW), true);
  assert.equal(isRecentlyCompleted(task({ status: 'completed', updatedAt: daysAgo(8) }), NOW), false);
  assert.equal(isRecentlyCompleted(task({ status: 'in-progress', updatedAt: daysAgo(1) }), NOW), false);
});

test('Plan task origins link back to the Athena chat or note they came from', () => {
  assert.equal(originHref({ type: 'chat', id: 'c1', title: 'Morning briefing', url: '/chat?session=c1' }), '/chat?session=c1');
  assert.equal(originHref({ type: 'chat', id: 'c 2', title: '', url: '' }), '/chat?session=c%202');
  assert.equal(originHref({ type: 'note', id: 'n1', title: 'Podcast', url: '' }), '/think?noteId=n1');
  assert.equal(originHref({ type: 'other', id: 'x', title: '', url: '' }), null);
  assert.equal(originLabel({ type: 'note', id: 'n1', title: 'Podcast', url: '' }), 'Note: Podcast');
});

test('Plan Athena context groups open work and marks overdue and stale tasks', () => {
  const detail = planContextDetail([
    task({ id: 'a', title: 'Ship deck', status: 'in-progress', dueDate: '2026-10-10', priority: 'high' }),
    task({ id: 'b', title: 'Chase legal', status: 'waiting', waitingOn: 'Legal', updatedAt: daysAgo(60) }),
    task({ id: 'd', title: 'Draft agenda', status: 'inbox' }),
    task({ id: 'c', title: 'Done thing', status: 'completed', updatedAt: daysAgo(2) }),
  ], (id) => (id === 'p1' ? 'Imagine' : id), '2026-10-13', NOW);
  assert.match(detail, /In progress \(1\):\n\* Ship deck \[high, Imagine, OVERDUE \(due 2026-10-10\)\]/);
  assert.match(detail, /Inbox \(1\):\n\* Draft agenda \[Imagine\]/);
  assert.match(detail, /Waiting \(1\):\n\* Chase legal \[Imagine, waiting on Legal, waiting 2 mo\]/);
  assert.match(detail, /Completed this week \(1\):\n\* Done thing/);
});

test('Legacy Blocked and Awaiting feedback tasks read as Waiting with a reason', () => {
  assert.deepEqual(normaliseTask({ status: 'blocked' }), { status: 'waiting', waitingOn: 'Blocked' });
  assert.deepEqual(normaliseTask({ status: 'awaiting-feedback', waitingOn: 'Sarah' }), { status: 'waiting', waitingOn: 'Sarah' });
  const current = { status: 'backlog' };
  assert.equal(normaliseTask(current), current);
});

test('Focus groups each open task once: overdue, this week, waiting, next up, then someday', () => {
  const groups = groupForFocus([
    task({ id: 'late', dueDate: '2026-10-12' }),
    task({ id: 'soon-waiting', status: 'waiting', dueDate: '2026-10-19' }),
    task({ id: 'later', dueDate: '2026-10-20' }),
    task({ id: 'recurring', recurringCadence: 'weekly', startDate: '2026-10-14' }),
    task({ id: 'waiting', status: 'waiting', priority: 'urgent' }),
    task({ id: 'doing', status: 'in-progress' }),
    task({ id: 'urgent', priority: 'urgent' }),
    task({ id: 'rest' }),
    task({ id: 'inbox', status: 'inbox', dueDate: '2026-10-01' }),
    task({ id: 'done', status: 'completed', dueDate: '2026-10-01' }),
  ], '2026-10-13');
  const ids = (list: PlanTask[]): string[] => list.map((t) => t.id);
  assert.deepEqual(ids(groups.overdue), ['late']);
  assert.deepEqual(ids(groups.week), ['recurring', 'soon-waiting']);
  assert.deepEqual(ids(groups.waiting), ['waiting']);
  assert.deepEqual(ids(groups.next), ['doing', 'urgent']);
  assert.deepEqual(ids(groups.someday), ['later', 'rest']);
});
