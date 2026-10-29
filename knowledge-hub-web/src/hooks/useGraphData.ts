/**
 * hooks/useGraphData.ts
 * React Query hook that fetches graph data from GET /api/graph.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { GraphResponse } from '../services/api';
import { requireApiData } from '../services/apiError';

export interface GraphQueryParams {
  days: number;
  seed?: string | null;
  depth?: number;
  edgeTypes?: string[];
  nodeTypes?: string[];
  includeInferred?: boolean;
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
  const { days, seed, depth, edgeTypes, nodeTypes, includeInferred = false } = params;
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { void qc.invalidateQueries({ queryKey: ['graph'] }); }, 300);
    };
    window.addEventListener('athena-graph-changed', changed);
    return () => { clearTimeout(timer); window.removeEventListener('athena-graph-changed', changed); };
  }, [qc]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['graph', days, seed, depth, edgeTypes?.join(','), nodeTypes?.join(','), includeInferred],
    queryFn: async () => {
      const p: Parameters<typeof api.getGraph>[0] = { days, includeInferred };
      if (seed) p.seed = seed;
      if (depth !== undefined) p.depth = depth;
      if (edgeTypes !== undefined) p.edgeTypes = edgeTypes;
      if (nodeTypes !== undefined) p.nodeTypes = nodeTypes;
      return requireApiData(await api.getGraph(p));
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  return { data: data ?? null, isLoading, isError, error, retry: refetch };
}
