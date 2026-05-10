/**
 * features/sparks/SparkClusterCard.tsx
 * Renders a single spark cluster with theme, spark count, recent sparks,
 * and Draft outline / Dismiss actions.
 */
import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SparkCluster } from '../../services/api';
import { api } from '../../services/api';
import { createNote } from '../../notes/noteStorage';

interface SparkClusterCardProps {
  cluster: SparkCluster;
  /** Three most-recent spark bodies for this cluster, pre-fetched by parent. */
  recentBodies: string[];
}

/**
 * Draft outline: creates a new Think note with the cluster theme as title
 * and recent spark bodies as a bulleted list, then marks the cluster surfaced.
 */
async function draftOutline(
  cluster: SparkCluster,
  recentBodies: string[],
): Promise<void> {
  const bullets = recentBodies.map((b) => `• ${b}`).join('\n');
  await createNote({
    title: cluster.theme,
    contentType: 'note',
    contentJson: JSON.stringify([
      { type: 'paragraph', content: [{ type: 'text', text: bullets }] },
    ]),
  });
}

/** SparkClusterCard renders one cluster row in the Sparks panel. */
export const SparkClusterCard: React.FC<SparkClusterCardProps> = ({ cluster, recentBodies }) => {
  const queryClient = useQueryClient();

  const dismissMutation = useMutation({
    mutationFn: () => api.updateSparkCluster(cluster.id, { dismissed: true }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] }); },
  });

  const draftMutation = useMutation({
    mutationFn: () => draftOutline(cluster, recentBodies),
    onSuccess: () => {
      void api.updateSparkCluster(cluster.id, { surfaced: true });
      void queryClient.invalidateQueries({ queryKey: ['notes-list'] });
    },
  });

  return (
    <div className="spark-cluster-card">
      <div className="spark-cluster-card__header">
        <span className="spark-cluster-card__theme">{cluster.theme}</span>
        <span className="spark-cluster-card__count">{cluster.sparkCount} sparks</span>
      </div>
      <ul className="spark-cluster-card__bodies">
        {recentBodies.map((b, i) => (
          <li key={i} className="spark-cluster-card__body">{b}</li>
        ))}
      </ul>
      <div className="spark-cluster-card__actions">
        <button
          className="spark-cluster-card__btn spark-cluster-card__btn--primary"
          onClick={() => { draftMutation.mutate(); }}
          disabled={draftMutation.isPending}
        >
          Draft outline
        </button>
        <button
          className="spark-cluster-card__btn"
          onClick={() => { dismissMutation.mutate(); }}
          disabled={dismissMutation.isPending}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
};
