import type { Project } from '../services/api';

type ProjectReference = Pick<Project, 'id' | 'name' | 'githubRepos' | 'gitlabPaths'>;

/**
 * Resolve an activity item's project using the canonical project records
 * returned by the API. Project identity, repository matching and colour
 * must not drift into a second client-side project list.
 */
export function inferProjectId(
  metadata: Record<string, unknown> | undefined,
  projectContext: string | undefined,
  projects: readonly ProjectReference[],
): string {
  if (metadata !== undefined) {
    const path = typeof metadata['projectPath'] === 'string' ? metadata['projectPath'] : null;
    const repo = typeof metadata['repo'] === 'string' ? metadata['repo']
      : typeof metadata['repoFullName'] === 'string' ? metadata['repoFullName'] : null;

    const match = projects.find((project) =>
      (path !== null && project.gitlabPaths.includes(path)) ||
      (repo !== null && project.githubRepos.includes(repo)),
    );
    if (match !== undefined) return match.id;
  }

  if (projectContext !== undefined && projects.some((project) => project.id === projectContext)) {
    return projectContext;
  }

  return 'personal';
}
