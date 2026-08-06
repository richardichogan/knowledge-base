import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { getDb } from '../db/db.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { ValidationError } from '../types/errors.js';

interface ConnectedRepoRow {
  repo_full_name: string;
  provider: 'github' | 'gitlab';
}

interface FilingTagRow {
  id: string;
  name: string;
  parent_name: string | null;
}

interface MappingRow {
  repo_full_name: string;
  project_tag_id: string;
  project_tag_name: string;
  updated_at: string;
}

/** Bootstrap payload for the repo mapping settings page. */
export interface RepoProjectMappingConfig {
  repos: Array<{ repoFullName: string; provider: 'github' | 'gitlab' }>;
  filingTags: Array<{ id: string; name: string; parentName: string | null }>;
  mappings: Array<{ repoFullName: string; projectTagId: string; projectTagName: string; updatedAt: string }>;
}

export const repoProjectMappingsRouter = Router();

/**
 * GET /api/repo-project-mappings/config
 * Returns connected repos, filing-role tags, and existing repo→project mappings.
 */
repoProjectMappingsRouter.get('/config', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const [repoResult, tagResult, mappingResult] = await Promise.all([
        db.query<ConnectedRepoRow>(
          `SELECT DISTINCT repo_full_name, provider
           FROM (
             SELECT UNNEST(github_repos) AS repo_full_name, 'github'::TEXT AS provider
             FROM projects
             WHERE COALESCE(array_length(github_repos, 1), 0) > 0
             UNION ALL
             SELECT UNNEST(gitlab_paths) AS repo_full_name, 'gitlab'::TEXT AS provider
             FROM projects
             WHERE COALESCE(array_length(gitlab_paths, 1), 0) > 0
             UNION ALL
             SELECT UNNEST(github_repos) AS repo_full_name, 'github'::TEXT AS provider
             FROM repo_tag_mappings
             WHERE COALESCE(array_length(github_repos, 1), 0) > 0
             UNION ALL
             SELECT UNNEST(gitlab_paths) AS repo_full_name, 'gitlab'::TEXT AS provider
             FROM repo_tag_mappings
             WHERE COALESCE(array_length(gitlab_paths, 1), 0) > 0
           ) repos
           WHERE repo_full_name IS NOT NULL AND repo_full_name <> ''
           ORDER BY provider ASC, repo_full_name ASC`,
        ),
        db.query<FilingTagRow>(
          `SELECT t.id, t.name, p.name AS parent_name
           FROM tags t
           LEFT JOIN tags p ON p.id = t.parent_id
           WHERE t.role = 'filing'
           ORDER BY COALESCE(p.name, t.name), t.parent_id NULLS FIRST, t.name`,
        ),
        db.query<MappingRow>(
          `SELECT rpm.repo_full_name, rpm.project_tag_id, t.name AS project_tag_name, rpm.updated_at
           FROM repo_project_mappings rpm
           JOIN tags t ON t.id = rpm.project_tag_id
           ORDER BY rpm.repo_full_name ASC`,
        ),
      ]);

      const seen = new Set<string>();
      const repos = repoResult.rows
        .map((r) => ({ repoFullName: r.repo_full_name, provider: r.provider }))
        .filter((r) => {
          const key = `${r.provider}:${r.repoFullName.toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      if (env.GITHUB_CONTENT_STORE_REPO) {
        const repoLower = env.GITHUB_CONTENT_STORE_REPO.toLowerCase();
        const exists = repos.some((r) => r.provider === 'github' && r.repoFullName.toLowerCase() === repoLower);
        if (!exists) repos.unshift({ repoFullName: env.GITHUB_CONTENT_STORE_REPO, provider: 'github' });
      }

      const out: ApiSuccess<RepoProjectMappingConfig> = {
        success: true,
        data: {
          repos,
          filingTags: tagResult.rows.map((t) => ({ id: t.id, name: t.name, parentName: t.parent_name })),
          mappings: mappingResult.rows.map((m) => ({
            repoFullName: m.repo_full_name,
            projectTagId: m.project_tag_id,
            projectTagName: m.project_tag_name,
            updatedAt: m.updated_at,
          })),
        },
      };
      res.json(out);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * PUT /api/repo-project-mappings
 * Upserts one mapping row by repo full name. projectTagId=null removes mapping.
 */
repoProjectMappingsRouter.put('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { repoFullName, projectTagId } = req.body as {
        repoFullName?: string;
        projectTagId?: string | null;
      };
      const trimmedRepo = String(repoFullName ?? '').trim();
      if (trimmedRepo === '') throw new ValidationError('repoFullName is required', { repoFullName: 'required' });

      if (projectTagId === null) {
        await db.query('DELETE FROM repo_project_mappings WHERE LOWER(repo_full_name) = LOWER($1)', [trimmedRepo]);
        const out: ApiSuccess<{ repoFullName: string; projectTagId: null }> = {
          success: true,
          data: { repoFullName: trimmedRepo, projectTagId: null },
        };
        res.json(out);
        return;
      }

      if (typeof projectTagId !== 'string' || projectTagId.trim() === '') {
        throw new ValidationError('projectTagId is required (or null to unmap)', { projectTagId: 'required' });
      }

      const tagCheck = await db.query<{ id: string }>(
        `SELECT id FROM tags WHERE id = $1 AND role = 'filing'`,
        [projectTagId],
      );
      if (tagCheck.rows.length === 0) {
        throw new ValidationError('projectTagId must reference an existing filing-role tag', { projectTagId: 'invalid' });
      }

      await db.query(
        `INSERT INTO repo_project_mappings (repo_full_name, project_tag_id)
         VALUES ($1, $2)
         ON CONFLICT (repo_full_name)
         DO UPDATE SET project_tag_id = EXCLUDED.project_tag_id, updated_at = NOW()`,
        [trimmedRepo, projectTagId],
      );

      const out: ApiSuccess<{ repoFullName: string; projectTagId: string }> = {
        success: true,
        data: { repoFullName: trimmedRepo, projectTagId },
      };
      res.json(out);
    } catch (err) {
      next(err);
    }
  })();
});
