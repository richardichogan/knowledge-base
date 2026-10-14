/**
 * features/sparks/sparkQueries.ts
 * Shared queries for the Sparks page (also used by NotesPage for Athena's page context).
 */
import { useQuery } from '@tanstack/react-query';
import { api, type Spark, type SparkCluster } from '../../services/api';

export function useSparkThemes(): { themes: SparkCluster[]; isLoading: boolean; error: unknown } {
  const query = useQuery({
    queryKey: ['spark-clusters', 'all-statuses'],
    queryFn: () => api.listSparkClusters({ status: 'active,developed,dismissed' }),
    staleTime: 30_000,
  });
  return { themes: query.data?.success ? query.data.data : [], isLoading: query.isLoading, error: query.error };
}

export function useLooseSparks(q = ''): { sparks: Spark[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['sparks', 'loose', q],
    queryFn: () => api.listSparks(q ? { clustered: false, q, limit: 100 } : { clustered: false, limit: 100 }),
    staleTime: 30_000,
  });
  return { sparks: query.data?.success ? query.data.data : [], isLoading: query.isLoading };
}
