import React, { useState } from 'react';
import { InlineLoading } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { DiscoverItem, DiscoverWorkflowState } from '../../services/api';
import type { Task, UrgencyItem } from '../../services/todayUrgencyService';
import { buildRankedList } from '../../services/todayUrgencyService';
import { TodayRankedRow } from './TodayRankedRow';

const DEFAULT_VISIBLE_ITEMS = 4;

/** Overdue severity tiers used for border and context color only. */
type OverdueSeverity = 'neutral' | 'warning' | 'critical';

/** Maps overdue day count to severity tier. */
function getOverdueSeverity(daysOverdue: number): OverdueSeverity {
  if (daysOverdue >= 31) return 'critical';
  if (daysOverdue >= 7) return 'warning';
  return 'neutral';
}

/** Needs-attention card split into Overdue and Awaiting a decision sections. */
export const TodayRankedList: React.FC = () => {
  const [showAllOverdue, setShowAllOverdue] = useState(false);
  const [showAllReview, setShowAllReview] = useState(false);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const tasksQuery = useQuery({ queryKey: ['today-tasks'], queryFn: () => api.getTasks() });
  const discoverQuery = useQuery({
    queryKey: ['today-discover-ranked'],
    queryFn: () => api.getDiscoverFeed('to-review', undefined, 1, 30),
  });

  const tasks: Task[] = tasksQuery.data?.success === true
    ? ((tasksQuery.data.data as { items: Task[] }).items ?? [])
    : [];
  const discoverItems: DiscoverItem[] =
    discoverQuery.data?.success === true ? discoverQuery.data.data.items : [];
  const ranked = buildRankedList(tasks, discoverItems, [], today, Infinity);

  const overdue = ranked
    .filter((item) => item.type === 'task')
    .sort((a, b) => b.rawDays - a.rawDays);
  const awaitingDecision = ranked
    .filter((item) => item.type === 'to-review')
    .sort((a, b) => {
      const aTime = new Date((a.payload as DiscoverItem).publishedAt).getTime();
      const bTime = new Date((b.payload as DiscoverItem).publishedAt).getTime();
      return bTime - aTime;
    });

  const overdueVisible = showAllOverdue ? overdue : overdue.slice(0, DEFAULT_VISIBLE_ITEMS);
  const reviewVisible = showAllReview ? awaitingDecision : awaitingDecision.slice(0, DEFAULT_VISIBLE_ITEMS);

  const workflowMutation = useMutation({
    mutationFn: ({ id, state }: { id: string; state: DiscoverWorkflowState }) =>
      api.updateDiscoverWorkflow(id, state),
    onMutate: ({ id }) => { setUpdatingIds((prev) => new Set([...prev, id])); },
    onSettled: (_d, _e, { id }) => {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['today-discover-ranked'] });
    },
  });

  if (tasksQuery.isLoading || discoverQuery.isLoading) {
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
      </div>

      <div className="today-ranked-section">
        <div className="today-ranked-section__header">Overdue ({overdue.length})</div>
        {overdueVisible.length === 0 && <p className="today-ranked-empty">No overdue tasks.</p>}
        {overdueVisible.map((item: UrgencyItem) => (
          <TodayRankedRow
            key={item.id}
            item={item}
            updatingDiscoverIds={updatingIds}
            onDiscoverStateChange={(id, state) => { workflowMutation.mutate({ id, state }); }}
            overdueSeverity={getOverdueSeverity(item.rawDays)}
          />
        ))}
        {overdue.length > DEFAULT_VISIBLE_ITEMS && (
          <button className="kh-btn-ghost today-ranked-show-more" onClick={() => { setShowAllOverdue((v) => !v); }}>
            {showAllOverdue ? 'Show less' : `Show ${overdue.length - DEFAULT_VISIBLE_ITEMS} more`}
          </button>
        )}
      </div>

      <div className="today-ranked-section">
        <div className="today-ranked-section__header">Awaiting a decision ({awaitingDecision.length})</div>
        {reviewVisible.length === 0 && <p className="today-ranked-empty">No items awaiting a decision.</p>}
        {reviewVisible.map((item: UrgencyItem) => (
          <TodayRankedRow
            key={item.id}
            item={item}
            updatingDiscoverIds={updatingIds}
            onDiscoverStateChange={(id, state) => { workflowMutation.mutate({ id, state }); }}
          />
        ))}
        {awaitingDecision.length > DEFAULT_VISIBLE_ITEMS && (
          <button className="kh-btn-ghost today-ranked-show-more" onClick={() => { setShowAllReview((v) => !v); }}>
            {showAllReview ? 'Show less' : `Show ${awaitingDecision.length - DEFAULT_VISIBLE_ITEMS} more`}
          </button>
        )}
      </div>
    </div>
  );
};
