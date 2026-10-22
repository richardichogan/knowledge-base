import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { rowToTask } from '../src/routes/tasks.js';
import { heuristicProposals } from '../src/services/planReview.js';
import { scoreAtRisk, workDay } from '../src/services/planNudges.js';
import { evaluateDecisionReviewDue, evaluateLinkedOpenWork, evaluateTaskRule } from '../src/services/semantic/live.js';
import {
  createRuleRegistry, DEFAULT_RULES, distinctLinkedWork, evaluateRule, reevaluate, RULE_DECISION_REVIEW_DUE, RULE_LINKED_OPEN_WORK,
  RULE_TASK_BLOCKED, RULE_TASK_OVERDUE, type RuleDefinition,
} from '../src/services/semantic/rules.js';
import { normaliseDueDate, workDayAt } from '../src/services/semantic/taskSemantics.js';
import { ctx, fixtureDb, NOW, SD1, SD3 } from './semantic-fixture.js';

const overdue = (inputs: Record<string, unknown>, now = NOW): ReturnType<typeof evaluateRule> =>
  evaluateRule({ ruleId: RULE_TASK_OVERDUE, refs: [], inputs, now });

test('RULE-01 task-overdue equals the Plan review and nudge date comparison for every open status', () => {
  const today = workDayAt(NOW);
  assert.equal(today, '2026-10-22');
  const days = ['2026-10-21', '2026-10-22', '2026-10-23', '2025-12-31'];
  for (const status of ['backlog', 'in-progress', 'waiting']) {
    for (const due of [...days, null]) {
      const rule = overdue({ status, archived: false, dueDate: due }).outcome === 'matched';
      const review = heuristicProposals([{ id: 'x', title: 'x', body: '', status, priority: 'medium', project_id: 'p', due_date: due, waiting_on: null,
        created_at: '2026-10-01T00:00:00Z', updated_at: `${today}T00:00:00Z` }], today).some((p) => p.action === 'reschedule');
      const nudge = scoreAtRisk({ id: 'x', title: 'x', status, priority: 'medium', project_id: 'p', due_date: due, reschedule_count: 0, updated_at: `${today}T00:00:00Z` }, today)
        ?.reason.toLowerCase().includes('overdue') ?? false;
      assert.equal(rule, review, `${status}/${due} vs plan review`);
      // Nudges only surface a task once the score reaches a threshold (3+ days late), so compare where it applies.
      if (!rule || (due !== null && due <= '2026-10-19')) assert.equal(rule, nudge, `${status}/${due} vs nudges`);
      else assert.equal(nudge, false, `${status}/${due} below the nudge threshold`);
    }
  }
});

test('RULE-02 the work day and due-date reading match the existing helpers, including across UK midnight', () => {
  for (const iso of ['2026-10-22T09:00:00Z', '2026-10-22T23:30:00Z', '2026-03-28T23:30:00Z', '2026-03-29T00:30:00Z']) {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
    try { assert.equal(workDayAt(new Date(iso)), workDay(undefined), iso); } finally { mock.timers.reset(); }
  }
  // 23:30Z in October is 00:30 BST the next day, so a task due on the 22nd is overdue.
  assert.equal(overdue({ status: 'backlog', archived: false, dueDate: '2026-10-22' }, new Date('2026-10-22T23:30:00Z')).outcome, 'matched');
  assert.equal(overdue({ status: 'backlog', archived: false, dueDate: '2026-10-22' }).outcome, 'not_matched');
  for (const value of [new Date(2026, 9, 21), '2026-10-21', '2026-10-21T23:59:00.000Z', null]) {
    assert.equal(normaliseDueDate(value), rowToTask({ id: 'x', status: 'backlog', due_date: value }).dueDate, String(value));
  }
});

test('RULE-03 overdue and blocked edge cases: completed, archived, undated, legacy blocked, unreadable', () => {
  assert.equal(overdue({ status: 'completed', archived: false, dueDate: '2026-01-01' }).applicability, 'not_applicable');
  assert.equal(overdue({ status: 'backlog', archived: true, dueDate: '2026-01-01' }).outcome, 'not_matched');
  assert.equal(overdue({ status: 'backlog', archived: false, dueDate: null }).applicability, 'not_applicable');
  assert.equal(overdue({ status: 'bogus', archived: false, dueDate: '2026-01-01' }).outcome, 'unknown');
  assert.equal(overdue({ status: 'backlog', archived: false, dueDate: undefined }).outcome, 'unknown');
  const blocked = (status: string): string => evaluateRule({ ruleId: RULE_TASK_BLOCKED, refs: [], inputs: { status, archived: false }, now: NOW }).outcome;
  assert.equal(blocked('blocked'), 'matched');
  assert.equal(blocked('awaiting-feedback'), 'matched');
  assert.equal(blocked('waiting'), 'matched');
  assert.equal(blocked('in-progress'), 'not_matched');
  assert.equal(blocked('nonsense'), 'unknown');
});

test('RULE-04 decision-review-due and linked-open-work over the fixtures, with results shaped for audit', async () => {
  const { db } = await fixtureDb();
  const due = await evaluateDecisionReviewDue(db, SD1, ctx());
  assert.equal(due.outcome, 'matched');
  assert.equal(due.ruleId, RULE_DECISION_REVIEW_DUE);
  assert.equal(due.ruleVersion, 1);
  assert.equal(due.evaluatedAt, NOW.toISOString());
  assert.deepEqual(due.refs, [{ kind: 'decision', id: SD1 }]);
  assert.match(due.explanation, /2026-10-21/);
  assert.ok(Object.keys(due.sourceVersions).length > 0);
  const afterSupersession = await evaluateDecisionReviewDue(db, SD1, { now: new Date('2026-10-23T09:00:00Z') });
  assert.equal(afterSupersession.outcome, 'not_matched');
  assert.equal(afterSupersession.applicability, 'not_applicable');
  const noDate = await evaluateDecisionReviewDue(db, SD3, ctx());
  assert.equal(noDate.applicability, 'not_applicable');
  const work = await evaluateLinkedOpenWork(db, SD1, ctx());
  assert.equal(work.ruleId, RULE_LINKED_OPEN_WORK);
  assert.equal(work.outcome, 'matched');
  assert.match(work.explanation, /1 distinct explicit open task/);
  assert.match(work.explanation, /1 completed, 1 archived/);
  assert.match(work.explanation, /1 inferred candidate is listed separately/);
  const t1 = await evaluateTaskRule(db, RULE_TASK_OVERDUE, 't1', ctx());
  assert.equal(t1.outcome, 'matched');
  assert.equal((await evaluateTaskRule(db, RULE_TASK_BLOCKED, 't1', ctx())).outcome, 'matched');
  assert.equal(distinctLinkedWork([{ id: 'A', status: 'backlog', archived: false }, { id: ' a ', status: 'backlog', archived: false }]).duplicates, 1);
});

test('RULE-05 missing, excluded or unreadable inputs are unknown, never false or zero', async () => {
  const { db, raw } = await fixtureDb();
  assert.equal((await evaluateTaskRule(db, RULE_TASK_OVERDUE, 'ghost', ctx())).outcome, 'unknown');
  const excluded = await evaluateDecisionReviewDue(db, SD1, ctx({ excludedIds: new Set([SD1]) }));
  assert.equal(excluded.outcome, 'unknown');
  assert.equal(excluded.unavailable?.code, 'excluded');
  assert.ok(!JSON.stringify(excluded).includes('approval gate'));
  const unreadable = await evaluateLinkedOpenWork(db, SD1, ctx(), { readers: { task: async () => { throw new Error('down'); } } });
  assert.equal(unreadable.outcome, 'unknown');
  await raw.query(`UPDATE chat_decisions SET accepted_at = NULL, acceptance_origin = NULL WHERE id::text = $1`, [SD1]);
  const unaccepted = await evaluateDecisionReviewDue(db, SD1, ctx());
  assert.equal(unaccepted.outcome, 'unknown');
  assert.equal(unaccepted.unavailable?.code, 'acceptance_unknown');
});

test('RULE-06 a historical result keeps its rule version and recomputes identically', async () => {
  const { db } = await fixtureDb();
  const saved = await evaluateDecisionReviewDue(db, SD1, ctx());
  const v2: RuleDefinition = { ...DEFAULT_RULES.get(RULE_DECISION_REVIEW_DUE)!.get(1)!, version: 2, evaluate: () => ({ outcome: 'not_matched', applicability: 'applicable', explanation: 'v2' }) };
  const registry = createRuleRegistry([...[...DEFAULT_RULES.values()].flatMap((m) => [...m.values()]), v2]);
  assert.equal(evaluateRule({ ruleId: RULE_DECISION_REVIEW_DUE, refs: saved.refs, inputs: saved.inputs, now: NOW }, registry).ruleVersion, 2);
  const again = reevaluate(saved, registry);
  assert.deepEqual(again, saved);
  assert.equal(again.ruleVersion, 1);
});

test('RULE-07 rules are pure and deterministic: no model, network or database in evaluation', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((): never => { throw new Error('network used'); }) as typeof fetch;
  try {
    const inputs = { status: 'in-progress', archived: false, dueDate: '2026-10-01' };
    assert.deepEqual(overdue(inputs), overdue(inputs));
    assert.equal(overdue({ ...inputs, workDay: '2026-09-01' }).outcome, 'not_matched');
  } finally { globalThis.fetch = originalFetch; }
  assert.ok([...DEFAULT_RULES.values()].every((m) => [...m.values()].every((r) => r.evaluate.length <= 1)));
});
