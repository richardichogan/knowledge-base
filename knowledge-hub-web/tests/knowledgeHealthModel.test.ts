import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countCell, retrievalQualityStats } from '../src/pages/knowledgeHealthModel';
import type { HealthRetrievalQuality } from '../src/services/api';

const legacy: HealthRetrievalQuality = {
  auditedTurns: 0, scopeMeasuredTurns: 0, legacyUnattributedTurns: 44,
  scopedTurns: 0, blockedScopeTurns: 0, temporalTurns: 0, defaultWindowTurns: 0, inheritedScopeTurns: 0, deferredRecoveryTurns: 0,
  documentReviews: 0, documentReadChars: 0, documentCheckpoints: 0,
  foundNotRead: 0, quoteWarningTurns: 0, toolErrorTurns: 0, budgetHitTurns: 0, noRetrievalTurns: 0,
  categories: [], legacyCategories: [{ category: 'budget_hit', turns: 12 }], note: 'Not an accuracy score',
};

test('Health shows legacy scope compliance as unmeasured, never a zero-failure claim', () => {
  const stats = retrievalQualityStats(legacy);
  assert.equal(countCell(stats.find(stat => stat.key === 'blockedScopeTurns')!.value), 'Not measured');
  assert.equal(stats.find(stat => stat.key === 'scopedTurns')!.value, null);
  assert.equal(stats.find(stat => stat.key === 'auditedTurns')!.value, 0);
  const measured = retrievalQualityStats({ ...legacy, auditedTurns: 2, scopeMeasuredTurns: 2, blockedScopeTurns: 1 });
  assert.equal(measured.find(stat => stat.key === 'blockedScopeTurns')!.value, 1);
  assert.ok(stats.find(stat => stat.key === 'noRetrievalTurns')!.label.includes('not necessarily wrong'));
});
