/**
 * Advisory decision review. Output keeps four parts separate: the recorded decision (with acceptance and
 * supersession), deterministic facts, advisory inference with counterevidence, and a suggested next step
 * that is never executed. Read-only: nothing here writes, revokes or supersedes a decision.
 */
import type { Pool } from 'pg';
import { parseSourceRef, resolveEntity, type SemanticReaders } from './bindings.js';
import { evaluateDecisionReviewDue, evaluateLinkedOpenWork, evaluateTaskRule } from './live.js';
import { inferredEdges, listEdges, resolveSupersession, satisfyingEdges, type SupersessionState } from './relationships.js';
import { RULE_TASK_BLOCKED, RULE_TASK_OVERDUE } from './rules.js';
import type { RuleResult, SemanticContext, SemanticRef } from './types.js';

const MAX_DECISIONS = 10;
const MAX_EVIDENCE = 8;
const MIN_STEM = 6;
const MEDIUM_STEMS = 2;
const FIRST_PARAM_OFFSET = 3;
const EXCERPT_CHARS = 600;
const AMOUNT = /(?:GBP|£)\s?(\d[\d,]*)/gi;

export interface EvidenceItem { ref: SemanticRef; title: string; excerpt: string; publishedAt: string | null; truncated: boolean }
export type NewerEvidenceFinder = (db: Pool, decision: { id: string; text: string; createdAt: string | null; projectId: string | null }, ctx: SemanticContext) => Promise<EvidenceItem[]>;
export interface Assessment { evidence: SemanticRef; summary: string; confidence: 'low' | 'medium'; counterevidence: string[] }
export type Assessor = (input: { decisionText: string; rationale: EvidenceItem[]; newer: EvidenceItem[] }) => Assessment[];

export interface ReviewOptions {
  projectId: string | null;
  decisionId?: string | undefined;
  finder?: NewerEvidenceFinder | undefined;
  assessor?: Assessor | undefined;
  readers?: SemanticReaders | undefined;
  /** Turns advisory reasoning off; recorded facts and rules still run. */
  advisoryDisabled?: boolean | undefined;
}

export interface DecisionReview {
  recorded: { ref: SemanticRef; text: string; recordedBy: string; acceptance: string; reviewDate: string | null; createdAt: string | null; supersession: SupersessionState['state']; supersededBy?: SemanticRef };
  facts: { rules: RuleResult[]; explicitTasks: SemanticRef[]; explicitRisks: Array<{ ref: SemanticRef; title: string }>; inferredTaskCandidates: SemanticRef[]; rationaleSources: Array<{ ref: SemanticRef; title: string; excerpt: string }> };
  inference: { assessments: Assessment[]; noTriggerIdentified: boolean };
  nextStep: { suggestion: string; executed: false };
  limitations: string[];
}

export interface DecisionReviewResult { reviews: DecisionReview[]; readAt: string; noWrites: true; limitations: string[] }

const stems = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= MIN_STEM).map((w) => w.slice(0, MIN_STEM)));
const amounts = (text: string): Set<string> => new Set([...text.matchAll(AMOUNT)].map((m) => (m[1] ?? '').replace(/,/g, '')));

/** Deterministic default: a differing money amount plus shared vocabulary is a lead, never a verdict. */
export const heuristicAssessor: Assessor = ({ decisionText, rationale, newer }) => {
  const basis = [decisionText, ...rationale.map((r) => `${r.title} ${r.excerpt}`)].join(' ');
  const basisStems = stems(basis);
  const basisAmounts = amounts(basis);
  const out: Assessment[] = [];
  for (const item of newer) {
    const text = `${item.title} ${item.excerpt}`;
    const shared = [...stems(text)].filter((s) => basisStems.has(s));
    const itemAmounts = amounts(text);
    const differing = basisAmounts.size > 0 && itemAmounts.size > 0 && [...itemAmounts].every((a) => !basisAmounts.has(a));
    if (!differing || shared.length === 0) continue;
    out.push({
      evidence: item.ref, confidence: shared.length >= MEDIUM_STEMS ? 'medium' : 'low',
      summary: `Newer source "${item.title}" states a different amount (${[...itemAmounts].join(', ')}) from the basis for this decision (${[...basisAmounts].join(', ')}). The assumptions may have changed, so a review may be worthwhile.`,
      counterevidence: [
        'A newer source is not automatically more authoritative than the recorded rationale.',
        'The amounts may refer to different thresholds, scopes or dates; this is a keyword-level comparison, not a reading of intent.',
        'The decision itself is unchanged by this source.',
      ],
    });
  }
  return out;
};

const defaultFinder: NewerEvidenceFinder = async (db, decision, ctx) => {
  const words = [...stems(decision.text)];
  if (words.length === 0) return [];
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id::text AS id, title, COALESCE(NULLIF(summary,''), body, '') AS text, published_at FROM content_items
      WHERE ($1::timestamptz IS NULL OR published_at > $1::timestamptz) AND published_at <= $2::timestamptz
        AND (${words.map((_, i) => `title ILIKE $${i + FIRST_PARAM_OFFSET} OR summary ILIKE $${i + FIRST_PARAM_OFFSET}`).join(' OR ')})
      ORDER BY published_at DESC LIMIT ${MAX_EVIDENCE}`,
    [decision.createdAt, ctx.now.toISOString(), ...words.map((w) => `%${w}%`)]);
  return rows.map((r) => {
    const text = String(r['text'] ?? '');
    return { ref: { kind: 'source', id: `content_item:${String(r['id'])}` }, title: String(r['title'] ?? ''), excerpt: text.slice(0, EXCERPT_CHARS), truncated: text.length > EXCERPT_CHARS,
      publishedAt: r['published_at'] instanceof Date ? r['published_at'].toISOString() : null };
  });
};

function nextStep(review: Pick<DecisionReview, 'recorded' | 'inference' | 'facts'>): string {
  if (review.recorded.supersession === 'invalid') return 'Resolve the invalid supersession links before relying on this decision.';
  if (review.recorded.acceptance !== 'accepted') return 'Confirm whether this decision was accepted; until then treat it as unconfirmed.';
  if (review.inference.assessments.length > 0) return 'Consider reviewing this decision against the newer source(s); this is a suggestion only and nothing has been changed.';
  return 'No change suggested.';
}

async function review(db: Pool, row: { id: string }, opts: ReviewOptions, ctx: SemanticContext): Promise<DecisionReview | null> {
  const ref: SemanticRef = { kind: 'decision', id: row.id };
  const access = await resolveEntity(db, ref, ctx, opts.readers);
  if (access.status !== 'ok') return null;
  const f = access.data.fields;
  const limitations: string[] = [];
  const supersession = await resolveSupersession(db, ref, ctx, opts.readers);
  const edges = await listEdges(db, ref);

  const rationale: EvidenceItem[] = [];
  const rationaleSources: DecisionReview['facts']['rationaleSources'] = [];
  for (const edge of satisfyingEdges(edges.edges, 'supported_by').filter((e) => e.from.id === row.id)) {
    const src = await resolveEntity(db, edge.to, ctx, opts.readers);
    if (src.status === 'excluded') { limitations.push('A supporting source is excluded from this conversation and was not read.'); continue; }
    if (src.status !== 'ok') { limitations.push('A supporting source could not be read.'); continue; }
    const excerpt = String(src.data.fields['excerpt'] ?? '');
    rationale.push({ ref: edge.to, title: src.data.title, excerpt, publishedAt: (src.data.fields['publishedAt'] as string | null) ?? null, truncated: src.data.fields['truncated'] === true });
    rationaleSources.push({ ref: edge.to, title: src.data.title, excerpt });
  }
  if (rationaleSources.length === 0 && !limitations.some((l) => l.includes('supporting source'))) limitations.push('No explicit supporting rationale is linked to this decision.');

  const rules: RuleResult[] = [await evaluateDecisionReviewDue(db, row.id, ctx, opts), await evaluateLinkedOpenWork(db, row.id, ctx, opts)];
  const explicitTasks = satisfyingEdges(edges.edges, 'implements').filter((e) => e.to.id === row.id).map((e) => e.from);
  for (const task of explicitTasks) {
    for (const ruleId of [RULE_TASK_OVERDUE, RULE_TASK_BLOCKED] as const) rules.push(await evaluateTaskRule(db, ruleId, task.id, ctx, opts));
  }
  const explicitRisks: DecisionReview['facts']['explicitRisks'] = [];
  for (const edge of satisfyingEdges(edges.edges, 'affects').filter((e) => e.to.id === row.id && e.from.kind === 'risk')) {
    const risk = await resolveEntity(db, edge.from, ctx, opts.readers);
    if (risk.status === 'ok') explicitRisks.push({ ref: edge.from, title: risk.data.title });
  }
  const inferredTaskCandidates = inferredEdges(edges.edges, 'implements').filter((e) => e.to.id === row.id).map((e) => e.from);

  let assessments: Assessment[] = [];
  let noTrigger = false;
  if (opts.advisoryDisabled === true) {
    limitations.push('Advisory reasoning is disabled; only recorded facts and rules are shown.');
  } else {
    let newer: EvidenceItem[] = [];
    let searched = true;
    try {
      newer = (await (opts.finder ?? defaultFinder)(db, { id: row.id, text: String(f['text']), createdAt: (f['createdAt'] as string | null) ?? null, projectId: access.data.projectId }, ctx))
        .filter((item) => !ctx.excludedIds?.has(item.ref.id) && !ctx.excludedIds?.has(parseSourceRef(item.ref)?.id ?? item.ref.id));
    } catch {
      searched = false;
      limitations.push('newer_evidence_unavailable: newer evidence could not be searched, so absence of a trigger is not established.');
    }
    assessments = (opts.assessor ?? heuristicAssessor)({ decisionText: String(f['text']), rationale, newer });
    noTrigger = searched && assessments.length === 0;
    if (noTrigger) limitations.push('No review trigger was identified within the searched scope; this does not prove the decision still holds.');
  }

  const base = { recorded: {
    ref, text: String(f['text']), recordedBy: String(f['recordedBy']), acceptance: String(f['acceptance']), reviewDate: (f['reviewDate'] as string | null) ?? null,
    createdAt: (f['createdAt'] as string | null) ?? null, supersession: supersession.state,
    ...(supersession.state === 'superseded' ? { supersededBy: supersession.by } : {}),
  }, facts: { rules, explicitTasks, explicitRisks, inferredTaskCandidates, rationaleSources }, inference: { assessments, noTriggerIdentified: noTrigger } };
  return { ...base, nextStep: { suggestion: nextStep(base), executed: false }, limitations };
}

export async function reviewDecisions(db: Pool, opts: ReviewOptions, ctx: SemanticContext): Promise<DecisionReviewResult> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT d.id::text AS id FROM chat_decisions d LEFT JOIN ai_chat_sessions s ON s.id = d.session_id
      WHERE d.status = 'decided' AND ($1::text IS NULL OR s.project_id::text = $1) AND ($2::text IS NULL OR d.id::text = $2)
      ORDER BY d.created_at LIMIT ${MAX_DECISIONS}`, [opts.projectId, opts.decisionId ?? null]);
  const reviews: DecisionReview[] = [];
  for (const row of rows) {
    const item = await review(db, row, opts, ctx);
    if (item !== null) reviews.push(item);
  }
  return { reviews, readAt: ctx.now.toISOString(), noWrites: true, limitations: reviews.length === 0 ? ['No readable recorded decisions were found in scope.'] : [] };
}
