import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DiscoverItem } from '../../services/api';
import type { ApiResponse } from '../../types/apiResponse';
import { requireApiData } from '../../services/apiError';

const SUMMARY_RECHECK_MS = 86_400_000;

export function usePublisherSummary(item: DiscoverItem): {
  text: string | null; origin: 'feed' | 'seo'; loading: boolean; failed: boolean;
} {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['discover-publisher-summary', item.id],
    queryFn: async () => requireApiData(await api.getDiscoverPublisherSummary(item.id)),
    enabled: !item.contentBasis && !item.description?.trim() && Boolean(item.url),
    staleTime: SUMMARY_RECHECK_MS,
    retry: false,
  });
  const text = item.contentBasis ? null : item.description?.trim() || query.data?.text || null;
  const origin = item.description?.trim() ? item.publisherSummaryOrigin ?? 'feed' : query.data?.origin ?? 'feed';
  const id = item.id;
  useEffect(() => {
    if (!text) return;
    qc.setQueriesData<ApiResponse<{ items: DiscoverItem[]; total: number }>>({ queryKey: ['discover'] }, previous => {
      if (!previous?.success || !Array.isArray(previous.data.items)) return previous;
      if (!previous.data.items.some(article => article.id === id && article.description !== text)) return previous;
      return { ...previous, data: { ...previous.data, items: previous.data.items.map(article =>
        article.id === id ? { ...article, description: text, publisherSummaryOrigin: origin } : article) } };
    });
  }, [qc, id, text, origin]);
  return { text, origin, loading: query.isFetching, failed: query.isError };
}

export function PublisherSummary({ summary }: { summary: ReturnType<typeof usePublisherSummary> }): React.ReactElement {
  return <div className="dc-publisher-summary" data-ctx-body={summary.text ? `Publisher summary (${summary.origin}): ${summary.text}` : undefined}>
    {summary.text ? <>
      <span className="dc-publisher-summary__label">{summary.origin === 'seo' ? 'Publisher SEO summary' : 'Publisher summary'}</span>
      <p>{summary.text}</p>
    </> : summary.loading ? <p role="status">Loading publisher summary…</p>
      : summary.failed ? <><p role="alert">Publisher summary could not be loaded.</p>
        <span className="dc-publisher-summary__empty">The publisher page will be checked again later.</span></>
        : <p className="dc-publisher-summary__empty">No publisher summary available.</p>}
  </div>;
}
