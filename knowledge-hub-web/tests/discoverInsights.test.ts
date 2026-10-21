import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoverItem } from '../src/services/api';
import { buildBriefing, relevanceBand } from '../src/features/discover/discoverInsights';

test('source balancing changes position without mislabelling a strong story as low relevance', () => {
  const now = new Date().toISOString();
  const item: DiscoverItem = {
    id: 'strong', sourceId: 'strong', title: 'Strong story', url: null, description: null,
    sourceTitle: 'A source', workflowState: 'to-review', publishedAt: now, indexedAt: now,
    relevanceScore: 0.95, relevanceExplanation: 'Important news', rankScore: 0.3,
    rankFactors: { editorial: 0.95, recency: 1, authority: 1.1, articleType: 1.2,
      project: 1, halfLifeDays: 30, computedAt: now, diversity: 0.25 },
    publishedUrl: null, taxonomyTagIds: [], articleType: null, platform: null,
    formatFit: { newsletter: 0, podcast: 0, fullBlog: 0, quickBlog: 0, social: 0 },
    sourceType: null, spark: false, sparkReason: null, compositeScore: null,
  };
  assert.equal(relevanceBand(item), 'must-read');
  assert.equal(relevanceBand({ ...item, rankScore: null }), null);
  assert.equal(buildBriefing([item], new Date(0), () => undefined).standouts[0]?.id, 'strong');
});
