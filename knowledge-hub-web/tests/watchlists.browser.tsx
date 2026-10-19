import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiscoverPage } from '../src/pages/DiscoverPage';
import { AthenaContextProvider } from '../src/context/AthenaContext';
import { AppDialogHost } from '../src/components/AppDialog';
import { api } from '../src/services/api';
import { DISCOVER_PREFERENCES_KEY } from '../src/utils/savedViews';
import { runWatchlistChecks, runWatchlistProjectChecks } from './watchlists.checks';
import type { ApiResponse } from '../src/types/apiResponse';
import '../src/styles/global.scss';

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const now = new Date().toISOString();
localStorage.removeItem(DISCOVER_PREFERENCES_KEY);
api.getTaxonomy = async () => ok([]);
api.getDiscoverSources = async () => ok([{ title: 'User selected feed', count: 1 }]);
api.getDiscoverFeed = async () => ok({ items: [{
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sourceId: 'fixture', title: 'Watchlist evidence article',
  url: 'https://example.com/evidence', description: 'A public announcement.', publishedAt: now, indexedAt: now,
  sourceTitle: 'User selected feed', workflowState: 'to-review', relevanceScore: 0.8, relevanceExplanation: 'A source matched to your interests.',
  pickReasons: ['Matched topic: agents ×1.5', 'Source weight ×1; published today.'], rankScore: 0.8,
  publishedUrl: null, taxonomyTagIds: [], articleType: null, platform: null, sourceType: null,
  spark: false, sparkReason: null, compositeScore: null,
  rankFactors: { editorial: 0.8, recency: 1, authority: 1, articleType: 1, project: 1, halfLifeDays: 7, computedAt: now },
  formatFit: { newsletter: 0, podcast: 0, fullBlog: 0, quickBlog: 0, social: 0 },
}], total: 1, page: 1, pageSize: 25 });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><MemoryRouter><AthenaContextProvider>
    <AppDialogHost /><div className="kh-content watchlists"><DiscoverPage /></div>
  </AthenaContextProvider></MemoryRouter></QueryClientProvider>,
);
Object.assign(window, { runWatchlistProjectChecks: () => runWatchlistProjectChecks(client), runWatchlistChecks: async () => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (document.querySelector('.dc-card') !== null) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return runWatchlistChecks(client);
} });
