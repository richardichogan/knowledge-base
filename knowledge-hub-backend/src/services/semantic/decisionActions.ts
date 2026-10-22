/** Validated, typed-error entry points for the explicit user actions on a decision. The route is a thin wrapper over these. */
import type { Pool } from 'pg';
import { confirmDecisionAcceptance, setDecisionReviewDate } from './decisionStore.js';
import { listEdges, recordEdge, resolveSupersession, type SupersessionState } from './relationships.js';
import type { SemanticContext, SemanticEdge, SemanticRef } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const MAX_ID_CHARS = 64;

export interface ActionError { status: number; code: string; message: string; fields?: Record<string, string> }
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export interface DecisionSemantics {
  id: string;
  status: string;
  acceptance: 'accepted' | 'unknown';
  acceptedAt: string | null;
  reviewDate: string | null;
  supersession: SupersessionState;
  edges: Array<Pick<SemanticEdge, 'relationship' | 'from' | 'to' | 'origin' | 'effectiveAt'>>;
}

export type LinkRelationship = 'implements' | 'supersedes' | 'superseded_by';
const LINK_RELATIONSHIPS: readonly string[] = ['implements', 'supersedes', 'superseded_by'];

const fail = (status: number, code: string, message: string, fields?: Record<string, string>): { ok: false; error: ActionError } =>
  ({ ok: false, error: { status, code, message, ...(fields === undefined ? {} : { fields }) } });

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ID_CHARS;

function storeFailure(code: string, reason: string): { ok: false; error: ActionError } {
  if (code === 'not_found') return fail(HTTP_NOT_FOUND, 'DECISION_NOT_FOUND', reason);
  if (code === 'not_decided') return fail(HTTP_CONFLICT, 'DECISION_NOT_DECIDED', reason);
  if (code === 'invalid_date') return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', reason, { reviewDate: reason });
  return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', reason);
}

export async function readDecisionSemantics(db: Pool, id: string, ctx: SemanticContext): Promise<ActionResult<DecisionSemantics>> {
  if (!validId(id)) return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', 'A decision id is required.', { id: 'required' });
  const { rows } = await db.query<{ status: string; accepted_at: unknown; acceptance_origin: string | null; review_date: unknown }>(
    `SELECT status, accepted_at, acceptance_origin, to_char(review_date, 'YYYY-MM-DD') AS review_date FROM chat_decisions WHERE id::text = $1`, [id]);
  const row = rows[0];
  if (row === undefined) return fail(HTTP_NOT_FOUND, 'DECISION_NOT_FOUND', 'Decision not found.');
  const ref: SemanticRef = { kind: 'decision', id };
  const [edges, supersession] = await Promise.all([listEdges(db, ref), resolveSupersession(db, ref, ctx)]);
  const accepted = row.acceptance_origin === 'user_confirmed' && row.accepted_at !== null;
  return {
    ok: true,
    data: {
      id, status: row.status, acceptance: accepted ? 'accepted' : 'unknown',
      acceptedAt: row.accepted_at instanceof Date ? row.accepted_at.toISOString() : typeof row.accepted_at === 'string' ? row.accepted_at : null,
      reviewDate: typeof row.review_date === 'string' ? row.review_date : null, supersession,
      edges: edges.edges.map((e) => ({ relationship: e.relationship, from: e.from, to: e.to, origin: e.origin, effectiveAt: e.effectiveAt })),
    },
  };
}

export async function confirmAcceptance(db: Pool, id: string, body: unknown, ctx: SemanticContext): Promise<ActionResult<DecisionSemantics>> {
  if (!validId(id)) return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', 'A decision id is required.', { id: 'required' });
  if ((body as { confirmed?: unknown } | null)?.confirmed !== true) {
    return fail(HTTP_BAD_REQUEST, 'CONFIRMATION_REQUIRED', 'Acceptance needs explicit user confirmation ({ "confirmed": true }).', { confirmed: 'must be true' });
  }
  const result = await confirmDecisionAcceptance(db, id, { confirmedByUser: true }, ctx.now);
  return result.ok ? readDecisionSemantics(db, id, ctx) : storeFailure(result.code, result.reason);
}

export async function updateReviewDate(db: Pool, id: string, body: unknown, ctx: SemanticContext): Promise<ActionResult<DecisionSemantics>> {
  if (!validId(id)) return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', 'A decision id is required.', { id: 'required' });
  const value = (body as { reviewDate?: unknown } | null)?.reviewDate;
  if (value !== null && typeof value !== 'string') return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', 'reviewDate must be a YYYY-MM-DD string or null.', { reviewDate: 'string or null' });
  const result = await setDecisionReviewDate(db, id, value);
  return result.ok ? readDecisionSemantics(db, id, ctx) : storeFailure(result.code, result.reason);
}

/**
 * implements: the counterpart task implements this decision. supersedes: this decision supersedes the counterpart.
 * superseded_by: the counterpart supersedes this decision. Always recorded as user_confirmed.
 */
export async function recordDecisionLink(db: Pool, id: string, body: unknown, ctx: SemanticContext): Promise<ActionResult<DecisionSemantics>> {
  if (!validId(id)) return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', 'A decision id is required.', { id: 'required' });
  const input = (body ?? {}) as { relationship?: unknown; counterpartId?: unknown; effectiveAt?: unknown };
  const fields: Record<string, string> = {};
  if (typeof input.relationship !== 'string' || !LINK_RELATIONSHIPS.includes(input.relationship)) fields['relationship'] = `one of ${LINK_RELATIONSHIPS.join(', ')}`;
  if (!validId(input.counterpartId)) fields['counterpartId'] = 'required';
  if (input.effectiveAt !== undefined && input.effectiveAt !== null && (typeof input.effectiveAt !== 'string' || Number.isNaN(Date.parse(input.effectiveAt)))) fields['effectiveAt'] = 'must be a valid date';
  if (Object.keys(fields).length > 0) return fail(HTTP_BAD_REQUEST, 'VALIDATION_ERROR', 'The link is not valid.', fields);
  const relationship = input.relationship as LinkRelationship;
  const counterpart = input.counterpartId as string;
  const effectiveAt = typeof input.effectiveAt === 'string' ? new Date(input.effectiveAt).toISOString() : null;
  const self: SemanticRef = { kind: 'decision', id };
  const edge: Omit<SemanticEdge, 'storage'> = relationship === 'implements'
    ? { relationship: 'implements', from: { kind: 'task', id: counterpart }, to: self, origin: 'user_confirmed', effectiveAt: null }
    : { relationship: 'supersedes', from: relationship === 'supersedes' ? self : { kind: 'decision', id: counterpart }, to: relationship === 'supersedes' ? { kind: 'decision', id: counterpart } : self, origin: 'user_confirmed', effectiveAt: effectiveAt ?? ctx.now.toISOString() };
  const result = await recordEdge(db, edge, ctx);
  if (!result.ok) {
    const status = result.code === 'dangling' || result.code === 'not_found' ? HTTP_NOT_FOUND : result.code === 'cycle' ? HTTP_CONFLICT : HTTP_UNPROCESSABLE;
    return fail(status, `EDGE_${result.code.toUpperCase()}`, result.reason);
  }
  return readDecisionSemantics(db, id, ctx);
}
