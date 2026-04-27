/**
 * hooks/useProjects.ts
 * React Query hooks for the projects API.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { Project } from '../services/api';

export const PROJECTS_KEY = ['projects'] as const;

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: async () => {
      const res = await api.getProjects();
      return res.success ? res.data : [];
    },
    staleTime: 30_000,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) =>
      api.createProject(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PROJECTS_KEY }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) =>
      api.updateProject(id, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PROJECTS_KEY }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PROJECTS_KEY }),
  });
}
