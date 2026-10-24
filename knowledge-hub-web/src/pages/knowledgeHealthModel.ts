/**
 * pages/knowledgeHealthModel.ts — wording and formatting for the Knowledge health family table.
 * A null count is shown as "Not measured"; nothing here derives a percentage or a "coverage" figure.
 */
import type { HealthFamily, HealthFamilyState, HealthSemanticState, HealthRetrievalQuality } from '../services/api';

export const FAMILY_STATE_LABEL: Record<HealthFamilyState, string> = {
  'up-to-date': 'Up to date',
  partial: 'Partial coverage',
  'unsupported-extraction': 'Unsupported extraction',
  'not-configured': 'Not configured',
  'temporarily-unavailable': 'Temporarily unavailable',
  excluded: 'Excluded by design',
};

export const SEMANTIC_STATE_LABEL: Record<HealthSemanticState, string> = {
  'not-configured': 'Not configured',
  'coverage-not-measured': 'Connected, coverage not measured',
  'pending-work': 'Indexing pending',
  'temporarily-unavailable': 'Temporarily unavailable',
  'up-to-date': 'Up to date',
};

const ERROR_LABEL: Record<HealthFamily['errorCategories'][number], string> = {
  'sync-errors': 'Latest sync reported errors',
  'sync-run-failed': 'A recent sync run failed',
};

export const NOT_MEASURED = 'Not measured';

export function retrievalQualityStats(quality: HealthRetrievalQuality): Array<{ key: string; label: string; value: number | null }> {
  const metrics = [
    ['Audited turns', 'auditedTurns'], ['Scope measured', 'scopeMeasuredTurns'],
    ['Explicit collections', 'scopedTurns'], ['Scope drift prevented', 'blockedScopeTurns'],
    ['Time-constrained turns', 'temporalTurns'], ['Default seven-day windows', 'defaultWindowTurns'],
    ['Follow-up scopes retained', 'inheritedScopeTurns'], ['Found but not read', 'foundNotRead'],
    ['Possible deferred retries', 'deferredRecoveryTurns'],
    ['Full-document reviews', 'documentReviews'], ['Document characters processed', 'documentReadChars'],
    ['Reading checkpoints saved', 'documentCheckpoints'],
    ['Unverified quote warnings', 'quoteWarningTurns'], ['Tool errors', 'toolErrorTurns'],
    ['Retrieval budgets hit', 'budgetHitTurns'], ['No retrieval (not necessarily wrong)', 'noRetrievalTurns'],
  ] as const;
  const scopeOnly = new Set(['scopedTurns', 'blockedScopeTurns', 'temporalTurns', 'defaultWindowTurns', 'inheritedScopeTurns', 'deferredRecoveryTurns', 'documentReviews', 'documentReadChars', 'documentCheckpoints']);
  return metrics.map(([label, key]) => ({
    key, label, value: quality.scopeMeasuredTurns === 0 && scopeOnly.has(key) ? null : quality[key],
  }));
}

export function countCell(value: number | null, format: (n: number) => string = String): string {
  return value === null ? NOT_MEASURED : format(value);
}

export function errorSummary(family: HealthFamily): string {
  return family.errorCategories.length === 0 ? 'None reported' : family.errorCategories.map((c) => ERROR_LABEL[c]).join(' · ');
}

export function extractionSummary(family: HealthFamily, format: (n: number) => string = String): string {
  const e = family.extraction;
  if (e === null) return NOT_MEASURED;
  return `${format(e.fullText)} full text · ${format(e.metadataOnly)} metadata only · ${format(e.atIngestionCap)} at size cap`;
}

/** The state class suffix, so each finite state is styled by class rather than inline. */
export function stateTone(state: HealthFamilyState): 'ok' | 'warn' | 'muted' {
  if (state === 'up-to-date') return 'ok';
  if (state === 'not-configured' || state === 'excluded') return 'muted';
  return 'warn';
}
