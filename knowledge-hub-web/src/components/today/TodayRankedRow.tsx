/**
 * components/today/TodayRankedRow.tsx
 * A single row in the Today urgency-ranked list.
 * Renders a type badge, title+context, and inline action buttons.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckmarkOutline, Compass, Idea } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { DiscoverItem, SparkCluster } from '../../services/api';
import type { UrgencyItem, Task } from '../../services/todayUrgencyService';
import { DiscoverActions } from '../discover/DiscoverActions';
import { createNote } from '../../notes/noteStorage';

// ── SparkCluster inline actions ───────────────────────────────────────────────

interface SparkRowActionsProps {
  cluster: SparkCluster;
}

const SparkRowActions: React.FC<SparkRowActionsProps> = ({ cluster }) => {
  const queryClient = useQueryClient();

  const dismissMutation = useMutation({
    mutationFn: () => api.updateSparkCluster(cluster.id, { dismissed: true }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] }); },
  });

  const draftMutation = useMutation({
    mutationFn: async () => {
      await createNote({
        title: cluster.theme,
        contentType: 'note',
        contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: `• ${cluster.theme}` }] }]),
      });
      await api.updateSparkCluster(cluster.id, { surfaced: true });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
      void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] });
    },
  });

  return (
    <>
      <button
        className="dc-action dc-action--save"
        onClick={() => { draftMutation.mutate(); }}
        disabled={draftMutation.isPending}
        title="Draft outline note"
      >
        Draft outline
      </button>
      <button
        className="dc-action dc-action--archive"
        onClick={() => { dismissMutation.mutate(); }}
        disabled={dismissMutation.isPending}
        title="Dismiss cluster"
      >
        Dismiss
      </button>
    </>
  );
};

// ── Task inline actions ───────────────────────────────────────────────────────

interface TaskRowActionsProps {
  task: Task;
}

const TaskRowActions: React.FC<TaskRowActionsProps> = ({ task }) => {
  const queryClient = useQueryClient();
  const [showSnooze, setShowSnooze] = useState(false);

  const doneMutation = useMutation({
    mutationFn: () => api.updateTask(task.id, { status: 'completed' }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['today-tasks'] }); },
  });

  const snoozeMutation = useMutation({
    mutationFn: (dueDate: string) => api.updateTask(task.id, { dueDate }),
    onSuccess: () => {
      setShowSnooze(false);
      void queryClient.invalidateQueries({ queryKey: ['today-tasks'] });
    },
  });

  return (
    <>
      <button
        className="dc-action dc-action--save"
        onClick={() => { doneMutation.mutate(); }}
        disabled={doneMutation.isPending}
      >
        Done
      </button>
      <button
        className="dc-action dc-action--archive"
        onClick={() => { setShowSnooze((v) => !v); }}
      >
        Snooze
      </button>
      {showSnooze && (
        <input
          type="date"
          className="today-ranked-row__snooze-input"
          min={new Date().toISOString().slice(0, 10)}
          onChange={(e) => { if (e.target.value) snoozeMutation.mutate(e.target.value); }}
        />
      )}
    </>
  );
};

// ── Main row component ────────────────────────────────────────────────────────

interface TodayRankedRowProps {
  item: UrgencyItem;
  updatingDiscoverIds: Set<string>;
  onDiscoverStateChange: (id: string, state: import('../../services/api').DiscoverWorkflowState) => void;
}

/** Renders a single urgency-ranked row with type badge, title, context, and inline actions. */
export const TodayRankedRow: React.FC<TodayRankedRowProps> = ({
  item,
  updatingDiscoverIds,
  onDiscoverStateChange,
}) => {
  const navigate = useNavigate();

  function handleTitleClick() {
    if (item.type === 'task') navigate('/plan');
    else if (item.type === 'to-review') navigate('/discover');
    else if (item.type === 'spark-cluster') navigate('/think');
  }

  const badgeClass = `today-ranked-row__badge today-ranked-row__badge--${item.type}`;

  return (
    <div className="today-ranked-row">
      <div className={badgeClass}>
        {item.type === 'task' && <CheckmarkOutline size={16} />}
        {item.type === 'to-review' && <Compass size={16} />}
        {item.type === 'spark-cluster' && <Idea size={16} />}
      </div>

      <div className="today-ranked-row__body">
        <div className="today-ranked-row__title" onClick={handleTitleClick}>
          {item.title}
        </div>
        <div className="today-ranked-row__context">{item.contextLine}</div>
      </div>

      <div className="today-ranked-row__actions">
        {item.type === 'task' && (
          <TaskRowActions task={item.payload as Task} />
        )}
        {item.type === 'to-review' && (
          <DiscoverActions
            itemId={item.id}
            onStateChange={onDiscoverStateChange}
            isUpdating={updatingDiscoverIds.has(item.id)}
          />
        )}
        {item.type === 'spark-cluster' && (
          <SparkRowActions cluster={item.payload as SparkCluster} />
        )}
      </div>
    </div>
  );
};
