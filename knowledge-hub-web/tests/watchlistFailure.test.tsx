import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiscoverWatchlists } from '../src/components/discover/DiscoverWatchlists';
import type { Watchlist, WatchRun, WatchCompanyKnowledge } from '../src/types/watchlists';

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

function render(runs: WatchRun[], knowledge: WatchCompanyKnowledge[] = []): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(['watchlists'], [watchlist]);
  client.setQueryData(['watchlist-runs', watchlist.id, 1], runs);
  client.setQueryData(['watchlist-companies', watchlist.id, watchlist.revision, runs.find(run => run.status !== 'running')?.id], knowledge);
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

test('company history retains older findings and sources without mixing other companies or duplicate anchors', () => {
  const finding = {
    id: 'example-finding', entity: 'Example', criterion: 'Availability', kind: 'announced-capability' as const,
    changed: 'Earlier Example announcement', matters: 'Useful historical context', uncertainty: 'Availability unverified',
    response: 'Monitor availability', evidenceIds: ['source'],
  };
  const historical: WatchRun = {
    ...failed, id: 'historical', startedAt: '2026-10-19T10:00:00Z', status: 'changes',
    findings: [finding, { ...finding, id: 'other-finding', entity: 'Other company', changed: 'Other company announcement' }],
    evidence: [{
      id: 'source', title: 'Original announcement', url: 'https://example.com/announcement',
      publishedAt: '2026-10-19T09:00:00Z', excerpt: 'Historical evidence', eventKey: 'event', syndicatedIds: [], entities: ['Example'],
    }],
  };
  const html = render([failed, { ...failed, id: 'recent', status: 'no_meaningful_change' }, historical]);
  const companyHistory = html.split('aria-label="Example history"')[1]?.split('aria-label="Monitoring setup and history"')[0] ?? '';
  assert.match(companyHistory, /Earlier Example announcement/);
  assert.match(companyHistory, /https:\/\/example.com\/announcement/);
  assert.match(companyHistory, /Comparison context version 1/);
  assert.match(companyHistory, /not proof of no change/);
  assert.doesNotMatch(companyHistory, /Other company announcement/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('a company with no new evidence still displays retained background and earlier dated findings', () => {
  const historical: WatchRun = {
    ...failed, id: 'retained', startedAt: '2026-10-19T10:00:00Z', status: 'changes',
    findings: [{
      id: 'retained-finding', entity: 'Example', criterion: 'Availability', kind: 'announced-capability',
      changed: 'Previously announced capability', matters: 'Relevant capability', uncertainty: 'Availability uncertain',
      response: 'Monitor availability', evidenceIds: ['announcement'],
    }],
    evidence: [{
      id: 'announcement', title: 'Dated announcement', url: 'https://example.com/announcement', publishedAt: '2026-10-19T09:00:00Z',
      excerpt: 'Original evidence', eventKey: 'event', syndicatedIds: [], entities: ['Example'],
    }],
  };
  const latest: WatchRun = { ...failed, id: 'incomplete', status: 'insufficient_coverage',
    coverage: { missingEntities: ['Example'] }, summary: 'Latest check incomplete.' };
  const html = render([latest], [{
    name: 'Example', findingCount: 3, latestFindingRun: historical,
    profile: {
      sources: [{ id: 'background', title: 'Company overview', url: 'https://example.com/about', excerpt: 'Established company information.',
        publishedAt: null, retrievedAt: now }],
      researchedAt: now, lastAttemptAt: now, error: 'Latest background refresh failed; previous sources retained.', searchContext: '',
    },
  }]);
  assert.match(html, /3 saved findings/);
  assert.match(html, /No new evidence this check/);
  assert.match(html, /Company overview/);
  assert.match(html, /Publication date not supplied/);
  assert.match(html, /Previously recorded developments/);
  assert.match(html, /Previously announced capability/);
  assert.match(html, /19 Oct 2026/);
  assert.match(html, /https:\/\/example.com\/announcement/);
  assert.match(html, /Latest background refresh failed; previous sources retained/);
  assert.doesNotMatch(html, />No evidence found</);
});
