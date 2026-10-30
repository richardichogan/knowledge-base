import assert from 'node:assert/strict';
import test from 'node:test';
import { assignmentStatusLabel, isActiveAssignment, type AssignmentState, type AssignmentSummary } from '../src/types/agentJobs.js';

const assignment: AssignmentSummary = {
  id: 'assignment', subjectType: 'blog-source', subjectId: 'discover:article', title: 'Commissioned article',
  status: 'queued', readiness: 'pending', revision: 0, reason: null,
  currentStep: { key: 'research', role: 'iris', name: 'Iris', title: 'Researcher', profile: 'manual-blog-research' },
  resultUrl: null, callsUsed: '0', tokensUsed: '0',
  deadline: '2026-10-24T12:00:00Z', createdAt: '2026-10-24T11:00:00Z', finishedAt: null,
};

test('only queued/running assignments count as active work, not waiting or cancelled assignments', () => {
  const states: AssignmentState[] = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'superseded'];
  for (const status of states) {
    assert.equal(isActiveAssignment({ ...assignment, status }), status === 'queued' || status === 'running');
  }
});

test('a completed assignment describes review readiness, never automatic approval or publication', () => {
  assert.equal(assignmentStatusLabel({ ...assignment, status: 'completed', readiness: 'ready' }), 'Ready for review');
  assert.equal(assignmentStatusLabel({ ...assignment, status: 'completed', readiness: 'blocked' }), 'Review needs attention');
});

test('paused, superseded and cancelled work remains distinguishable from execution failure', () => {
  assert.equal(assignmentStatusLabel({ ...assignment, status: 'waiting' }), 'Paused for attention');
  assert.equal(assignmentStatusLabel({ ...assignment, status: 'superseded' }), 'Sources changed');
  assert.equal(assignmentStatusLabel({ ...assignment, status: 'cancelled' }), 'Cancelled');
  assert.equal(assignmentStatusLabel({ ...assignment, status: 'failed' }), 'Could not finish');
});
