/**
 * Nightly BAU review of knowledge-orchestrated chat turns. Model-free: it only aggregates the ids, counts and
 * categories already stored in knowledge_turn_audit, upserts one knowledge_daily_review row and prunes old audit rows.
 */
import type { Pool } from 'pg';
import { TURN_CATEGORIES, type TurnCategory } from '../ai/knowledge/turnAudit.js';

export const AUDIT_RETENTION_DAYS = 90;
export const CRITICAL_CATEGORIES: readonly TurnCategory[] = ['bad_citation', 'unverified_quote', 'wrong_abstain', 'tool_error'];
export const REVIEW_THRESHOLDS = { criticalRate: 0.05, noRetrievalRate: 0.1, abstainWithEvidenceRate: 0.05, minTurns: 5 } as const;
const RATE_PRECISION = 10_000;
const DATE_LENGTH = 10;
const WORST_TURN_LIMIT = 10;
const MAX_REVIEW_ROWS = 20_000;

/** Higher = worse. Ok turns never appear among the worst. */
const SEVERITY: Record<TurnCategory, number> = {
  ok: 0, no_retrieval: 1, partial: 2, budget_hit: 3, found_not_read: 4, unverified_quote: 5, source_unavailable: 6,
  bad_citation: 7, wrong_abstain: 8, tool_error: 9,
};

export interface AuditRowSummary { id: string | number; session_id: string | null; category: string; duration_ms: number }

export interface DailyReview {
  turns: number;
  categoryCounts: Record<string, number>;
  rates: { criticalRate: number; noRetrievalRate: number; abstainWithEvidenceRate: number };
  worstTurns: Array<{ id: string; sessionId: string | null; category: string; durationMs: number }>;
  flags: { criticalRate: boolean; noRetrievalRate: boolean; abstainWithEvidence: boolean; lowSample: boolean };
}

export function buildDailyReview(rows: readonly AuditRowSummary[]): DailyReview {
  const categoryCounts: Record<string, number> = Object.fromEntries(TURN_CATEGORIES.map((c) => [c, 0]));
  for (const r of rows) categoryCounts[r.category] = (categoryCounts[r.category] ?? 0) + 1;
  const turns = rows.length;
  const rate = (n: number): number => (turns === 0 ? 0 : Math.round((n / turns) * RATE_PRECISION) / RATE_PRECISION);
  const critical = CRITICAL_CATEGORIES.reduce((n, c) => n + (categoryCounts[c] ?? 0), 0);
  const rates = {
    criticalRate: rate(critical),
    noRetrievalRate: rate(categoryCounts['no_retrieval'] ?? 0),
    abstainWithEvidenceRate: rate(categoryCounts['wrong_abstain'] ?? 0),
  };
  const worstTurns = rows
    .filter((r) => (SEVERITY[r.category as TurnCategory] ?? 0) > 0)
    .sort((a, b) => (SEVERITY[b.category as TurnCategory] ?? 0) - (SEVERITY[a.category as TurnCategory] ?? 0) || b.duration_ms - a.duration_ms)
    .slice(0, WORST_TURN_LIMIT)
    .map((r) => ({ id: String(r.id), sessionId: r.session_id, category: r.category, durationMs: r.duration_ms }));
  return {
    turns, categoryCounts, rates, worstTurns,
    flags: {
      criticalRate: rates.criticalRate > REVIEW_THRESHOLDS.criticalRate,
      noRetrievalRate: rates.noRetrievalRate > REVIEW_THRESHOLDS.noRetrievalRate,
      abstainWithEvidence: rates.abstainWithEvidenceRate > REVIEW_THRESHOLDS.abstainWithEvidenceRate,
      lowSample: turns < REVIEW_THRESHOLDS.minTurns,
    },
  };
}

/** The UTC calendar day before `now`, as YYYY-MM-DD. */
export function yesterdayUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))  .toISOString().slice(0, DATE_LENGTH);
}

export async function runKnowledgeNightlyReviewJob(db: Pool, now: Date = new Date()): Promise<DailyReview> {
  const day = yesterdayUtc(now);
  const { rows } = await db.query(
    `SELECT id, session_id, category, duration_ms FROM knowledge_turn_audit
     WHERE created_at >= $1::date AND created_at < ($1::date + 1) ORDER BY id LIMIT ${MAX_REVIEW_ROWS}`, [day]);
  const review = buildDailyReview(rows as AuditRowSummary[]);
  await db.query(
    `INSERT INTO knowledge_daily_review (review_date, turns, category_counts, rates, worst_turns, flags)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)
     ON CONFLICT (review_date) DO UPDATE SET turns = EXCLUDED.turns, category_counts = EXCLUDED.category_counts,
       rates = EXCLUDED.rates, worst_turns = EXCLUDED.worst_turns, flags = EXCLUDED.flags, created_at = now()`,
    [day, review.turns, JSON.stringify(review.categoryCounts), JSON.stringify(review.rates), JSON.stringify(review.worstTurns), JSON.stringify(review.flags)]);
  await db.query(`DELETE FROM knowledge_turn_audit WHERE created_at < $1::timestamptz - ($2 || ' days')::interval`, [now.toISOString(), String(AUDIT_RETENTION_DAYS)]);
  const flagged = Object.entries(review.flags).filter(([, on]) => on).map(([name]) => name);
  console.warn(`[knowledge-review] ${day}: ${review.turns.toString()} turns, flags: ${flagged.length === 0 ? 'none' : flagged.join(', ')}`);
  return review;
}
