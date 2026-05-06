/**
 * components/sparks/ClusterCard.tsx
 * Displays a spark cluster with theme, spark count, recent bodies,
 * and Draft outline / Dismiss actions.
 */
import React from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { SparkCluster } from '../../services/api';

interface ClusterCardProps {
  cluster: SparkCluster;
}

const PREVIEW_SPARKS = 3;

export const ClusterCard: React.FC<ClusterCardProps> = ({ cluster }) => {
  const qc = useQueryClient();

  const { data: sparksData } = useQuery({
    queryKey: ['sparks', 'cluster', cluster.id],
    queryFn: () => api.listSparks({ cluster_id: cluster.id, limit: PREVIEW_SPARKS }),
    staleTime: 30_000,
  });
  const previewSparks = sparksData?.success === true ? sparksData.data : [];

  const dismissMutation = useMutation({
    mutationFn: () => api.updateSparkCluster(cluster.id, { dismissed: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['spark-clusters'] }),
  });

  const draftMutation = useMutation({
    mutationFn: async () => {
      // Fetch all sparks in this cluster then create a note
      const all = await api.listSparks({ cluster_id: cluster.id, limit: 50 });
      if (all.success !== true) throw new Error('Could not load sparks');
      const bullets = all.data.map((s) => `- ${s.body}`).join('\n');
      const content = `# ${cluster.theme}\n\n${bullets}`;
      return api.createNote({ content });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notes'] }),
  });

  return (
    <div className="cluster-card">
      <div className="cluster-card__header">
        <span className="cluster-card__theme">{cluster.theme}</span>
        <span className="cluster-card__count">{cluster.sparkCount} spark{cluster.sparkCount !== 1 ? 's' : ''}</span>
      </div>

      <ul className="cluster-card__preview">
        {previewSparks.map((s) => (
          <li key={s.id} className="cluster-card__preview-item">{s.body}</li>
        ))}
      </ul>

      <div className="cluster-card__actions">
        <button
          className="cluster-card__btn cluster-card__btn--draft"
          disabled={draftMutation.isPending}
          onClick={() => { draftMutation.mutate(); }}
        >
          {draftMutation.isPending ? 'Creating…' : 'Draft outline'}
        </button>
        <button
          className="cluster-card__btn cluster-card__btn--dismiss"
          disabled={dismissMutation.isPending}
          onClick={() => { dismissMutation.mutate(); }}
        >
          Dismiss
        </button>
      </div>

      {draftMutation.isSuccess && (
        <p className="cluster-card__feedback">Note created ✓</p>
      )}
    </div>
  );
};
