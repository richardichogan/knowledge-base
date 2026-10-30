import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enforceScoreCaps, type ScoringResult } from '../src/integrations/cms/articleScoringPrompt.js';

function announcement(overrides: Partial<ScoringResult> = {}): ScoringResult {
  return {
    audienceFit: 1, novelty: 1, strategicSignificance: 0, analyticalDepth: 0,
    composite: 2, sourceType: 'Formal', platform: 'Archive', spark: false,
    sparkReason: '', explanation: 'A useful short model-release update.',
    articleType: 'Product Announcement', alreadyCovered: 0,
    formatFit: { newsletter: 0, podcast: 0, fullBlog: 0, quickBlog: 0, social: 3 },
    ...overrides,
  };
}

test('strong short-social suitability does not require long-form depth or a high composite', () => {
  const result = enforceScoreCaps(announcement(), null);
  assert.equal(result.platform, 'LinkedIn Standalone');
  assert.equal(result.composite, 2);
  assert.equal(result.analyticalDepth, 0);
  assert.equal(result.strategicSignificance, 0);
  assert.deepEqual(result.formatFit, announcement().formatFit);
});

test('short-social routing preserves relevance, freshness, source and coverage exclusions', () => {
  for (const overrides of [
    { audienceFit: 0 }, { novelty: 0 }, { alreadyCovered: 2 },
    { sourceType: 'Case Study or Advertorial' as const },
    { formatFit: { newsletter: 0, podcast: 0, fullBlog: 0, quickBlog: 0, social: 1 } },
    { formatFit: undefined },
  ]) {
    assert.equal(enforceScoreCaps(announcement(overrides), null).platform, 'Archive');
  }
  assert.equal(enforceScoreCaps(announcement(), 'Case Study or Advertorial').platform, 'Archive');
  assert.equal(enforceScoreCaps(announcement(), 'Community').platform, 'LinkedIn Standalone');
});
