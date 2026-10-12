/**
 * hooks/useGraphData.ts
 * React Query hook that fetches graph data from GET /api/graph.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import type { GraphResponse } from '../services/api';
import { requireApiData } from '../services/apiError';

export interface GraphQueryParams {
  days: number;
  seed?: string | null;
  depth?: number;
  edgeTypes?: string[];
  nodeTypes?: string[];
}

/**
 * Fetches the graph dataset for the given filter params.
 * Re-fetches automatically when params change.
 */
export function useGraphData(params: GraphQueryParams): {
  data: GraphResponse | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  retry: () => Promise<unknown>;
} {
  const { days, seed, depth, edgeTypes, nodeTypes } = params;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['graph', days, seed, depth, edgeTypes?.join(','), nodeTypes?.join(',')],
    queryFn: async () => {
      const p: Parameters<typeof api.getGraph>[0] = { days };
      if (seed) p.seed = seed;
      if (depth !== undefined) p.depth = depth;
      if (edgeTypes !== undefined) p.edgeTypes = edgeTypes;
      if (nodeTypes !== undefined) p.nodeTypes = nodeTypes;
      return requireApiData(await api.getGraph(p));
    },
    staleTime: 60_000,
  });

  return { data: data ?? null, isLoading, isError, error, retry: refetch };
}
