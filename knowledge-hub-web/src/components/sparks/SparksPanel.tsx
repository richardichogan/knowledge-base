/**
 * components/sparks/SparksPanel.tsx
 * Full-width panel shown inside the Think page when the Sparks tab is active.
 *
 * Sections:
 *   1. Inline composer — persistent quick-capture
 *   2. Clusters — surfaced, non-dismissed clusters
 *   3. All sparks — reverse-chrono with filter chips
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TagPicker } from '../TagPicker';
import { ClusterCard } from './ClusterCard';
import { api } from '../../services/api';
import type { Spark } from '../../services/api';

type FilterMode = 'all' | 'attached' | 'standalone';

const PAGE_SIZE = 20;
const CONFIRM_DELETE_KEY = 'spark-delete-confirm';

export const SparksPanel: React.FC = () => {
  const qc = useQueryClient();
  const [body, setBody]           = useState('');
  const [tagIds, setTagIds]       = useState<string[]>([]);
  const [filter, setFilter]       = useState<FilterMode>('all');
  const [page, setPage]           = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);

  const attachedParam = filter === 'all' ? undefined : filter === 'attached';

  const { data: sparksData, isFetching } = useQuery({
    queryKey: ['sparks', filter, page],
    queryFn: () => {
      const params: Parameters<typeof api.listSparks>[0] = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
      if (attachedParam !== undefined) params.attached = attachedParam;
      return api.listSparks(params);
    },
    staleTime: 15_000,
  });
  const sparks: Spark[] = sparksData?.success === true ? sparksData.data : [];

  const { data: clustersData } = useQuery({
    queryKey: ['spark-clusters', 'surfaced'],
    queryFn: () => api.listSparkClusters({ surfaced: true, dismissed: false }),
    staleTime: 30_000,
  });
  const clusters = clustersData?.success === true ? clustersData.data : [];

  const createMutation = useMutation({
    mutationFn: () => api.createSpark({ body: body.trim(), tags: [] }),
    onSuccess: (res) => {
      if (res.success !== true) { setComposeError('Failed to save'); return; }
      setBody('');
      setTagIds([]);
      setComposeError(null);
      void qc.invalidateQueries({ queryKey: ['sparks'] });
      void qc.invalidateQueries({ queryKey: ['spark-clusters'] });
    },
    onError: (err: unknown) => { setComposeError(err instanceof Error ? err.message : 'Network error'); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSpark(id),
    onSuccess: () => {
      setConfirmId(null);
      void qc.invalidateQueries({ queryKey: ['sparks'] });
    },
  });

  const filterLabels: Record<FilterMode, string> = { all: 'All', attached: 'Attached', standalone: 'Standalone' };

  return (
    <div className="sparks-panel">
      {/* ── Inline composer ── */}
      <div className="sparks-panel__composer">
        <textarea
          className="sparks-panel__composer-input"
          placeholder="Capture a spark…"
          value={body}
          rows={3}
          onChange={(e) => { setBody(e.target.value); }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              if (body.trim() !== '') createMutation.mutate();
            }
          }}
        />
        <div className="sparks-panel__composer-row">
          <TagPicker
            selectedIds={tagIds}
            onChange={setTagIds}
            trigger={<button className="sparks-panel__tag-btn">{tagIds.length === 0 ? '+ Tags' : `${tagIds.length} tags`}</button>}
          />
          <button
            className="sparks-panel__save-btn"
            disabled={body.trim() === '' || createMutation.isPending}
            onClick={() => { createMutation.mutate(); }}
          >
            {createMutation.isPending ? 'Saving…' : 'Save spark'}
          </button>
        </div>
        {composeError !== null && <p className="sparks-panel__error">{composeError}</p>}
      </div>

      {/* ── Clusters ── */}
      {clusters.length > 0 && (
        <section className="sparks-panel__section">
          <h3 className="sparks-panel__section-title">CLUSTERS</h3>
          <div className="sparks-panel__clusters">
            {clusters.map((c) => <ClusterCard key={c.id} cluster={c} />)}
          </div>
        </section>
      )}

      {/* ── All sparks ── */}
      <section className="sparks-panel__section">
        <div className="sparks-panel__filter-row">
          {(Object.keys(filterLabels) as FilterMode[]).map((mode) => (
            <button
              key={mode}
              className={`sparks-panel__chip${filter === mode ? ' sparks-panel__chip--active' : ''}`}
              onClick={() => { setFilter(mode); setPage(0); }}
            >
              {filterLabels[mode]}
            </button>
          ))}
        </div>

        {isFetching && <p className="sparks-panel__loading">Loading…</p>}

        {!isFetching && sparks.length === 0 && (
          <p className="sparks-panel__empty">No sparks yet.</p>
        )}

        <ul className="sparks-panel__list">
          {sparks.map((spark) => (
            <li key={spark.id} className="sparks-panel__item">
              <p className="sparks-panel__item-body">{spark.body}</p>
              <div className="sparks-panel__item-meta">
                {spark.sourceId !== null && (
                  <span className="sparks-panel__item-source">
                    {spark.sourceType} · {spark.sourceId.slice(0, 8)}
                  </span>
                )}
                <span className="sparks-panel__item-date">
                  {new Date(spark.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
                {spark.tags.length > 0 && (
                  <span className="sparks-panel__item-tags">{spark.tags.join(', ')}</span>
                )}
              </div>
              {confirmId === spark.id ? (
                <div className="sparks-panel__item-confirm">
                  <span>Delete this spark?</span>
                  <button className="sparks-panel__del-confirm" onClick={() => { deleteMutation.mutate(spark.id); }}>Yes, delete</button>
                  <button className="sparks-panel__del-cancel" onClick={() => { setConfirmId(null); }}>Cancel</button>
                </div>
              ) : (
                <button
                  className="sparks-panel__del-btn"
                  data-key={CONFIRM_DELETE_KEY}
                  onClick={() => { setConfirmId(spark.id); }}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>

        {sparks.length === PAGE_SIZE && (
          <button className="sparks-panel__load-more" onClick={() => { setPage((p) => p + 1); }}>
            Load more
          </button>
        )}
      </section>
    </div>
  );
};
