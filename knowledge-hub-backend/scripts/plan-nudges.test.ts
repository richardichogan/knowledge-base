import test from 'node:test';
import assert from 'node:assert/strict';
import { isLaterDueDate, scoreAtRisk, workDay } from '../src/services/planNudges.js';

const today = '2026-10-14';
const row = {
  id: 't', title: 'Task', status: 'backlog', priority: 'normal', project_id: 'personal',
  due_date: null as string | null, reschedule_count: 0, updated_at: '2026-10-13T09:00:00Z',
};

test('only a due date moved later counts as a slip', () => {
  assert.equal(isLaterDueDate('2026-10-14', '2026-10-15'), true);
  assert.equal(isLaterDueDate('2026-10-14', '2026-10-13'), false);
  assert.equal(isLaterDueDate('2026-10-14', '2026-10-14'), false);
  assert.equal(isLaterDueDate(null, '2026-10-15'), false);
  assert.equal(isLaterDueDate('2026-10-14', null), false);
});

test('at-risk scoring favours overdue and repeatedly slipped work and ignores someday backlog', () => {
  assert.equal(scoreAtRisk({ ...row, updated_at: '2026-01-01T00:00:00Z' }, today), null);
  const overdue = scoreAtRisk({ ...row, due_date: '2026-10-10' }, today);
  assert.equal(overdue?.reason, 'Overdue 4 days');
  const slipped = scoreAtRisk({ ...row, due_date: '2026-10-20', reschedule_count: 3 }, today);
  assert.equal(slipped?.reason, 'Pushed back 3 times');
  assert.ok((slipped?.score ?? 0) > (overdue?.score ?? 0));
  assert.equal(scoreAtRisk({ ...row, due_date: today }, today)?.reason, 'Due today');
  assert.equal(scoreAtRisk({ ...row, due_date: '2026-10-20' }, today), null);
  const quiet = scoreAtRisk({ ...row, status: 'in-progress', priority: 'high', updated_at: '2026-09-01T00:00:00Z' }, today);
  assert.equal(quiet?.reason, 'Untouched 43 days');
});

test('work day accepts an ISO date and falls back to the UK date', () => {
  assert.equal(workDay('2026-10-14'), '2026-10-14');
  assert.match(workDay('nonsense'), /^\d{4}-\d{2}-\d{2}$/);
});
