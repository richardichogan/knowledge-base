/**
 * features/sparks/SparkPanel.tsx
 * Top-level sparks panel rendered in the Think page under the SPARKS toggle.
 * Sections: composer → clusters → all sparks list.
 */
import React, { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SparkComposer } from './SparkComposer';
import { SparkClusterCard } from './SparkClusterCard';
import { SparkList } from './SparkList';
import { api } from '../../services/api';
import type { SparkCluster, Spark } from '../../services/api';

/**
 * Picks the three most recent spark bodies for a given cluster id
 * from the full sparks array (already fetched by the panel).
 */
function recentBodiesForCluster(sparks: Spark[], clusterId: string): string[] {
  return sparks
    .filter((s) => s.clusterId === clusterId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 3)
    .map((s) => s.body);
}

/**
 * SparkPanel renders the full three-section sparks view.
 * On mount it marks all unsurfaced qualifying clusters as surfaced
 * so the Think nav dot clears.
 */
export const SparkPanel: React.FC = () => {
  const queryClient = useQueryClient();

  const { data: clusterData } = useQuery({
    queryKey: ['spark-clusters'],
    queryFn: () => api.listSparkClusters({ dismissed: false }),
    staleTime: 30_000,
  });

  const { data: sparkData } = useQuery({
    queryKey: ['sparks', 'all', 1],
    queryFn: () => api.listSparks({ limit: 100, offset: 0 }),
    staleTime: 30_000,
  });

  const surfaceMutation = useMutation({
    mutationFn: (id: string) => api.updateSparkCluster(id, { surfaced: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] });
    },
  });

  // On mount: surface all qualifying unsurfaced clusters to clear the nav dot
  useEffect(() => {
    if (!clusterData?.success) return;
    const toSurface = clusterData.data.filter(
      (c: SparkCluster) => c.sparkCount >= 4 && !c.surfaced && !c.dismissed,
    );
    toSurface.forEach((c: SparkCluster) => { surfaceMutation.mutate(c.id); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterData]);

  const clusters: SparkCluster[] = clusterData?.success ? clusterData.data : [];
  const sparks: Spark[] = sparkData?.success ? sparkData.data : [];
  const activeClusters = clusters.filter((c) => !c.dismissed);

  return (
    <div className="spark-panel">
      {/* Section 1: composer */}
      <section className="spark-panel__section">
        <h2 className="spark-panel__heading">New Spark</h2>
        <SparkComposer />
      </section>

      {/* Section 2: clusters */}
      {activeClusters.length > 0 && (
        <section className="spark-panel__section">
          <h2 className="spark-panel__heading">Clusters</h2>
          {activeClusters.map((cluster) => (
            <SparkClusterCard
              key={cluster.id}
              cluster={cluster}
              recentBodies={recentBodiesForCluster(sparks, cluster.id)}
            />
          ))}
        </section>
      )}

      {/* Section 3: all sparks */}
      <section className="spark-panel__section">
        <h2 className="spark-panel__heading">All Sparks</h2>
        <SparkList />
      </section>
    </div>
  );
};
