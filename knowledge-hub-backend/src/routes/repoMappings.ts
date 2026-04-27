/**
 * routes/repoMappings.ts
 * CRUD for repo-to-taxonomy-tag mappings.
 *
 * Each mapping links one taxonomy tag to one or more GitHub repos / GitLab paths.
 * Used by the timeline to auto-tag content items based on their source repo.
 *
 * GET    /api/repo-mappings          — all mappings (with tag name/colour resolved)
 * POST   /api/repo-mappings          — create a mapping
 * PATCH  /api/repo-mappings/:id      — update repos/paths/tagId
 * DELETE /api/repo-mappings/:id      — delete a mapping
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const router = Router();

export interface RepoTagMapping {
  id: string;
  tagId: string;
  tagName: string;
  tagColour: string | null;
  githubRepos: string[];
  gitlabPaths: string[];
  createdAt: string;
  updatedAt: string;
}

function rowToMapping(row: Record<string, unknown>): RepoTagMapping {
  return {
    id:          row['id'] as string,
    tagId:       row['tag_id'] as string,
    tagName:     row['tag_name'] as string,
    tagColour:   row['tag_colour'] as string | null,
    githubRepos: row['github_repos'] as string[],
    gitlabPaths: row['gitlab_paths'] as string[],
    createdAt:   String(row['created_at']),
    updatedAt:   String(row['updated_at']),
  };
}

// ── GET /api/repo-mappings ────────────────────────────────────────────────────

router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const result = await db.query<Record<string, unknown>>(
        `SELECT m.id, m.tag_id, t.name AS tag_name, t.colour AS tag_colour,
                m.github_repos, m.gitlab_paths, m.created_at, m.updated_at
         FROM repo_tag_mappings m
         JOIN tags t ON t.id = m.tag_id
         ORDER BY t.name ASC, m.created_at ASC`,
      );
      const body: ApiSuccess<RepoTagMapping[]> = {
        success: true,
        data: result.rows.map(rowToMapping),
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/repo-mappings ───────────────────────────────────────────────────

router.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { tagId, githubRepos = [], gitlabPaths = [] } = req.body as {
        tagId?: string;
        githubRepos?: string[];
        gitlabPaths?: string[];
      };

      if (!tagId || typeof tagId !== 'string') {
        throw new ValidationError('tagId is required', {});
      }
      const tagCheck = await db.query('SELECT id FROM tags WHERE id = $1', [tagId]);
      if (tagCheck.rows.length === 0) throw new NotFoundError(`Tag ${tagId} not found`);

      const repos = Array.isArray(githubRepos) ? githubRepos.filter(Boolean) : [];
      const paths = Array.isArray(gitlabPaths) ? gitlabPaths.filter(Boolean) : [];

      const result = await db.query<Record<string, unknown>>(
        `INSERT INTO repo_tag_mappings (tag_id, github_repos, gitlab_paths)
         VALUES ($1, $2, $3)
         RETURNING id, tag_id, github_repos, gitlab_paths, created_at, updated_at`,
        [tagId, repos, paths],
      );

      const row = result.rows[0] as Record<string, unknown>;
      const tagRow = await db.query<{ name: string; colour: string | null }>(
        'SELECT name, colour FROM tags WHERE id = $1', [tagId],
      );
      const full = { ...row, tag_name: tagRow.rows[0]?.name ?? '', tag_colour: tagRow.rows[0]?.colour ?? null };
      const body: ApiSuccess<RepoTagMapping> = { success: true, data: rowToMapping(full) };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) { next(err); }
  })();
});

// ── PATCH /api/repo-mappings/:id ─────────────────────────────────────────────

router.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const { tagId, githubRepos, gitlabPaths } = req.body as {
        tagId?: string;
        githubRepos?: string[];
        gitlabPaths?: string[];
      };

      const existing = await db.query('SELECT id FROM repo_tag_mappings WHERE id = $1', [id]);
      if (existing.rows.length === 0) throw new NotFoundError(`Mapping ${id} not found`);

      const fields: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [id];
      const add = (col: string, val: unknown): void => {
        params.push(val);
        fields.push(`${col} = $${params.length}`);
      };

      if (tagId !== undefined) {
        const tagCheck = await db.query('SELECT id FROM tags WHERE id = $1', [tagId]);
        if (tagCheck.rows.length === 0) throw new NotFoundError(`Tag ${tagId} not found`);
        add('tag_id', tagId);
      }
      if (Array.isArray(githubRepos)) add('github_repos', githubRepos.filter(Boolean));
      if (Array.isArray(gitlabPaths)) add('gitlab_paths', gitlabPaths.filter(Boolean));

      await db.query(
        `UPDATE repo_tag_mappings SET ${fields.join(', ')} WHERE id = $1`,
        params,
      );

      const result = await db.query<Record<string, unknown>>(
        `SELECT m.id, m.tag_id, t.name AS tag_name, t.colour AS tag_colour,
                m.github_repos, m.gitlab_paths, m.created_at, m.updated_at
         FROM repo_tag_mappings m JOIN tags t ON t.id = m.tag_id
         WHERE m.id = $1`,
        [id],
      );
      const body: ApiSuccess<RepoTagMapping> = { success: true, data: rowToMapping(result.rows[0] as Record<string, unknown>) };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── DELETE /api/repo-mappings/:id ────────────────────────────────────────────

router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const result = await db.query('DELETE FROM repo_tag_mappings WHERE id = $1', [id]);
      if (result.rowCount === 0) throw new NotFoundError(`Mapping ${id} not found`);
      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export { router as repoMappingsRouter };
