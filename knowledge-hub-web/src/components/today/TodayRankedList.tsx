/**
 * components/today/TodayRankedList.tsx
 * Urgency-ranked list of tasks, to-review items, and spark clusters.
 * Fetches from three separate queries, scores, and renders rows.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { api } from '../../services/api';
import type { DiscoverItem, SparkCluster, DiscoverWorkflowState } from '../../services/api';
import type { Task } from '../../services/todayUrgencyService';
import { buildRankedList } from '../../services/todayUrgencyService';
import { TodayRankedRow } from './TodayRankedRow';

interface TodayRankedListProps {
  /** Called whenever the set of cluster IDs in the ranked list changes. */
  onRankedClusterIds?: (ids: string[]) => void;
}

/** Urgency-ranked list of up to 10 items (expandable to all). */
export const TodayRankedList: React.FC<TodayRankedListProps> = ({ onRankedClusterIds }) => {
  const [showAll, setShowAll] = useState(false);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const today = new Date().toISOString().slice(0, 10);

  const tasksQuery = useQuery({
    queryKey: ['today-tasks'],
    queryFn: () => api.getTasks(),
  });

  const discoverQuery = useQuery({
    queryKey: ['today-discover-ranked'],
    queryFn: () => api.getDiscoverFeed('to-review', undefined, 1, 30),
  });

  const clustersQuery = useQuery({
    queryKey: ['today-clusters-ranked'],
    queryFn: () => api.listSparkClusters({ dismissed: false }),
  });

  const tasks: Task[] =
    tasksQuery.data?.success === true
      ? ((tasksQuery.data.data as { items: Task[] }).items ?? [])
      : [];

  const discoverItems: DiscoverItem[] =
    discoverQuery.data?.success === true ? discoverQuery.data.data.items : [];

  const clusters: SparkCluster[] =
    clustersQuery.data?.success === true ? (clustersQuery.data.data as SparkCluster[]) : [];

  const allRanked = useMemo(
    () => buildRankedList(tasks, discoverItems, clusters, today, Infinity),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasksQuery.data, discoverQuery.data, clustersQuery.data, today],
  );

  const displayItems = showAll ? allRanked : allRanked.slice(0, 10);
  const hasMore = allRanked.length > 10;

  // Notify parent of which cluster IDs are in the ranked list
  useEffect(() => {
    const ids = allRanked
      .filter((i) => i.type === 'spark-cluster')
      .map((i) => i.id);
    onRankedClusterIds?.(ids);
  }, [allRanked, onRankedClusterIds]);

  const workflowMutation = useMutation({
    mutationFn: ({ id, state }: { id: string; state: DiscoverWorkflowState }) =>
      api.updateDiscoverWorkflow(id, state),
    onMutate: ({ id }) => { setUpdatingIds((p) => new Set([...p, id])); },
    onSettled: (_d, _e, { id }) => {
      setUpdatingIds((p) => { const n = new Set(p); n.delete(id); return n; });
      void queryClient.invalidateQueries({ queryKey: ['today-discover-ranked'] });
    },
  });

  const isLoading =
    tasksQuery.isLoading || discoverQuery.isLoading || clustersQuery.isLoading;

  if (isLoading) {
    return (
      <div className="today-section-card">
        <div className="today-section-card__header">
          <span className="today-section-card__title">Needs attention</span>
        </div>
        <InlineLoading description="Loading…" style={{ padding: '12px 16px' }} />
      </div>
    );
  }

  return (
    <div className="today-section-card">
      <div className="today-section-card__header">
        <span className="today-section-card__title">Needs attention</span>
        {allRanked.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--cds-text-secondary)' }}>
            {allRanked.length} item{allRanked.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {displayItems.length === 0 ? (
        <p style={{ padding: '12px 16px', fontSize: 13, color: 'var(--cds-text-secondary)', margin: 0 }}>
          Nothing urgent — you&apos;re all caught up.
        </p>
      ) : (
        <div className="today-ranked-list">
          {displayItems.map((item) => (
            <TodayRankedRow
              key={item.id}
              item={item}
              updatingDiscoverIds={updatingIds}
              onDiscoverStateChange={(id, state) => { workflowMutation.mutate({ id, state }); }}
            />
          ))}
        </div>
      )}

      {hasMore && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--cds-border-subtle-01)' }}>
          <button
            className="kh-btn-ghost"
            style={{ fontSize: 12 }}
            onClick={() => { setShowAll((v) => !v); }}
          >
            {showAll ? 'Show less' : `Show ${allRanked.length - 10} more`}
          </button>
        </div>
      )}
    </div>
  );
};
