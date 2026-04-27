import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Tag, InlineLoading, InlineNotification } from '@carbon/react';
import { api } from '../services/api';
import type { ContentItemSummary } from '../types';

const SOURCE_TAG_TYPE: Record<string, 'blue'|'green'|'purple'|'teal'|'cyan'|'magenta'|'gray'> = {
  'cms-blog':'blue','cms-newsletter':'teal','cms-podcast-show-notes':'purple','github-commit':'magenta',
  'github-pr':'purple','github-issue':'green','gitlab-commit':'magenta','gitlab-mr':'purple',
  'gitlab-issue':'green','note':'cyan','image':'gray',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const SearchPage: React.FC = () => {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');

  const { data, isPending, isError } = useQuery({
    queryKey: ['search', submitted],
    queryFn: () => api.search({ q: submitted, pageSize: 30 }),
    enabled: submitted.length > 0,
    retry: 0,
  });

  const items: ContentItemSummary[] = data?.success === true ? data.data.items : [];

  return (
    <div className="page-root sr-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Search</h1>
          {submitted !== '' && items.length > 0 && (
            <p className="page-subtitle">{items.length} result{items.length !== 1 ? 's' : ''} for "{submitted}"</p>
          )}
        </div>
      </div>

      <div className="sr-input">
        <Search
          id="kb-search"
          labelText="Search"
          placeholder="Search your knowledge base…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') setSubmitted(query); }}
          onClear={() => { setQuery(''); setSubmitted(''); }}
          size="lg"
        />
      </div>

      {isPending && submitted.length > 0 && <InlineLoading description="Searching…" />}
      {isError && <InlineNotification kind="error" title="Search failed" subtitle="Is the backend running?" lowContrast />}

      {items.length > 0 && (
        <div className="sr-results">
          {items.map((item) => (
            <a
              key={item.id}
              className="sr-result"
              href={item.url ?? '#'}
              target="_blank"
              rel="noreferrer"
            >
              <div className="sr-result__meta">
                <Tag type={SOURCE_TAG_TYPE[item.source] ?? 'gray'} size="sm">{item.source}</Tag>
                <span className="sr-result__date">{formatDate(item.publishedAt)}</span>
              </div>
              <p className="sr-result__title">{item.title}</p>
              {item.summary != null && item.summary !== '' && item.summary !== item.title && (
                <p className="sr-result__summary">{item.summary}</p>
              )}
            </a>
          ))}
        </div>
      )}

      {!isPending && submitted !== '' && items.length === 0 && (
        <p className="sr-empty">No results for "{submitted}".</p>
      )}
    </div>
  );
};
