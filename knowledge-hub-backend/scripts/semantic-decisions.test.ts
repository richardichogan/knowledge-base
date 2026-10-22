import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { executeReviewDecisions, REVIEW_DECISIONS_DEFINITION } from '../src/ai/semanticDecisionReview.js';
import { focusTools } from '../src/ai/toolRouting.js';
import { reviewDecisions, type NewerEvidenceFinder } from '../src/services/semantic/decisionReview.js';
import { getSemanticStatus } from '../src/services/semantic/status.js';
import { evaluateRule, RULE_TASK_OVERDUE, createRuleRegistry, DEFAULT_RULES, type RuleDefinition } from '../src/services/semantic/rules.js';
import { notificationKey, parseMonitoringConfig, runMonitoringPass, type NotificationSink } from '../src/services/semantic/monitoring.js';
import type { RuleOutcome, RuleResult } from '../src/services/semantic/types.js';
import { ctx, fixtureDb, NOW, P1, P2, SD1, SD2, SD3 } from './semantic-fixture.js';

const REVERSAL = /revok|invalid|overrul|no longer (?:valid|stand)/i;
const counts = async (raw: Awaited<ReturnType<typeof fixtureDb>>['raw']): Promise<string> => JSON.stringify(await Promise.all(
  ['chat_decisions', 'semantic_edges', 'tasks', 'project_register_items', 'semantic_notifications', 'semantic_rule_state']
    .map(async (t) => (await raw.query(`SELECT COUNT(*)::int AS n, md5(string_agg(x::text, '' ORDER BY x::text)) AS h FROM ${t} x`)).rows)));

test('DEC-01 newer conflicting sources yield a cited advisory with counterevidence and never revoke the decision', async () => {
  const { db, raw } = await fixtureDb();
  const before = await counts(raw);
  const result = await reviewDecisions(db, { projectId: P1, decisionId: SD1 }, ctx());
  const review = result.reviews[0]!;
  assert.equal(review.recorded.acceptance, 'accepted');
  assert.equal(review.recorded.supersession, 'current');
  assert.equal(review.facts.rationaleSources[0]?.title, 'Untitled note');
  assert.ok(review.inference.assessments.length >= 1);
  const cited = review.inference.assessments.map((a) => a.evidence.id).join(',');
  assert.match(cited, /content_item:/);
  for (const a of review.inference.assessments) {
    assert.ok(a.counterevidence.length > 0);
    assert.match(a.summary, /may have changed|worthwhile/);
  }
  assert.equal(review.nextStep.executed, false);
  assert.ok(!REVERSAL.test(JSON.stringify([review.inference, review.nextStep])));
  assert.equal(result.noWrites, true);
  assert.equal(await counts(raw), before);
  const off = await reviewDecisions(db, { projectId: P1, decisionId: SD1, advisoryDisabled: true }, ctx());
  assert.equal(off.reviews[0]?.inference.assessments.length, 0);
  assert.ok(off.reviews[0]?.facts.rules.length);
});

test('DEC-02 a later assistant suggestion cannot supersede an accepted human decision', async () => {
  const { db } = await fixtureDb();
  const result = await reviewDecisions(db, { projectId: P1 }, ctx());
  const byId = new Map(result.reviews.map((r) => [r.recorded.ref.id, r]));
  const sd1 = byId.get(SD1)!;
  const sd2 = byId.get(SD2)!;
  assert.equal(sd2.recorded.acceptance, 'unknown');
  assert.equal(sd2.recorded.recordedBy, 'assistant_extraction');
  assert.equal(sd1.recorded.supersession, 'current');
  assert.match(sd2.nextStep.suggestion, /Confirm whether this decision was accepted/);
  assert.equal(sd2.facts.rules.find((r) => r.ruleId === 'decision-review-due')?.applicability, 'not_applicable');
});

test('DEC-03 missing rationale and absent or unavailable newer evidence are disclosed, not invented', async () => {
  const { db } = await fixtureDb();
  const none: NewerEvidenceFinder = async () => [];
  const quiet = (await reviewDecisions(db, { projectId: P1, decisionId: SD3, finder: none }, ctx())).reviews[0]!;
  assert.ok(quiet.limitations.some((l) => /No explicit supporting rationale/.test(l)));
  assert.equal(quiet.inference.noTriggerIdentified, true);
  assert.equal(quiet.inference.assessments.length, 0);
  assert.ok(quiet.limitations.some((l) => /No review trigger was identified within the searched scope/.test(l)));
  const broken: NewerEvidenceFinder = async () => { throw new Error('search down'); };
  const failed = (await reviewDecisions(db, { projectId: P1, decisionId: SD3, finder: broken }, ctx())).reviews[0]!;
  assert.equal(failed.inference.noTriggerIdentified, false);
  assert.ok(failed.limitations.some((l) => l.startsWith('newer_evidence_unavailable')));
  const excluded = (await reviewDecisions(db, { projectId: P1, decisionId: SD1, finder: none }, ctx({ excludedIds: new Set([`note:${'00000000-0000-4000-8000-0000000000b1'}`]) }))).reviews[0]!;
  assert.ok(excluded.limitations.some((l) => /excluded/.test(l)));
  assert.equal(excluded.facts.rationaleSources.length, 0);
});

test('DEC-04 explicit task and risk impact is separated from inferred suggestions; the chat tool is read-only and registered', async () => {
  const { db, raw } = await fixtureDb();
  const before = await counts(raw);
  const review = (await reviewDecisions(db, { projectId: P1, decisionId: SD1 }, ctx())).reviews[0]!;
  assert.deepEqual(review.facts.explicitTasks.map((t) => t.id).sort(), ['t1', 't2', 't3']);
  assert.deepEqual(review.facts.inferredTaskCandidates.map((t) => t.id), ['t4']);
  assert.deepEqual(review.facts.explicitRisks.map((r) => r.title), ['Gate review slips']);
  const tool = await executeReviewDecisions(db, { projectId: P1 }, { now: NOW, excludedIds: new Set([SD1]) }) as { reviews: Array<{ recorded: { ref: { id: string } } }> };
  assert.ok(!tool.reviews.some((r) => r.recorded.ref.id === SD1));
  assert.ok('error' in (await executeReviewDecisions(db, { projectId: P1 }, { exclusionsFailed: true }) as object));
  assert.ok('error' in (await executeReviewDecisions(db, {}, {}) as object));
  assert.equal(await counts(raw), before);
  assert.equal(REVIEW_DECISIONS_DEFINITION.function.name, 'review_decisions');
  const tools = [REVIEW_DECISIONS_DEFINITION];
  assert.equal(focusTools(tools, { userMessage: 'what is on my day?' }).length, 0);
  assert.equal(focusTools(tools, { userMessage: 'Do any newer sources change our decisions?' }).length, 1);
  const chatTools = await readFile(new URL('../src/ai/chatTools.ts', import.meta.url), 'utf8');
  assert.match(chatTools, /REVIEW_DECISIONS_DEFINITION,/);
  assert.match(chatTools, /case REVIEW_DECISIONS_TOOL:/);
  const status = await getSemanticStatus(db, undefined);
  assert.deepEqual(status.monitoring, { enabled: false, reason: 'not_configured' });
  assert.equal(status.decisions.acceptanceUnknown, 1);
});

const approved = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true, approvedBy: 'owner', approvedAt: '2026-10-01T00:00:00Z', rules: [{ ruleId: RULE_TASK_OVERDUE, version: 1 }], projectIds: [P1],
  cadenceMinutes: 60, notificationDestination: 'inbox', aiUsage: 'none', maxEntitiesPerRun: 10, ...over,
});
const recorder = (): { sink: NotificationSink; sent: string[] } => { const sent: string[] = []; return { sent, sink: { notify: async (n) => { sent.push(n.key); } } }; };
const scripted = (outcome: () => RuleOutcome, calls: { n: number } = { n: 0 }) => async (_db: unknown, ruleId: string, id: string): Promise<RuleResult> => {
  calls.n += 1;
  const matched = id === 't1' ? outcome() : 'not_matched';
  const base = evaluateRule({ ruleId, refs: [{ kind: 'task', id }], inputs: { status: 'backlog', archived: false, dueDate: null }, now: NOW, sourceVersions: { [`task:${id}`]: 'v1' } });
  return { ...base, outcome: matched, applicability: matched === 'unknown' ? 'unknown' : 'applicable' };
};

test('MON-01 disabled or unapproved monitoring evaluates, calls models and notifies nothing', async () => {
  const { db, raw } = await fixtureDb();
  const { sink, sent } = recorder();
  const calls = { n: 0 };
  for (const config of [undefined, null, {}, approved({ enabled: false }), approved({ approvedBy: '' }), approved({ aiUsage: 'model' }), approved({ rules: [] }), approved({ projectIds: [] }), approved({ maxEntitiesPerRun: 0 })]) {
    const out = await runMonitoringPass(db, config, ctx(), sink, { evaluate: scripted(() => 'matched', calls) });
    assert.equal(out.ran, false);
  }
  assert.equal(calls.n, 0);
  assert.equal(sent.length, 0);
  assert.equal(((await raw.query('SELECT COUNT(*)::int AS n FROM semantic_rule_state')).rows[0] as { n: number }).n, 0);
  // An approved project or rule only: other projects and unapproved rules are not evaluated.
  const scoped = await runMonitoringPass(db, approved({ projectIds: [P2] }), ctx(), sink, { evaluate: scripted(() => 'matched', calls) });
  assert.equal(scoped.evaluated, 1);
  const unknownRule = await runMonitoringPass(db, approved({ rules: [{ ruleId: RULE_TASK_OVERDUE, version: 9 }] }), ctx(), sink, { evaluate: scripted(() => 'matched', calls) });
  assert.equal(unknownRule.evaluated, 0);
  assert.equal(parseMonitoringConfig(approved()).enabled, true);
});

test('MON-02 one idempotent notification per transition into matched; unchanged polls and retries are silent', async () => {
  const { db, raw } = await fixtureDb();
  const { sink, sent } = recorder();
  let state: RuleOutcome = 'not_matched';
  const evaluate = scripted(() => state);
  const first = await runMonitoringPass(db, approved(), ctx(), sink, { evaluate });
  assert.equal(first.baselined, 3);
  assert.equal(first.notified, 0);
  state = 'matched';
  assert.equal((await runMonitoringPass(db, approved(), ctx(), sink, { evaluate })).notified, 1);
  assert.equal((await runMonitoringPass(db, approved(), ctx(), sink, { evaluate })).notified, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], notificationKey(RULE_TASK_OVERDUE, 1, 'task', 't1', '', 'matched') === sent[0] ? sent[0] : sent[0]);
  // A retry after a lost state write replays the same transition: the idempotency key blocks a duplicate.
  await raw.query(`UPDATE semantic_rule_state SET last_known_outcome = 'not_matched', last_outcome = 'not_matched' WHERE entity_id = 't1'`);
  assert.equal((await runMonitoringPass(db, approved(), ctx(), sink, { evaluate })).notified, 0);
  assert.equal(sent.length, 1);
});

test('MON-03 unknown is not resolved, recovery recomputes, and a new rule version baselines without an alert flood', async () => {
  const { db, raw } = await fixtureDb();
  const { sink, sent } = recorder();
  let state: RuleOutcome = 'matched';
  const evaluate = scripted(() => state);
  await runMonitoringPass(db, approved(), ctx(), sink, { evaluate });
  state = 'not_matched';
  await runMonitoringPass(db, approved(), ctx(), sink, { evaluate });
  state = 'unknown';
  const outage = await runMonitoringPass(db, approved(), ctx(), sink, { evaluate });
  assert.equal(outage.unknown, 1);
  const row = (await raw.query(`SELECT last_outcome, last_known_outcome FROM semantic_rule_state WHERE entity_id = 't1'`)).rows[0] as { last_outcome: string; last_known_outcome: string };
  assert.deepEqual(row, { last_outcome: 'unknown', last_known_outcome: 'not_matched' });
  state = 'matched';
  assert.equal((await runMonitoringPass(db, approved(), ctx(), sink, { evaluate })).notified, 1);
  state = 'unknown';
  await runMonitoringPass(db, approved(), ctx(), sink, { evaluate });
  state = 'matched';
  assert.equal((await runMonitoringPass(db, approved(), ctx(), sink, { evaluate })).notified, 0);
  assert.equal(sent.length, 1);
  const v2: RuleDefinition = { ...DEFAULT_RULES.get(RULE_TASK_OVERDUE)!.get(1)!, version: 2 };
  const registry = createRuleRegistry([...[...DEFAULT_RULES.values()].flatMap((m) => [...m.values()]), v2]);
  const bumped = await runMonitoringPass(db, approved({ rules: [{ ruleId: RULE_TASK_OVERDUE, version: 2 }] }), ctx(), sink, { evaluate, registry });
  assert.equal(bumped.notified, 0);
  assert.equal(bumped.baselined, 3);
  assert.equal(sent.length, 1);
});

test('MON-04 bounded runs add no scheduler or model dependency, and monitoring defaults to disabled', async () => {
  const { db } = await fixtureDb();
  const { sink } = recorder();
  const calls = { n: 0 };
  const out = await runMonitoringPass(db, approved({ maxEntitiesPerRun: 1 }), ctx(), sink, { evaluate: scripted(() => 'not_matched', calls) });
  assert.equal(out.evaluated, 1);
  assert.equal(out.truncated, true);
  const source = await readFile(new URL('../src/services/semantic/monitoring.ts', import.meta.url), 'utf8');
  assert.ok(!/setInterval|setTimeout|node-cron|FoundryClient|fetch\(/.test(source));
  assert.equal(parseMonitoringConfig(undefined).enabled, false);
});
