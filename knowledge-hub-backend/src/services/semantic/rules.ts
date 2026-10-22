/**
 * Typed, pure deterministic rules over approved inputs. No model calls, SQL generation or domain writes.
 * Each result carries rule id/version, evaluated time, refs, inputs and a reproducible explanation, so a
 * historical result keeps the version it was produced with.
 */
import { isBlockedStatus, isDueDayPast, normaliseTaskStatus, workDayAt } from './taskSemantics.js';
import type { Applicability, RuleOutcome, RuleResult, SemanticRef } from './types.js';

export const RULE_TASK_OVERDUE = 'task-overdue';
export const RULE_TASK_BLOCKED = 'task-blocked';
export const RULE_DECISION_REVIEW_DUE = 'decision-review-due';
export const RULE_LINKED_OPEN_WORK = 'linked-open-work';

export interface RuleEvaluation {
  outcome: RuleOutcome;
  applicability: Applicability;
  explanation: string;
  unavailable?: { code: string; reason: string };
}

export interface RuleDefinition {
  id: string;
  version: number;
  purpose: string;
  requiredInputs: readonly string[];
  evaluate(inputs: Readonly<Record<string, unknown>>): RuleEvaluation;
}

const unknown = (code: string, reason: string, explanation: string): RuleEvaluation =>
  ({ outcome: 'unknown', applicability: 'unknown', explanation, unavailable: { code, reason } });

const notApplicable = (explanation: string): RuleEvaluation => ({ outcome: 'not_matched', applicability: 'not_applicable', explanation });

const taskOverdueV1: RuleDefinition = {
  id: RULE_TASK_OVERDUE, version: 1,
  purpose: 'Non-archived, non-completed task whose due day is strictly before the current UK work day (Plan/Today semantics).',
  requiredInputs: ['status', 'archived', 'dueDate', 'workDay'],
  evaluate(inputs) {
    const status = normaliseTaskStatus(inputs['status']);
    const dueDate = inputs['dueDate'];
    const workDay = inputs['workDay'];
    if (status === undefined) return unknown('status_unrecognised', 'The task status is not a known value.', 'The task status could not be interpreted, so overdue cannot be established.');
    if (dueDate === undefined || (dueDate !== null && typeof dueDate !== 'string') || typeof workDay !== 'string') {
      return unknown('due_date_unreadable', 'The due date could not be interpreted.', 'The due date could not be interpreted, so overdue cannot be established.');
    }
    if (inputs['archived'] === true) return notApplicable('The task is archived, so it cannot be overdue.');
    if (status === 'completed') return notApplicable('The task is completed, so it cannot be overdue.');
    if (dueDate === null) return notApplicable('The task has no due date, so it cannot be overdue.');
    const overdue = isDueDayPast(dueDate, workDay);
    return {
      outcome: overdue ? 'matched' : 'not_matched', applicability: 'applicable',
      explanation: `Due ${dueDate}; the work day is ${workDay}. The due day ${overdue ? 'has passed' : 'has not passed'}.`,
    };
  },
};

const taskBlockedV1: RuleDefinition = {
  id: RULE_TASK_BLOCKED, version: 1,
  purpose: 'Task status is explicitly the Blocked/Waiting state; never inferred from silence or age.',
  requiredInputs: ['status', 'archived'],
  evaluate(inputs) {
    const status = normaliseTaskStatus(inputs['status']);
    if (status === undefined) return unknown('status_unrecognised', 'The task status is not a known value.', 'The task status could not be interpreted, so blocked cannot be established.');
    if (inputs['archived'] === true) return notApplicable('The task is archived.');
    const blocked = isBlockedStatus(status);
    return {
      outcome: blocked ? 'matched' : 'not_matched', applicability: 'applicable',
      explanation: `Current status is "${status}"; ${blocked ? 'Waiting is the app\'s explicit blocked state' : 'it is not the explicit blocked state'}.`,
    };
  },
};

const decisionReviewDueV1: RuleDefinition = {
  id: RULE_DECISION_REVIEW_DUE, version: 1,
  purpose: 'Accepted, non-superseded decision whose explicit saved review date has passed.',
  requiredInputs: ['acceptance', 'reviewDate', 'supersession', 'workDay'],
  evaluate(inputs) {
    const supersession = inputs['supersession'];
    const reviewDate = inputs['reviewDate'];
    const workDay = inputs['workDay'];
    if (typeof workDay !== 'string') return unknown('clock_missing', 'No work day.', 'The work day is missing.');
    if (supersession === 'invalid' || supersession === 'unknown') {
      return unknown('supersession_unresolved', 'The decision\'s supersession state could not be established.', 'Supersession is invalid or unreadable, so no decision is treated as current.');
    }
    if (reviewDate === null) return notApplicable('No explicit review date is saved for this decision.');
    if (typeof reviewDate !== 'string') return unknown('review_date_unreadable', 'The review date is unreadable.', 'The review date could not be read.');
    if (inputs['acceptance'] !== 'accepted') {
      return unknown('acceptance_unknown', 'Acceptance is not recorded for this decision.', `A review date of ${reviewDate} is saved, but the decision has no recorded acceptance, so a review-due state is not established.`);
    }
    if (supersession === 'superseded') return notApplicable('The decision has been superseded.');
    const due = isDueDayPast(reviewDate, workDay);
    return {
      outcome: due ? 'matched' : 'not_matched', applicability: 'applicable',
      explanation: `Accepted, current decision; review date ${reviewDate}; the work day is ${workDay}. The review date ${due ? 'has passed' : 'has not passed'}.`,
    };
  },
};

interface LinkedTaskInput { id: string; status: string; archived: boolean }

export function distinctLinkedWork(tasks: readonly LinkedTaskInput[]): { open: string[]; completed: string[]; archived: string[]; duplicates: number } {
  const seen = new Set<string>();
  const result = { open: [] as string[], completed: [] as string[], archived: [] as string[], duplicates: 0 };
  for (const task of tasks) {
    const id = task.id.trim().toLowerCase();
    if (seen.has(id)) { result.duplicates += 1; continue; }
    seen.add(id);
    if (task.archived) result.archived.push(id);
    else if (normaliseTaskStatus(task.status) === 'completed') result.completed.push(id);
    else result.open.push(id);
  }
  return result;
}

const linkedOpenWorkV1: RuleDefinition = {
  id: RULE_LINKED_OPEN_WORK, version: 1,
  purpose: 'Distinct non-completed, non-archived tasks with explicit implements links to the decision; inferred candidates are listed separately.',
  requiredInputs: ['explicitTasks', 'inferredTaskIds', 'unreadableTasks'],
  evaluate(inputs) {
    const tasks = inputs['explicitTasks'];
    const unreadable = typeof inputs['unreadableTasks'] === 'number' ? inputs['unreadableTasks'] : 0;
    const inferred = Array.isArray(inputs['inferredTaskIds']) ? inputs['inferredTaskIds'] as string[] : [];
    if (!Array.isArray(tasks)) return unknown('links_unreadable', 'Explicit links could not be read.', 'The explicit task links could not be read, so open work is unknown.');
    const split = distinctLinkedWork(tasks as LinkedTaskInput[]);
    const detail = `Excluded: ${split.completed.length} completed, ${split.archived.length} archived, ${split.duplicates} duplicate link${split.duplicates === 1 ? '' : 's'}. ${inferred.length} inferred candidate${inferred.length === 1 ? ' is' : 's are'} listed separately and not counted.`;
    if (split.open.length === 0 && unreadable > 0) {
      return unknown('linked_task_unavailable', 'Some linked tasks could not be read.', `No readable explicit open task; ${unreadable} linked task${unreadable === 1 ? ' was' : 's were'} unavailable, so open work is unknown. ${detail}`);
    }
    return {
      outcome: split.open.length > 0 ? 'matched' : 'not_matched', applicability: 'applicable',
      explanation: `${split.open.length} distinct explicit open task${split.open.length === 1 ? '' : 's'}${unreadable > 0 ? ` (plus ${unreadable} unavailable, so the count is a minimum)` : ''}. ${detail}`,
    };
  },
};

export type RuleRegistry = ReadonlyMap<string, ReadonlyMap<number, RuleDefinition>>;

export function createRuleRegistry(definitions: readonly RuleDefinition[]): RuleRegistry {
  const registry = new Map<string, Map<number, RuleDefinition>>();
  for (const def of definitions) registry.set(def.id, new Map([...(registry.get(def.id) ?? []), [def.version, def]]));
  return registry;
}

export const DEFAULT_RULES: RuleRegistry = createRuleRegistry([taskOverdueV1, taskBlockedV1, decisionReviewDueV1, linkedOpenWorkV1]);

export function latestRuleVersion(registry: RuleRegistry, ruleId: string): number | undefined {
  const versions = [...(registry.get(ruleId)?.keys() ?? [])];
  return versions.length === 0 ? undefined : Math.max(...versions);
}

export interface RuleRequest {
  ruleId: string;
  /** Defaults to the latest version; historical results pass the version they were produced with. */
  version?: number | undefined;
  refs: SemanticRef[];
  inputs: Record<string, unknown>;
  sourceVersions?: Record<string, string>;
  now: Date;
  /** A required reader failed, was excluded or the record is missing. */
  unavailable?: { code: string; reason: string } | undefined;
}

export function evaluateRule(request: RuleRequest, registry: RuleRegistry = DEFAULT_RULES): RuleResult {
  const version = request.version ?? latestRuleVersion(registry, request.ruleId);
  const def = version === undefined ? undefined : registry.get(request.ruleId)?.get(version);
  const base = { ruleId: request.ruleId, evaluatedAt: request.now.toISOString(), refs: request.refs, sourceVersions: request.sourceVersions ?? {} };
  if (def === undefined) {
    return { ...base, ruleVersion: version ?? 0, outcome: 'unknown', applicability: 'unknown', inputs: request.inputs,
      unavailable: { code: 'unknown_rule', reason: 'No such rule version.' }, explanation: 'The rule definition is not available.' };
  }
  const inputs = { ...request.inputs, workDay: request.inputs['workDay'] ?? workDayAt(request.now) };
  if (request.unavailable !== undefined) {
    return { ...base, ruleVersion: def.version, outcome: 'unknown', applicability: 'unknown', inputs, unavailable: request.unavailable,
      explanation: `A required input is unavailable (${request.unavailable.reason}); the result is unknown, not false or zero.` };
  }
  const evaluation = def.evaluate(inputs);
  return {
    ...base, ruleVersion: def.version, outcome: evaluation.outcome, applicability: evaluation.applicability, inputs,
    ...(evaluation.unavailable !== undefined ? { unavailable: evaluation.unavailable } : {}), explanation: evaluation.explanation,
  };
}

/** Recomputes a saved result from its own inputs, clock and rule version: no live reads and no model call. */
export function reevaluate(saved: RuleResult, registry: RuleRegistry = DEFAULT_RULES): RuleResult {
  return evaluateRule({
    ruleId: saved.ruleId, version: saved.ruleVersion, refs: saved.refs, inputs: saved.inputs,
    sourceVersions: saved.sourceVersions, now: new Date(saved.evaluatedAt), unavailable: saved.unavailable,
  }, registry);
}
