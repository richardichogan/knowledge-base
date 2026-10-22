/** Explicit user-confirmed writes for decision semantics. Not exposed as chat tools. */
import type { Pool } from 'pg';

export type StoreResult = { ok: true } | { ok: false; code: string; reason: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Acceptance is only ever recorded from an explicit user confirmation; nothing auto-accepts. */
export async function confirmDecisionAcceptance(db: Pool, decisionId: string, confirmation: { confirmedByUser: true }, now: Date): Promise<StoreResult> {
  if (confirmation.confirmedByUser !== true) return { ok: false, code: 'confirmation_required', reason: 'Acceptance needs explicit user confirmation.' };
  const { rows } = await db.query<{ status: string; accepted_at: unknown }>(`SELECT status, accepted_at FROM chat_decisions WHERE id::text = $1`, [decisionId]);
  const row = rows[0];
  if (row === undefined) return { ok: false, code: 'not_found', reason: 'Decision not found.' };
  if (row.status !== 'decided') return { ok: false, code: 'not_decided', reason: 'Only a decided item can be accepted.' };
  if (row.accepted_at !== null) return { ok: true };
  await db.query(`UPDATE chat_decisions SET accepted_at = $2, acceptance_origin = 'user_confirmed' WHERE id::text = $1`, [decisionId, now.toISOString()]);
  return { ok: true };
}

export async function setDecisionReviewDate(db: Pool, decisionId: string, reviewDate: string | null): Promise<StoreResult> {
  if (reviewDate !== null) {
    const valid = DAY.test(reviewDate) && !Number.isNaN(Date.parse(`${reviewDate}T00:00:00Z`)) && new Date(`${reviewDate}T00:00:00Z`).toISOString().startsWith(reviewDate);
    if (!valid) return { ok: false, code: 'invalid_date', reason: 'Review date must be a real YYYY-MM-DD day.' };
  }
  const result = await db.query(`UPDATE chat_decisions SET review_date = $2 WHERE id::text = $1`, [decisionId, reviewDate]);
  return (result.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, code: 'not_found', reason: 'Decision not found.' };
}
