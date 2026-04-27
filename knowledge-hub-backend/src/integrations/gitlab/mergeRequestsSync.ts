import type { Pool } from 'pg';
import { GitLabClient } from './gitlabClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitLabMR {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  web_url: string;
  author: { name: string };
  source_branch: string;
  target_branch: string;
  labels: string[];
  project_id: number;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
}

export async function syncGitLabMergeRequests(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  const client = new GitLabClient();
  let indexed = 0;
  let errors = 0;

  const projects: GitLabProject[] = [];
  for await (const page of client.paginate<GitLabProject>(
    `/users/${env.GITLAB_USER_ID}/projects`,
    { per_page: '100' },
  )) {
    projects.push(...page);
  }

  // Also fetch group projects if GITLAB_GROUP is configured
  if (env.GITLAB_GROUP) {
    for await (const page of client.paginate<GitLabProject>(
      `/groups/${env.GITLAB_GROUP}/projects`,
      { per_page: '100', include_subgroups: 'true' },
    )) {
      projects.push(...page);
    }
  }

  // Deduplicate by project id
  const seen = new Set<number>();
  const uniqueProjects = projects.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  for (const project of uniqueProjects) {
    try {
      for await (const mrs of client.paginate<GitLabMR>(
        `/projects/${project.id}/merge_requests`,
        { scope: 'all', per_page: '50' },
      )) {
        for (const mr of mrs) {
          const item = mrToContentItem(mr, project);
          await upsertContentItem(db, item);
          indexed++;
        }
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitLab MRs] Failed for project ${project.path_with_namespace}: ${message}`);
    }
  }

  await upsertSyncState(db, 'gitlab-mr', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
  });

  return { indexed, errors };
}

function mrToContentItem(
  mr: GitLabMR,
  project: GitLabProject,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  return {
    source: 'gitlab-mr',
    sourceId: String(mr.id),
    title: mr.title,
    summary: `MR !${mr.iid} in ${project.path_with_namespace} (${mr.state}): ${mr.title}`,
    body: mr.description ?? '',
    publishedAt: new Date(mr.created_at).toISOString(),
    url: mr.web_url,
    projectContext: 'personal',
    metadata: {
      iid: mr.iid,
      state: mr.state,
      projectPath: project.path_with_namespace,
      authorName: mr.author.name,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      updatedAt: mr.updated_at,
    },
    tags: mr.labels,
  };
}
