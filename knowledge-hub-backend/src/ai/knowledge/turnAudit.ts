/**
 * Per-turn outcome audit for BAU monitoring. Stores ids, counts and categories only, never message text.
 * Recording is failure-isolated and must never delay or alter a reply.
 */
import { isKnowledgeOrchestrationEnabled } from './budgets.js';
import { CITATION_FAILURE } from './citations.js';

export const TURN_CATEGORIES = [
  'ok', 'no_retrieval', 'found_not_read', 'bad_citation', 'unverified_quote', 'wrong_abstain',
  'budget_hit', 'source_unavailable', 'tool_error', 'partial',
] as const;
export type TurnCategory = (typeof TURN_CATEGORIES)[number];

export interface TurnSignals {
  retrievalUsed: boolean;
  deterministicPath: boolean;
  found: number;
  read: number;
  cited: number;
  strippedIds: number;
  unverifiedQuotes: number;
  repairsUsed: number;
  abstained: boolean;
  budgetExhausted: readonly string[];
  partial: boolean;
  toolErrorCount: number;
  unavailableSources: readonly string[];
}

/** First matching category wins; ordered from most to least severe. */
export function classifyTurn(s: TurnSignals): TurnCategory {
  if (s.toolErrorCount > 0) return 'tool_error';
  if (s.unavailableSources.length > 0) return 'source_unavailable';
  if (s.abstained && (s.found > 0 || s.read > 0)) return 'wrong_abstain';
  if (s.strippedIds > 0 || s.repairsUsed > 0) return 'bad_citation';
  if (s.unverifiedQuotes > 0) return 'unverified_quote';
  if (s.budgetExhausted.length > 0) return 'budget_hit';
  if (s.retrievalUsed && s.found > 0 && s.read === 0) return 'found_not_read';
  if (s.partial) return 'partial';
  if (!s.retrievalUsed && !s.deterministicPath) return 'no_retrieval';
  return 'ok';
}

const ERROR_LOG_CHARS = 120;
const ABSTAIN_PATTERN = /\b(?:i\s+(?:did\s+not|didn't|could\s+not|couldn't|can't|cannot)\s+(?:find|confirm|locate|support)|no\s+(?:matching\s+)?records?\s+(?:found|matched))\b/i;

/** Heuristic: the final answer declined to answer. Evaluated in memory; the text is never stored. */
export function looksAbstained(answer: string): boolean {
  return answer.includes(CITATION_FAILURE) || ABSTAIN_PATTERN.test(answer);
}

export interface TurnAuditRow extends TurnSignals {
  sessionId: string | null;
  assistantMessageId: string | null;
  persona: string;
  familiesRead: readonly string[];
  durationMs: number;
  modelRounds: number;
}

export interface AuditDb { query(text: string, values?: unknown[]): Promise<unknown> }

const INSERT_SQL = `INSERT INTO knowledge_turn_audit (session_id, assistant_message_id, persona, retrieval_used, deterministic_path,
  found_count, read_count, cited_count, families_read, stripped_ids, unverified_quotes, repairs_used, abstained, budget_exhausted,
  partial, tool_error_count, unavailable_sources, duration_ms, model_rounds, category)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`;

/** Never throws; resolves false when skipped or failed. Call fire-and-forget after the reply is built. */
export async function recordTurnAudit(db: AuditDb, row: TurnAuditRow, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (!isKnowledgeOrchestrationEnabled(env)) return false;
    await db.query(INSERT_SQL, [
      row.sessionId, row.assistantMessageId, row.persona, row.retrievalUsed, row.deterministicPath,
      row.found, row.read, row.cited, [...row.familiesRead], row.strippedIds, row.unverifiedQuotes, row.repairsUsed, row.abstained,
      [...row.budgetExhausted], row.partial, row.toolErrorCount, [...row.unavailableSources], Math.round(row.durationMs), row.modelRounds,
      classifyTurn(row),
    ]);
    return true;
  } catch (err) {
    console.warn('[knowledge-audit] could not record turn:', err instanceof Error ? err.message.slice(0, ERROR_LOG_CHARS) : 'unknown error');
    return false;
  }
}
