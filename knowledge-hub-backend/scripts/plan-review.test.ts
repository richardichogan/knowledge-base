import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicProposals, validateProposals } from '../src/services/planReview.js';

const today = '2026-10-14';
const base = { body: '', priority: 'normal', project_id: 'personal', waiting_on: null, created_at: '2026-01-01T00:00:00Z' };
const tasks = [
  { ...base, id: 'late', title: 'Late', status: 'backlog', due_date: '2026-10-01', updated_at: '2026-10-10T00:00:00Z' },
  { ...base, id: 'stale', title: 'Stale', status: 'backlog', due_date: null, updated_at: '2026-08-01T00:00:00Z' },
  { ...base, id: 'fresh', title: 'Fresh', status: 'in-progress', due_date: '2026-10-20', updated_at: '2026-10-13T00:00:00Z' },
];

test('AI proposals are validated against real tasks, dates and split sizes', () => {
  const out = validateProposals([
    { taskId: 'late', action: 'reschedule', dueDate: '2026-10-16', reason: 'Overdue.' },
    { taskId: 'late', action: 'archive', reason: 'Duplicate for same task is dropped.' },
    { taskId: 'ghost', action: 'complete', reason: 'Unknown task.' },
    { taskId: 'fresh', action: 'reschedule', dueDate: '2026-10-01', reason: 'Past date is rejected.' },
    { taskId: 'stale', action: 'split', subtasks: ['Only one'], reason: 'Too few subtasks.' },
    { taskId: 'stale', action: 'delete', reason: 'Unknown action.' },
  ], tasks, today);
  assert.deepEqual(out, [{ taskId: 'late', title: 'Late', projectId: 'personal', priority: 'normal', action: 'reschedule', dueDate: '2026-10-16', reason: 'Overdue.' }]);
  assert.deepEqual(validateProposals({ not: 'an array' }, tasks, today), []);
});

test('rule-based fallback reschedules overdue work to a weekday and archives stale undated backlog', () => {
  const out = heuristicProposals(tasks, today);
  assert.deepEqual(out.map((p) => [p.taskId, p.action]), [['late', 'reschedule'], ['stale', 'archive']]);
  assert.equal(out[0]?.dueDate, '2026-10-16');
});
