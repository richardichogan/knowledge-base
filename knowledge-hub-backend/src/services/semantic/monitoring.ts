/**
 * Monitoring scaffolding. Disabled unless an explicit, fully approved config is supplied. Adds no scheduler:
 * a caller (once approved) invokes runMonitoringPass. Disabled or unapproved => no evaluation, model call or notification.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { evaluateDecisionReviewDue, evaluateTaskRule } from './live.js';
import { RULE_DECISION_REVIEW_DUE, DEFAULT_RULES, type RULE_TASK_BLOCKED, type RULE_TASK_OVERDUE, type RuleRegistry } from './rules.js';
import type { RuleOutcome, RuleResult, SemanticContext } from './types.js';

export interface MonitoringConfig {
  enabled: true;
  approvedBy: string;
  approvedAt: string;
  rules: Array<{ ruleId: string; version: number }>;
  projectIds: string[];
  cadenceMinutes: number;
  notificationDestination: string;
  aiUsage: 'none';
  maxEntitiesPerRun: number;
}
export type ParsedMonitoring = { enabled: false; reason: string } | { enabled: true; config: MonitoringConfig };

export function parseMonitoringConfig(raw: unknown): ParsedMonitoring {
  if (raw === null || typeof raw !== 'object') return { enabled: false, reason: 'not_configured' };
  const c = raw as Record<string, unknown>;
  if (c['enabled'] !== true) return { enabled: false, reason: 'not_enabled' };
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  const rules = Array.isArray(c['rules']) ? c['rules'] as Array<Record<string, unknown>> : [];
  const projects = Array.isArray(c['projectIds']) ? c['projectIds'] as unknown[] : [];
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
  const ok = nonEmpty(c['approvedBy']) && nonEmpty(c['approvedAt']) && nonEmpty(c['notificationDestination']) && c['aiUsage'] === 'none'
    && positive(c['cadenceMinutes']) && positive(c['maxEntitiesPerRun'])
    && rules.length > 0 && rules.every((r) => nonEmpty(r['ruleId']) && positive(r['version']))
    && projects.length > 0 && projects.every(nonEmpty);
  if (!ok) return { enabled: false, reason: 'approval_incomplete' };
  return { enabled: true, config: raw as MonitoringConfig };
}

export const notificationKey = (ruleId: string, version: number, entityKind: string, entityId: string, inputRevision: string, outcome: RuleOutcome): string =>
  createHash('sha256').update([ruleId, version, entityKind, entityId, inputRevision, outcome].join('|')).digest('hex');

export interface NotificationSink { notify(n: { key: string; result: RuleResult; destination: string }): Promise<void> }

export interface PassSummary { ran: boolean; reason?: string; evaluated: number; notified: number; baselined: number; unknown: number; truncated: boolean }

type Evaluator = (db: Pool, ruleId: string, entityId: string, ctx: SemanticContext) => Promise<RuleResult>;

const defaultEvaluator: Evaluator = (db, ruleId, entityId, ctx) =>
  ruleId === RULE_DECISION_REVIEW_DUE ? evaluateDecisionReviewDue(db, entityId, ctx)
    : evaluateTaskRule(db, ruleId as typeof RULE_TASK_OVERDUE | typeof RULE_TASK_BLOCKED, entityId, ctx);

const entityKindOf = (ruleId: string): 'task' | 'decision' => (ruleId === RULE_DECISION_REVIEW_DUE ? 'decision' : 'task');

async function candidates(db: Pool, ruleId: string, projectIds: string[], limit: number): Promise<string[]> {
  const { rows } = entityKindOf(ruleId) === 'decision'
    ? await db.query<{ id: string }>(`SELECT d.id::text AS id FROM chat_decisions d JOIN ai_chat_sessions s ON s.id = d.session_id WHERE s.project_id::text = ANY($1) ORDER BY d.id LIMIT ${limit + 1}`, [projectIds])
    : await db.query<{ id: string }>(`SELECT id::text AS id FROM tasks WHERE project_id::text = ANY($1) ORDER BY id LIMIT ${limit + 1}`, [projectIds]);
  return rows.map((r) => r.id);
}

const REVISION_HASH_CHARS = 16;

function revisionOf(result: RuleResult): string {
  return createHash('sha256').update(JSON.stringify(result.sourceVersions)).digest('hex').slice(0, REVISION_HASH_CHARS);
}

/**
 * One pass. Notifies only on a transition into matched from a known non-matched state. A rule version with
 * no prior state is baselined silently. Unknown is recorded without erasing the last known outcome and never
 * counts as resolved.
 */
export async function runMonitoringPass(
  db: Pool, rawConfig: unknown, ctx: SemanticContext, sink: NotificationSink,
  deps: { evaluate?: Evaluator; registry?: RuleRegistry } = {},
): Promise<PassSummary> {
  const parsed = parseMonitoringConfig(rawConfig);
  const empty: PassSummary = { ran: false, evaluated: 0, notified: 0, baselined: 0, unknown: 0, truncated: false };
  if (!parsed.enabled) return { ...empty, reason: parsed.reason };
  const { config } = parsed;
  const registry = deps.registry ?? DEFAULT_RULES;
  const evaluate = deps.evaluate ?? defaultEvaluator;
  const summary: PassSummary = { ...empty, ran: true };
  let budget = config.maxEntitiesPerRun;

  for (const approved of config.rules) {
    // Only the approved version is evaluated; an unapproved newer version is never run.
    if (registry.get(approved.ruleId)?.get(approved.version) === undefined) continue;
    const ids = await candidates(db, approved.ruleId, config.projectIds, budget);
    if (ids.length > budget) summary.truncated = true;
    for (const entityId of ids.slice(0, budget)) {
      budget -= 1;
      const result = await evaluate(db, approved.ruleId, entityId, ctx);
      summary.evaluated += 1;
      const kind = entityKindOf(approved.ruleId);
      const prev = (await db.query<{ last_known_outcome: string | null }>(
        `SELECT last_known_outcome FROM semantic_rule_state WHERE rule_id=$1 AND rule_version=$2 AND entity_kind=$3 AND entity_id=$4`,
        [approved.ruleId, approved.version, kind, entityId])).rows[0];
      let known = prev?.last_known_outcome ?? null;
      if (result.outcome === 'unknown') {
        summary.unknown += 1;
      } else {
        if (prev === undefined || known === null) summary.baselined += 1;
        else if (result.outcome === 'matched' && known !== 'matched') {
          const key = notificationKey(approved.ruleId, approved.version, kind, entityId, revisionOf(result), 'matched');
          const ins = await db.query(
            `INSERT INTO semantic_notifications (idempotency_key, rule_id, rule_version, entity_kind, entity_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [key, approved.ruleId, approved.version, kind, entityId]);
          if ((ins.rowCount ?? 0) > 0) { await sink.notify({ key, result, destination: config.notificationDestination }); summary.notified += 1; }
        }
        known = result.outcome;
      }
      await db.query(
        `INSERT INTO semantic_rule_state (rule_id, rule_version, entity_kind, entity_id, last_outcome, last_known_outcome, input_revision, evaluated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (rule_id, rule_version, entity_kind, entity_id) DO UPDATE SET last_outcome=EXCLUDED.last_outcome,
           last_known_outcome=EXCLUDED.last_known_outcome, input_revision=EXCLUDED.input_revision, evaluated_at=EXCLUDED.evaluated_at`,
        [approved.ruleId, approved.version, kind, entityId, result.outcome, known, revisionOf(result), ctx.now.toISOString()]);
    }
  }
  return summary;
}
