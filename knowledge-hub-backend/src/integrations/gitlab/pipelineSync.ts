import type { Pool } from 'pg';
import { GitLabClient } from './gitlabClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { env } from '../../config/env.js';
import type { ContentItem } from '../../types/contentItem.js';

interface GitLabPipeline {
  id: number;
  iid: number;
  status: string;
  ref: string;
  created_at: string;
  updated_at: string;
  web_url: string;
  project_id: number;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
}

export async function syncGitLabPipelines(
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
      for await (const pipelines of client.paginate<GitLabPipeline>(
        `/projects/${project.id}/pipelines`,
        { per_page: '20' },
      )) {
        for (const pipeline of pipelines) {
          const item = pipelineToContentItem(pipeline, project);
          await upsertContentItem(db, item);
          indexed++;
        }
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GitLab pipelines] Failed for project ${project.path_with_namespace}: ${message}`);
    }
  }

  await upsertSyncState(db, 'gitlab-pipeline', {
    lastSyncAt: new Date(),
    itemCount: indexed,
    lastError: errors > 0 ? `${errors} errors` : null,
  });

  return { indexed, errors };
}

function pipelineToContentItem(
  pipeline: GitLabPipeline,
  project: GitLabProject,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const statusEmoji: Record<string, string> = {
    success: '✅',
    failed: '❌',
    running: '🔄',
    pending: '⏳',
    canceled: '⛔',
    skipped: '⏭️',
  };
  const emoji = statusEmoji[pipeline.status] ?? '❓';

  return {
    source: 'gitlab-pipeline',
    sourceId: String(pipeline.id),
    title: `${emoji} Pipeline #${pipeline.iid} — ${project.path_with_namespace} (${pipeline.ref})`,
    summary: `${project.path_with_namespace} pipeline #${pipeline.iid} on ${pipeline.ref}: ${pipeline.status}`,
    body: '',
    publishedAt: new Date(pipeline.created_at).toISOString(),
    url: pipeline.web_url,
    projectContext: 'personal',
    metadata: {
      iid: pipeline.iid,
      status: pipeline.status,
      ref: pipeline.ref,
      projectPath: project.path_with_namespace,
      updatedAt: pipeline.updated_at,
    },
    tags: [pipeline.status],
  };
}
