import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiscoverWatchlists } from '../src/components/discover/DiscoverWatchlists';
import type { Watchlist, WatchRun } from '../src/types/watchlists';

const now = '2026-10-21T21:20:00Z';
const watchlist: Watchlist = {
  id: 'fixture', config: {
    name: 'Platform moves', question: 'What changed?', description: '',
    entities: [{ name: 'Example', relationship: 'competitor' }], criteria: ['Availability'],
    sourceIds: [], projectIds: [], baseline: { text: '', links: [] }, cadence: 'daily', paused: false,
  },
  revision: 1, baselineVersion: 1, nextRunAt: now, createdAt: now, updatedAt: now,
  lastRun: { status: 'failed', startedAt: now, summary: 'Monitoring failed. No conclusions were saved.' },
};
const failed: WatchRun = {
  id: 'failed', watchlistId: watchlist.id, config: watchlist.config, baseline: watchlist.config.baseline,
  baselineVersion: 1, startedAt: now, completedAt: now, windowStart: now,
  status: 'failed', summary: 'Monitoring failed. No conclusions were saved.', coverage: {}, evidence: [], findings: [],
};

function render(runs: WatchRun[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(['watchlists'], [watchlist]);
  client.setQueryData(['watchlist-runs', watchlist.id, 1], runs);
  client.setQueryData(['watchlists', watchlist.id, 'baselines', 1], []);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><DiscoverWatchlists /></QueryClientProvider>);
  } finally { client.clear(); }
}

test('a failed first check with empty coverage does not crash Watchlists or report no change', () => {
  const html = render([failed]);
  assert.match(html, /Platform moves/);
  assert.match(html, /Monitoring failed/);
  assert.match(html, /Coverage was not recorded for this check/);
  assert.match(html, /There is no completed check to show yet/);
  assert.match(html, /Run now/);
  assert.doesNotMatch(html, /No meaningful change identified/);
});

test('a failed check preserves the previous completed briefing and its history', () => {
  const html = render([failed, {
    ...failed, id: 'completed', status: 'no_meaningful_change', summary: 'Earlier saved review remains available.',
    coverage: { matched: 1, uniqueEvents: 1, sourcesChecked: 1, sourcesHealthy: 1, missingEntities: [], truncated: false },
  }]);
  assert.match(html, /Earlier saved review remains available/);
  assert.match(html, /Showing the last completed check/);
  assert.match(html, /Coverage was not recorded for this check/);
});
