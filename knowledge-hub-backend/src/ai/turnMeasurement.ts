import type { Pool } from 'pg';
import { env } from '../config/env.js';

export interface TurnMeasurement {
  uiObserved: boolean;
  contextObserved: boolean;
  pageContentSupplied: boolean;
  modelRequests: number;
  modelErrors: number;
  transportRetries: number;
  toolResults: number;
  toolErrors: number;
  partialReads: number;
  completeReads: number;
  unavailableReads: number;
  replySaved: boolean;
  reliabilityObserved: boolean;
  capabilityLoads: number;
  capabilityDenials: number;
  blockedCapabilities: number;
  actionReceipts: number;
  actionWarnings: number;
  actionContradictions: number;
  unconfirmedActionClaims: number;
}

export const newTurnMeasurement = (): TurnMeasurement => ({
  uiObserved: false, contextObserved: false, pageContentSupplied: false,
  modelRequests: 0, modelErrors: 0, transportRetries: 0, toolResults: 0,
  toolErrors: 0, partialReads: 0, completeReads: 0, unavailableReads: 0, replySaved: false,
  reliabilityObserved: false, capabilityLoads: 0, capabilityDenials: 0, blockedCapabilities: 0,
  actionReceipts: 0, actionWarnings: 0, actionContradictions: 0, unconfirmedActionClaims: 0,
});

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Counts observations, never infers user intent, answer correctness or a successful mutation. */
export function observeTurnMeasurement(signals: TurnMeasurement, kind: string, value: unknown): void {
  const payload = object(value);
  if (kind === 'capability.catalog') signals.reliabilityObserved = true;
  if (kind === 'capability.load' && Array.isArray(payload.loaded)) signals.capabilityLoads++;
  if (kind === 'capability.denial') signals.capabilityDenials++;
  if (kind === 'capability.blocked') signals.blockedCapabilities++;
  if (kind === 'action.receipt') {
    signals.actionReceipts++;
    if (Array.isArray(payload.warnings) && payload.warnings.length > 0) signals.actionWarnings++;
  }
  if (kind === 'action.contradiction') signals.actionContradictions++;
  if (kind === 'action.unconfirmed_claim') signals.unconfirmedActionClaims++;
  if (kind === 'context.ui') signals.uiObserved = payload.uiContext !== null && payload.uiContext !== undefined;
  if (kind === 'context.resolved') {
    signals.contextObserved = true;
    const page = object(payload.pageContext);
    signals.pageContentSupplied ||= typeof page.detail === 'string' && page.detail.trim().length > 0;
  }
  if (kind === 'model.request') signals.modelRequests++;
  if (kind === 'model.error') signals.modelErrors++;
  if (kind === 'model.transport' && typeof payload.attempt === 'number' && payload.attempt > 1) signals.transportRetries++;
  if (kind === 'reply.saved') signals.replySaved = true;
  if (kind !== 'tool.result') return;
  signals.toolResults++;
  let result: Record<string, unknown>;
  try { result = object(typeof payload.content === 'string' ? JSON.parse(payload.content) : payload.content); }
  catch { return; } // Plain-text results have no structured outcome contract.
  const unavailable = ['not_found', 'excluded', 'unavailable'].includes(String(result.status));
  if (result.error !== undefined || unavailable) signals.toolErrors++;
  if (typeof payload.name !== 'string' || !payload.name.startsWith('read_')
    || payload.name === 'read_chat_turn_trace') return;
  if (result.error !== undefined || unavailable) { signals.unavailableReads++; return; }
  const record = object(result.record);
  const coverage = object(result.coverage);
  const review = object(result.review);
  if (result.code === 'budget_exhausted' || result.code === 'supporting_context_limit') { signals.unavailableReads++; return; }
  if (result.partial === true || result.status === 'partial' || record.partial === true || coverage.complete === false || review.complete === false) signals.partialReads++;
  else if (coverage.complete === true || review.complete === true) signals.completeReads++;
}

export async function beginTurnMeasurement(db: Pool, id: string, sessionId: string | undefined, input: unknown): Promise<void> {
  const payload = object(input);
  try {
    await db.query(`INSERT INTO ai_turn_measurements(id,session_id,environment,persona,requested_model)
      SELECT $1,s.id,$3,COALESCE($4,to_jsonb(s)->>'persona','general'),$5 FROM (SELECT 1) seed LEFT JOIN ai_chat_sessions s ON s.id=$2::uuid`,
    [id, sessionId ?? null, env.isDevelopment ? 'dev' : 'prod',
      typeof payload.persona === 'string' ? payload.persona : null, typeof payload.model === 'string' ? payload.model : null]);
  } catch {
    console.error('[turn-measurement] Accepted turn could not be recorded; coverage denominator is incomplete:', id);
  }
}

export async function finishTurnMeasurement(
  db: Pool, id: string, status: string, traceStarted: boolean, captureComplete: boolean, signals: TurnMeasurement,
): Promise<void> {
  try {
    await db.query(`UPDATE ai_turn_measurements SET finished_at=NOW(),status=$2,trace_started=$3,capture_complete=$4,signals=$5::jsonb WHERE id=$1`,
      [id, status, traceStarted, captureComplete, JSON.stringify(signals)]);
  } catch {
    console.error('[turn-measurement] Final measurements unavailable:', id);
  }
}
