/**
 * hooks/useProjects.ts
 * React Query hooks for the projects API.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { Project } from '../services/api';
import { requireApiData } from '../services/apiError';

export const PROJECTS_KEY = ['projects'] as const;

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: async () => requireApiData(await api.getProjects()),
    staleTime: 30_000,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) =>
      requireApiData(await api.createProject(input)),
    onSuccess: (created) => {
      qc.setQueryData<Project[]>(PROJECTS_KEY, (current) => current === undefined ? undefined : [...current, created]);
      void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: { id: string } & Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) =>
      requireApiData(await api.updateProject(id, input)),
    onSuccess: (updated) => {
      qc.setQueryData<Project[]>(PROJECTS_KEY, (current) => current?.map((project) => project.id === updated.id ? updated : project));
      void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { requireApiData(await api.deleteProject(id)); },
    onSuccess: (_, id) => {
      qc.setQueryData<Project[]>(PROJECTS_KEY, (current) => current?.filter((project) => project.id !== id));
      void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}
