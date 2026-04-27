/**
 * hooks/useRepoMappings.ts
 * React Query hooks for repo-to-tag mapping CRUD.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { RepoTagMapping } from '../services/api';

export const REPO_MAPPINGS_KEY = ['repo-mappings'] as const;

export function useRepoMappings() {
  return useQuery({
    queryKey: REPO_MAPPINGS_KEY,
    queryFn: async () => {
      const res = await api.getRepoMappings();
      return res.success ? res.data : [];
    },
    staleTime: 30_000,
  });
}

export function useCreateRepoMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { tagId: string; githubRepos: string[]; gitlabPaths: string[] }) =>
      api.createRepoMapping(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: REPO_MAPPINGS_KEY }),
  });
}

export function useUpdateRepoMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<Omit<RepoTagMapping, 'id' | 'tagName' | 'tagColour' | 'createdAt' | 'updatedAt'>>) =>
      api.updateRepoMapping(id, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: REPO_MAPPINGS_KEY }),
  });
}

export function useDeleteRepoMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRepoMapping(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: REPO_MAPPINGS_KEY }),
  });
}
