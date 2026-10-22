/** Live evaluation: builds rule inputs from the bound readers, then runs the pure rule. */
import type { Pool } from 'pg';
import type { SemanticReaders } from './bindings.js';
import { resolveEntity } from './bindings.js';
import { inferredEdges, listEdges, resolveSupersession, satisfyingEdges } from './relationships.js';
import {
  DEFAULT_RULES, evaluateRule, RULE_DECISION_REVIEW_DUE, RULE_LINKED_OPEN_WORK,
  type RULE_TASK_BLOCKED, type RULE_TASK_OVERDUE, type RuleRegistry,
} from './rules.js';
import { workDayAt } from './taskSemantics.js';
import type { RuleResult, SemanticContext, SemanticRef } from './types.js';

interface Deps { readers?: SemanticReaders | undefined; registry?: RuleRegistry | undefined }

const ACCESS_REASON: Record<string, string> = {
  not_found: 'The record no longer exists.', excluded: 'The record is excluded from this conversation.', unavailable: 'The record could not be read.',
};

export async function evaluateTaskRule(db: Pool, ruleId: typeof RULE_TASK_OVERDUE | typeof RULE_TASK_BLOCKED, taskId: string, ctx: SemanticContext, deps: Deps = {}): Promise<RuleResult> {
  const ref: SemanticRef = { kind: 'task', id: taskId };
  const access = await resolveEntity(db, ref, ctx, deps.readers);
  if (access.status !== 'ok') {
    return evaluateRule({ ruleId, refs: [ref], inputs: {}, now: ctx.now, unavailable: { code: access.status, reason: ACCESS_REASON[access.status] ?? 'Unavailable.' } }, deps.registry);
  }
  const f = access.data.fields;
  return evaluateRule({
    ruleId, refs: [ref], now: ctx.now, sourceVersions: { [`task:${taskId}`]: access.data.version },
    inputs: { status: f['rawStatus'], archived: f['archived'], dueDate: f['dueDate'], workDay: workDayAt(ctx.now) },
  }, deps.registry);
}

export async function evaluateDecisionReviewDue(db: Pool, decisionId: string, ctx: SemanticContext, deps: Deps = {}): Promise<RuleResult> {
  const ref: SemanticRef = { kind: 'decision', id: decisionId };
  const access = await resolveEntity(db, ref, ctx, deps.readers);
  if (access.status !== 'ok') {
    return evaluateRule({ ruleId: RULE_DECISION_REVIEW_DUE, refs: [ref], inputs: {}, now: ctx.now, unavailable: { code: access.status, reason: ACCESS_REASON[access.status] ?? 'Unavailable.' } }, deps.registry);
  }
  const supersession = await resolveSupersession(db, ref, ctx, deps.readers);
  return evaluateRule({
    ruleId: RULE_DECISION_REVIEW_DUE, refs: [ref], now: ctx.now, sourceVersions: { [`decision:${decisionId}`]: access.data.version },
    inputs: {
      acceptance: access.data.fields['acceptance'], reviewDate: access.data.fields['reviewDate'], supersession: supersession.state, workDay: workDayAt(ctx.now),
    },
  }, deps.registry);
}

export async function evaluateLinkedOpenWork(db: Pool, decisionId: string, ctx: SemanticContext, deps: Deps = {}): Promise<RuleResult> {
  const ref: SemanticRef = { kind: 'decision', id: decisionId };
  const access = await resolveEntity(db, ref, ctx, deps.readers);
  if (access.status !== 'ok') {
    return evaluateRule({ ruleId: RULE_LINKED_OPEN_WORK, refs: [ref], inputs: {}, now: ctx.now, unavailable: { code: access.status, reason: ACCESS_REASON[access.status] ?? 'Unavailable.' } }, deps.registry);
  }
  let edges;
  try {
    edges = await listEdges(db, ref);
  } catch {
    return evaluateRule({ ruleId: RULE_LINKED_OPEN_WORK, refs: [ref], inputs: {}, now: ctx.now, unavailable: { code: 'links_unreadable', reason: 'Links could not be read.' } }, deps.registry);
  }
  const explicit = satisfyingEdges(edges.edges, 'implements').filter((e) => e.to.id === decisionId && e.from.kind === 'task');
  const inferred = inferredEdges(edges.edges, 'implements').filter((e) => e.to.id === decisionId && e.from.kind === 'task');
  const tasks: Array<{ id: string; status: string; archived: boolean }> = [];
  const versions: Record<string, string> = { [`decision:${decisionId}`]: access.data.version };
  let unreadable = 0;
  for (const edge of explicit) {
    const task = await resolveEntity(db, edge.from, ctx, deps.readers);
    if (task.status === 'ok') {
      tasks.push({ id: edge.from.id, status: String(task.data.fields['rawStatus']), archived: task.data.fields['archived'] === true });
      versions[`task:${edge.from.id}`] = task.data.version;
    } else if (task.status !== 'excluded') unreadable += 1;
  }
  return evaluateRule({
    ruleId: RULE_LINKED_OPEN_WORK, refs: [ref, ...explicit.map((e) => e.from)], now: ctx.now, sourceVersions: versions,
    inputs: { explicitTasks: tasks, inferredTaskIds: inferred.map((e) => e.from.id), unreadableTasks: unreadable, invalidLinks: edges.invalid.length },
  }, deps.registry);
}

export { DEFAULT_RULES };
