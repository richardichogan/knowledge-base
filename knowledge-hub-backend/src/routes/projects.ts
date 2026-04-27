/**
 * Projects route — PostgreSQL-backed CRUD.
 *
 * Table: projects (Change 006 in schema.sql)
 * Edits are purely local — they never touch GitLab or GitHub data.
 * gitlab_paths / github_repos are used by the timeline to match items to projects.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/db.js';
import { upsertTags } from '../db/tagHelpers.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProjectColour =
  | 'blue' | 'cyan' | 'teal' | 'purple' | 'green'
  | 'magenta' | 'warm-gray' | 'gray' | 'red';

export type ProjectCategory = 'work' | 'personal' | 'side-hustle';
export type ProjectPriority = 'low' | 'medium' | 'high';

export interface ProjectLink {
  label: string;
  url: string;
}

export interface Project {
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

// ── Row mapper ────────────────────────────────────────────────────────────────

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id:           row['id'] as string,
    name:         row['name'] as string,
    colour:       row['colour'] as ProjectColour,
    category:     row['category'] as ProjectCategory,
    priority:     row['priority'] as ProjectPriority,
    description:  row['description'] as string,
    gitlabPaths:  row['gitlab_paths'] as string[],
    githubRepos:  row['github_repos'] as string[],
    links:        row['links'] as ProjectLink[],
    tags:         row['tags'] as string[],
    createdAt:    String(row['created_at']),
    updatedAt:    String(row['updated_at']),
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

const COLOURS: ProjectColour[] = ['blue','cyan','teal','purple','green','magenta','warm-gray','gray','red'];
const CATEGORIES: ProjectCategory[] = ['work', 'personal', 'side-hustle'];
const PRIORITIES: ProjectPriority[] = ['low', 'medium', 'high'];

function validateInput(input: Record<string, unknown>, requireName: boolean): void {
  if (requireName && !String(input['name'] ?? '').trim()) {
    throw new ValidationError('name is required', { name: 'required' });
  }
  if (input['colour'] !== undefined && !COLOURS.includes(input['colour'] as ProjectColour)) {
    throw new ValidationError(`colour must be one of: ${COLOURS.join(', ')}`, { colour: 'invalid' });
  }
  if (input['category'] !== undefined && !CATEGORIES.includes(input['category'] as ProjectCategory)) {
    throw new ValidationError(`category must be one of: ${CATEGORIES.join(', ')}`, { category: 'invalid' });
  }
  if (input['priority'] !== undefined && !PRIORITIES.includes(input['priority'] as ProjectPriority)) {
    throw new ValidationError(`priority must be one of: ${PRIORITIES.join(', ')}`, { priority: 'invalid' });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// GET /api/projects — list all, optional ?category=&priority= filters
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { category, priority } = req.query as Record<string, string | undefined>;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
      if (priority) { params.push(priority); conditions.push(`priority = $${params.length}`); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await db.query<Record<string, unknown>>(
        `SELECT * FROM projects ${where} ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
           name ASC`,
        params,
      );
      const body: ApiSuccess<Project[]> = { success: true, data: result.rows.map(rowToProject) };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// POST /api/projects — create
router.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const input = req.body as Record<string, unknown>;
      validateInput(input, true);
      const id = String(input['id'] ?? '').trim() || randomUUID();
      const tags = Array.isArray(input['tags']) ? (input['tags'] as string[]).filter(Boolean) : [];
      const result = await db.query<Record<string, unknown>>(
        `INSERT INTO projects (id, name, colour, category, priority, description, gitlab_paths, github_repos, links, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          id,
          String(input['name']).trim(),
          (input['colour'] as string | undefined) ?? 'gray',
          (input['category'] as string | undefined) ?? 'work',
          (input['priority'] as string | undefined) ?? 'medium',
          String(input['description'] ?? '').trim(),
          Array.isArray(input['gitlabPaths']) ? (input['gitlabPaths'] as string[]).filter(Boolean) : [],
          Array.isArray(input['githubRepos']) ? (input['githubRepos'] as string[]).filter(Boolean) : [],
          JSON.stringify(Array.isArray(input['links']) ? input['links'] : []),
          tags,
        ],
      );
      const body: ApiSuccess<Project> = { success: true, data: rowToProject(result.rows[0] as Record<string, unknown>) };
      res.status(HTTP_STATUS.CREATED).json(body);
      // Auto-upsert tags into global registry (fire-and-forget)
      upsertTags(db, tags).catch((e: unknown) => {
        console.error('[projects] Failed to upsert tags:', e);
      });
    } catch (err) { next(err); }
  })();
});

// PATCH /api/projects/:id — update
router.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const input = req.body as Record<string, unknown>;
      validateInput(input, false);

      const fields: string[] = [];
      const params: unknown[] = [];
      const add = (col: string, val: unknown): void => { params.push(val); fields.push(`${col} = $${params.length}`); };

      if (input['name'] !== undefined)        add('name',         String(input['name']).trim());
      if (input['colour'] !== undefined)      add('colour',       input['colour']);
      if (input['category'] !== undefined)    add('category',     input['category']);
      if (input['priority'] !== undefined)    add('priority',     input['priority']);
      if (input['description'] !== undefined) add('description',  String(input['description']).trim());
      if (Array.isArray(input['gitlabPaths'])) add('gitlab_paths', (input['gitlabPaths'] as string[]).filter(Boolean));
      if (Array.isArray(input['githubRepos'])) add('github_repos', (input['githubRepos'] as string[]).filter(Boolean));
      if (Array.isArray(input['links']))       add('links',        JSON.stringify(input['links']));
      if (Array.isArray(input['tags']))        add('tags',         (input['tags'] as string[]).filter(Boolean));

      if (fields.length === 0) throw new ValidationError('no fields to update', {});
      fields.push('updated_at = NOW()');
      params.push(id);

      const result = await db.query<Record<string, unknown>>(
        `UPDATE projects SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (result.rows.length === 0) throw new NotFoundError(`Project '${id}' not found`);
      const updated = rowToProject(result.rows[0] as Record<string, unknown>);
      const body: ApiSuccess<Project> = { success: true, data: updated };
      res.status(HTTP_STATUS.OK).json(body);
      // Auto-upsert tags into global registry (fire-and-forget)
      upsertTags(db, updated.tags).catch((e: unknown) => {
        console.error('[projects] Failed to upsert tags:', e);
      });
    } catch (err) { next(err); }
  })();
});

// DELETE /api/projects/:id
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const result = await db.query('DELETE FROM projects WHERE id = $1', [id]);
      if (result.rowCount === 0) throw new NotFoundError(`Project '${id}' not found`);
      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export { router as projectsRouter };
export type { Project as ProjectRecord };

