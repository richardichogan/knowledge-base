/** Compatibility facade for consumers of the original project hook. */
import {
  useProjects as useProjectQuery, useCreateProject, useUpdateProject, useDeleteProject,
} from '../hooks/useProjects';
import { describeApiError } from './apiError';
import type { Project, ProjectRelationsInput, ProjectWriteFields } from './api';

export type {
  ProjectColour, ProjectCategory, ProjectPriority, ProjectType,
  ProjectLifecycleState, ProjectImportance, ProjectLink,
} from './api';
export type ProjectRecord = Project;
export type CreateProjectInput = ProjectWriteFields & { id: string } & ProjectRelationsInput;
export type UpdateProjectInput = Partial<ProjectWriteFields> & ProjectRelationsInput;

export function useProjects() {
  const query = useProjectQuery();
  const create = useCreateProject();
  const update = useUpdateProject();
  const remove = useDeleteProject();
  return {
    projects: query.data ?? [],
    loading: query.isPending,
    error: query.error === null ? null : describeApiError(query.error),
    reload: async (): Promise<void> => { await query.refetch(); },
    createProject: (input: CreateProjectInput): Promise<Project> => create.mutateAsync(input),
    updateProject: (id: string, input: UpdateProjectInput): Promise<Project> => update.mutateAsync({ id, ...input }),
    deleteProject: (id: string): Promise<void> => remove.mutateAsync(id),
  };
}
