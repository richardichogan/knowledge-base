import type { Pool } from 'pg';
import { GitLabClient } from './gitlabClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  created_at: string;
  updated_at: string;
  web_url: string;
  author: { name: string };
  assignees: Array<{ name: string }>;
  labels: string[];
  project_id: number;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
}

export async function syncGitLabIssues(
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
      for await (const issues of client.paginate<GitLabIssue>(
        `/projects/${project.id}/issues`,
        { scope: 'all', per_page: '50' },
      )) {
        for (const issue of issues) {
          const item = issueToContentItem(issue, project);
          await upsertContentItem(db, item);
          indexed++;
        }
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitLab issues] Failed for project ${project.path_with_namespace}: ${message}`);
    }
  }

  await upsertSyncState(db, 'gitlab-issue', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
  });

  return { indexed, errors };
}

function issueToContentItem(
  issue: GitLabIssue,
  project: GitLabProject,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  return {
    source: 'gitlab-issue',
    sourceId: String(issue.id),
    title: issue.title,
    summary: `Issue #${issue.iid} in ${project.path_with_namespace} (${issue.state}): ${issue.title}`,
    body: issue.description ?? '',
    publishedAt: new Date(issue.created_at).toISOString(),
    url: issue.web_url,
    projectContext: 'personal',
    metadata: {
      iid: issue.iid,
      state: issue.state,
      projectPath: project.path_with_namespace,
      authorName: issue.author.name,
      assignees: issue.assignees.map((a) => a.name),
      updatedAt: issue.updated_at,
    },
    tags: issue.labels,
  };
}
