/**
 * useProjects — fetches projects from /api/projects (JSON file store).
 * Falls back to the static PROJECTS config if the API is unreachable.
 * Exposes create / update / delete with optimistic local state.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { PROJECTS } from '../config/projects';

export type ProjectColour =
  | 'blue' | 'cyan' | 'teal' | 'purple' | 'green'
  | 'magenta' | 'warm-gray' | 'gray' | 'red';

export type ProjectCategory = 'work' | 'personal' | 'side-hustle';
export type ProjectPriority = 'low' | 'medium' | 'high';

export interface ProjectLink {
  label: string;
  url: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  colour: ProjectColour;
  category: ProjectCategory;
  priority: ProjectPriority;
  description: string;
  gitlabPaths: string[];
  githubRepos: string[];
  links: ProjectLink[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type CreateProjectInput = Omit<ProjectRecord, 'createdAt' | 'updatedAt'>;
export type UpdateProjectInput = Partial<Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'>>;

/** Convert static config project to ProjectRecord shape (for fallback) */
function configToRecord(p: typeof PROJECTS[0]): ProjectRecord {
  return {
    id: p.id,
    name: p.name,
    colour: p.colour as ProjectColour,
    category: 'work',
    priority: 'medium' as ProjectPriority,
    description: p.description ?? '',
    gitlabPaths: p.gitlabPaths ?? [],
    githubRepos: p.githubRepos ?? [],
    links: (p.links ?? []) as ProjectLink[],
    tags: p.tags ?? [],
    createdAt: '',
    updatedAt: '',
  };
}

export function useProjects() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getProjects();
      if (res.success) {
        setProjects(res.data as ProjectRecord[]);
      } else {
        throw new Error('API error');
      }
    } catch {
      // Fallback to static config
      setProjects(PROJECTS.filter((p) => p.id !== 'personal').map(configToRecord));
      setError('Using local config — backend unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createProject = useCallback(async (input: CreateProjectInput): Promise<ProjectRecord> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await api.createProject(input as any);
    if (!res.success) throw new Error('Failed to create project');
    const created = (res as { success: true; data: ProjectRecord }).data;
    setProjects((prev) => [...prev, created]);
    return created;
  }, []);

  const updateProject = useCallback(async (id: string, input: UpdateProjectInput): Promise<ProjectRecord> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await api.updateProject(id, input as any);
    if (!res.success) throw new Error('Failed to update project');
    const updated = (res as { success: true; data: ProjectRecord }).data;
    setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
    return updated;
  }, []);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { projects, loading, error, reload: load, createProject, updateProject, deleteProject };
}
