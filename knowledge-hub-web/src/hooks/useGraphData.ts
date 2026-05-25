/**
 * hooks/useGraphData.ts
 * React Query hook that fetches graph data from GET /api/graph.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import type { GraphResponse } from '../services/api';

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
} {
  const { days, seed, depth, edgeTypes, nodeTypes } = params;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['graph', days, seed, depth, edgeTypes?.join(','), nodeTypes?.join(',')],
    queryFn: () => {
      const p: Parameters<typeof api.getGraph>[0] = { days };
      if (seed) p.seed = seed;
      if (depth !== undefined) p.depth = depth;
      if (edgeTypes !== undefined) p.edgeTypes = edgeTypes;
      if (nodeTypes !== undefined) p.nodeTypes = nodeTypes;
      return api.getGraph(p);
    },
    staleTime: 60_000,
    select: (res) => (res.success ? res.data : null),
  });

  return { data: data ?? null, isLoading, isError };
}
