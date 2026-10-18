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
import { IDENTITY_COLOURS, IDENTITY_PALETTE, type IdentityColour } from '../services/identityPalette.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProjectColour = IdentityColour;

export type ProjectCategory = 'work' | 'personal' | 'side-hustle';
export type ProjectPriority = 'low' | 'medium' | 'high';
export type ProjectType = 'standard' | 'formal-client';
export type ProjectLifecycleState = 'active' | 'paused' | 'completed' | 'archived';
export type ProjectImportance = 'critical' | 'high' | 'normal' | 'low';

export interface ProjectLink {
  label: string;
  url: string;
}

export interface Project {
  id: string;
  name: string;
  colour: ProjectColour;
  /** Icon key from the shared identity icon set */
  icon: string;
  /** The filing tag that represents this project everywhere tags appear */
  tagId: string | null;
  /** Project group (top-level filing tag), e.g. "IBM Projects" */
  groupId: string | null;
  groupName: string | null;
  category: ProjectCategory;
  priority: ProjectPriority;
  projectType: ProjectType;
  description: string;
  goal: string;
  role: string;
  ownership: string;
  lifecycleState: ProjectLifecycleState;
  startDate: string | null;
  targetEndDate: string | null;
  importance: ProjectImportance;
  expectedOutputs: string[];
  gitlabPaths: string[];
  githubRepos: string[];
  hasIcaDocumentCollection: boolean;
  icaDocumentCollectionName: string;
  icaDocumentCollectionId: string;
  links: ProjectLink[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

const PROJECT_COLUMNS = `*, to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date,
  (SELECT t.id FROM tags t WHERE t.project_id = projects.id) AS tag_id,
  (SELECT g.id FROM tags t JOIN tags g ON g.id = t.parent_id WHERE t.project_id = projects.id) AS group_id,
  (SELECT g.name FROM tags t JOIN tags g ON g.id = t.parent_id WHERE t.project_id = projects.id) AS group_name`;

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id:           row['id'] as string,
    name:         row['name'] as string,
    colour:       row['colour'] as ProjectColour,
    icon:         String(row['icon'] ?? 'folder'),
    tagId:        row['tag_id'] == null ? null : String(row['tag_id']),
    groupId:      row['group_id'] == null ? null : String(row['group_id']),
    groupName:    row['group_name'] == null ? null : String(row['group_name']),
    category:     row['category'] as ProjectCategory,
    priority:     row['priority'] as ProjectPriority,
    projectType:  (row['project_type'] as ProjectType | undefined) ?? 'standard',
    description:  row['description'] as string,
    goal:         String(row['goal'] ?? ''),
    role:         String(row['role'] ?? ''),
    ownership:    String(row['ownership'] ?? ''),
    lifecycleState: (row['lifecycle_state'] as ProjectLifecycleState | undefined) ?? 'active',
    startDate:    row['start_date'] == null ? null : String(row['start_date']),
    targetEndDate: row['target_end_date'] == null ? null : String(row['target_end_date']),
    importance:   (row['importance'] as ProjectImportance | undefined) ?? 'normal',
    expectedOutputs: Array.isArray(row['expected_outputs']) ? row['expected_outputs'] as string[] : [],
    gitlabPaths:  row['gitlab_paths'] as string[],
    githubRepos:  row['github_repos'] as string[],
    hasIcaDocumentCollection: Boolean(row['has_ica_document_collection']),
    icaDocumentCollectionName: String(row['ica_document_collection_name'] ?? ''),
    icaDocumentCollectionId: String(row['ica_document_collection_id'] ?? ''),
    links:        Array.isArray(row['links']) ? row['links'] as ProjectLink[] : [],
    tags:         row['tags'] as string[],
    createdAt:    String(row['created_at']),
    updatedAt:    String(row['updated_at']),
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

const COLOURS: ProjectColour[] = IDENTITY_COLOURS;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const CATEGORIES: ProjectCategory[] = ['work', 'personal', 'side-hustle'];
const PRIORITIES: ProjectPriority[] = ['low', 'medium', 'high'];
const PROJECT_TYPES: ProjectType[] = ['standard', 'formal-client'];
const LIFECYCLE_STATES: ProjectLifecycleState[] = ['active', 'paused', 'completed', 'archived'];
const IMPORTANCES: ProjectImportance[] = ['critical', 'high', 'normal', 'low'];
const ISO_DATE_LENGTH = 10;
const MAX_PROJECT_GOAL_LENGTH = 2000;
const MAX_PROJECT_ROLE_LENGTH = 200;

function validateOptionalDate(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${field} must be a valid YYYY-MM-DD date`, { [field]: 'invalid' });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, ISO_DATE_LENGTH) !== value) {
    throw new ValidationError(`${field} must be a valid YYYY-MM-DD date`, { [field]: 'invalid' });
  }
  return value;
}

function validateInput(input: Record<string, unknown>, requireName: boolean): void {
  if (requireName && !String(input['name'] ?? '').trim()) {
    throw new ValidationError('name is required', { name: 'required' });
  }
  if (input['colour'] !== undefined && !COLOURS.includes(input['colour'] as ProjectColour)) {
    throw new ValidationError(`colour must be one of: ${COLOURS.join(', ')}`, { colour: 'invalid' });
  }
  if (input['icon'] !== undefined && (typeof input['icon'] !== 'string' || !ICON_RE.test(input['icon']))) {
    throw new ValidationError('icon must be an icon key', { icon: 'invalid' });
  }
  if (input['groupId'] !== undefined && input['groupId'] !== null && typeof input['groupId'] !== 'string') {
    throw new ValidationError('groupId must be a tag id or null', { groupId: 'invalid' });
  }
  if (input['category'] !== undefined && !CATEGORIES.includes(input['category'] as ProjectCategory)) {
    throw new ValidationError(`category must be one of: ${CATEGORIES.join(', ')}`, { category: 'invalid' });
  }
  if (input['priority'] !== undefined && !PRIORITIES.includes(input['priority'] as ProjectPriority)) {
    throw new ValidationError(`priority must be one of: ${PRIORITIES.join(', ')}`, { priority: 'invalid' });
  }
  if (input['projectType'] !== undefined && !PROJECT_TYPES.includes(input['projectType'] as ProjectType)) {
    throw new ValidationError(`projectType must be one of: ${PROJECT_TYPES.join(', ')}`, { projectType: 'invalid' });
  }
  if (input['lifecycleState'] !== undefined && !LIFECYCLE_STATES.includes(input['lifecycleState'] as ProjectLifecycleState)) {
    throw new ValidationError(`lifecycleState must be one of: ${LIFECYCLE_STATES.join(', ')}`, { lifecycleState: 'invalid' });
  }
  if (input['importance'] !== undefined && !IMPORTANCES.includes(input['importance'] as ProjectImportance)) {
    throw new ValidationError(`importance must be one of: ${IMPORTANCES.join(', ')}`, { importance: 'invalid' });
  }
  for (const [field, maxLength] of [
    ['goal', MAX_PROJECT_GOAL_LENGTH],
    ['role', MAX_PROJECT_ROLE_LENGTH],
    ['ownership', MAX_PROJECT_ROLE_LENGTH],
  ] as const) {
    if (input[field] !== undefined &&
      (typeof input[field] !== 'string' || input[field].length > maxLength)) {
      throw new ValidationError(`${field} must be a string of at most ${maxLength} characters`, { [field]: 'invalid' });
    }
  }
  if (input['expectedOutputs'] !== undefined) {
    if (!Array.isArray(input['expectedOutputs']) ||
      input['expectedOutputs'].some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new ValidationError('Expected outputs must be a list of non-empty text descriptions', { expectedOutputs: 'invalid' });
    }
  }
  const startDate = validateOptionalDate(input['startDate'], 'startDate');
  const targetEndDate = validateOptionalDate(input['targetEndDate'], 'targetEndDate');
  if (startDate !== null && targetEndDate !== null && targetEndDate < startDate) {
    throw new ValidationError('targetEndDate cannot be earlier than startDate', { targetEndDate: 'before-start' });
  }
  if (input['links'] !== undefined) {
    if (!Array.isArray(input['links'])) {
      throw new ValidationError('links must be an array', { links: 'invalid' });
    }
    for (const link of input['links']) {
      if (typeof link !== 'object' || link === null) {
        throw new ValidationError('each link must have a label and URL', { links: 'invalid' });
      }
      const candidate = link as Record<string, unknown>;
      const label = String(candidate['label'] ?? '').trim();
      const rawUrl = String(candidate['url'] ?? '').trim();
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new ValidationError('each project reference must use a valid URL', { links: 'invalid' });
      }
      if (label === '' || !['http:', 'https:'].includes(parsed.protocol)) {
        throw new ValidationError('each project reference needs a label and an http(s) URL', { links: 'invalid' });
      }
    }
  }
}

// ── Project ↔ filing tag sync ────────────────────────────────────────────────

type Db = ReturnType<typeof getDb>;

function toSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

async function assertGroup(db: Db, groupId: string): Promise<void> {
  const r = await db.query(
    `SELECT 1 FROM tags WHERE id = $1 AND role = 'filing' AND parent_id IS NULL AND project_id IS NULL`, [groupId],
  );
  if (r.rows.length === 0) throw new ValidationError('groupId must be a project group', { groupId: 'invalid' });
}

/**
 * Keep the project's filing tag in step with the project: same name, same colour,
 * under the chosen group. Creates the tag if the project has none.
 * `groupId` undefined leaves the group unchanged; null makes the project ungrouped.
 */
async function syncProjectTag(db: Db, projectId: string, groupId: string | null | undefined): Promise<void> {
  const project = await db.query<{ name: string; colour: IdentityColour }>(
    'SELECT name, colour FROM projects WHERE id = $1', [projectId],
  );
  const row = project.rows[0];
  if (row === undefined) return;
  const hex = IDENTITY_PALETTE[row.colour] ?? IDENTITY_PALETTE.gray;
  if (groupId) await assertGroup(db, groupId);

  const existing = await db.query<{ id: string }>('SELECT id FROM tags WHERE project_id = $1', [projectId]);
  const tagId = existing.rows[0]?.id;
  if (tagId !== undefined) {
    const params: unknown[] = [tagId, row.name, hex];
    let parentSql = '';
    if (groupId !== undefined) { params.push(groupId); parentSql = `, parent_id = $${params.length}`; }
    await db.query(`UPDATE tags SET name = $2, colour = $3${parentSql}, updated_at = NOW() WHERE id = $1`, params);
    return;
  }
  const base = toSlug(projectId);
  const taken = await db.query<{ slug: string }>(`SELECT slug FROM tags WHERE slug = $1 OR slug LIKE $1 || '-%'`, [base]);
  const slugs = new Set(taken.rows.map((r) => r.slug));
  let slug = base;
  for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;
  await db.query(
    `INSERT INTO tags (name, slug, role, parent_id, colour, project_id) VALUES ($1, $2, 'filing', $3, $4, $5)`,
    [row.name, slug, groupId ?? null, hex, projectId],
  );
}

async function loadProject(db: Db, id: string): Promise<Project> {
  const r = await db.query<Record<string, unknown>>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [id]);
  if (r.rows.length === 0) throw new NotFoundError(`Project '${id}' not found`);
  return rowToProject(r.rows[0] as Record<string, unknown>);
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// GET /api/projects/groups — project groups (top-level filing tags)
router.get('/groups', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const r = await getDb().query<{ id: string; name: string }>(
        `SELECT id, name FROM tags WHERE role = 'filing' AND parent_id IS NULL AND project_id IS NULL ORDER BY name`,
      );
      const body: ApiSuccess<{ id: string; name: string }[]> = { success: true, data: r.rows };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

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
        `SELECT ${PROJECT_COLUMNS} FROM projects ${where} ORDER BY
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
        `INSERT INTO projects (id, name, colour, icon, category, priority, project_type, description, goal, role, ownership, lifecycle_state, start_date, target_end_date, importance, expected_outputs, gitlab_paths, github_repos, has_ica_document_collection, ica_document_collection_name, ica_document_collection_id, links, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING id`,
        [
          id,
          String(input['name']).trim(),
          (input['colour'] as string | undefined) ?? 'gray',
          (input['icon'] as string | undefined) ?? 'folder',
          (input['category'] as string | undefined) ?? 'work',
          (input['priority'] as string | undefined) ?? 'medium',
          (input['projectType'] as string | undefined) ?? 'standard',
          String(input['description'] ?? '').trim(),
          String(input['goal'] ?? '').trim(),
          String(input['role'] ?? '').trim(),
          String(input['ownership'] ?? '').trim(),
          (input['lifecycleState'] as string | undefined) ?? 'active',
          validateOptionalDate(input['startDate'], 'startDate'),
          validateOptionalDate(input['targetEndDate'], 'targetEndDate'),
          (input['importance'] as string | undefined) ?? 'normal',
          Array.isArray(input['expectedOutputs']) ? (input['expectedOutputs'] as string[]).map((value) => value.trim()) : [],
          Array.isArray(input['gitlabPaths']) ? (input['gitlabPaths'] as string[]).filter(Boolean) : [],
          Array.isArray(input['githubRepos']) ? (input['githubRepos'] as string[]).filter(Boolean) : [],
          input['hasIcaDocumentCollection'] === true,
          String(input['icaDocumentCollectionName'] ?? '').trim(),
          String(input['icaDocumentCollectionId'] ?? '').trim(),
          JSON.stringify(Array.isArray(input['links']) ? input['links'] : []),
          tags,
        ],
      );
      const createdId = String((result.rows[0] as Record<string, unknown>)['id']);
      await syncProjectTag(db, createdId, (input['groupId'] as string | null | undefined) ?? null);
      const body: ApiSuccess<Project> = { success: true, data: await loadProject(db, createdId) };
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
      if (input['icon'] !== undefined)        add('icon',         input['icon']);
      if (input['category'] !== undefined)    add('category',     input['category']);
      if (input['priority'] !== undefined)    add('priority',     input['priority']);
      if (input['projectType'] !== undefined) add('project_type', input['projectType']);
      if (input['description'] !== undefined) add('description',  String(input['description']).trim());
      if (input['goal'] !== undefined)         add('goal',         String(input['goal']).trim());
      if (input['role'] !== undefined)         add('role',         String(input['role']).trim());
      if (input['ownership'] !== undefined)    add('ownership',    String(input['ownership']).trim());
      if (input['lifecycleState'] !== undefined) add('lifecycle_state', input['lifecycleState']);
      if (input['importance'] !== undefined)   add('importance',   input['importance']);
      if (input['expectedOutputs'] !== undefined) {
        add('expected_outputs', (input['expectedOutputs'] as string[]).map((value) => value.trim()));
      }
      if (input['startDate'] !== undefined)    add('start_date', validateOptionalDate(input['startDate'], 'startDate'));
      if (input['targetEndDate'] !== undefined) add('target_end_date', validateOptionalDate(input['targetEndDate'], 'targetEndDate'));
      if (Array.isArray(input['gitlabPaths'])) add('gitlab_paths', (input['gitlabPaths'] as string[]).filter(Boolean));
      if (Array.isArray(input['githubRepos'])) add('github_repos', (input['githubRepos'] as string[]).filter(Boolean));
      if (input['hasIcaDocumentCollection'] !== undefined) add('has_ica_document_collection', input['hasIcaDocumentCollection'] === true);
      if (input['icaDocumentCollectionName'] !== undefined) add('ica_document_collection_name', String(input['icaDocumentCollectionName']).trim());
      if (input['icaDocumentCollectionId'] !== undefined) add('ica_document_collection_id', String(input['icaDocumentCollectionId']).trim());
      if (Array.isArray(input['links']))       add('links',        JSON.stringify(input['links']));
      if (Array.isArray(input['tags']))        add('tags',         (input['tags'] as string[]).filter(Boolean));

      if (fields.length === 0 && input['groupId'] === undefined) throw new ValidationError('no fields to update', {});
      if (input['startDate'] !== undefined || input['targetEndDate'] !== undefined) {
        const current = await db.query<{ start_date: string | null; target_end_date: string | null }>(
          `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date
           FROM projects WHERE id = $1`,
          [id],
        );
        if (current.rows.length === 0) throw new NotFoundError(`Project '${id}' not found`);
        const startDate = input['startDate'] !== undefined
          ? validateOptionalDate(input['startDate'], 'startDate')
          : current.rows[0]?.start_date ?? null;
        const targetEndDate = input['targetEndDate'] !== undefined
          ? validateOptionalDate(input['targetEndDate'], 'targetEndDate')
          : current.rows[0]?.target_end_date ?? null;
        if (startDate !== null && targetEndDate !== null && targetEndDate < startDate) {
          throw new ValidationError('targetEndDate cannot be earlier than startDate', { targetEndDate: 'before-start' });
        }
      }
      fields.push('updated_at = NOW()');
      params.push(id);

      const result = await db.query(
        `UPDATE projects SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id`,
        params,
      );
      if (result.rows.length === 0) throw new NotFoundError(`Project '${id}' not found`);
      await syncProjectTag(db, id ?? '', input['groupId'] as string | null | undefined);
      const updated = await loadProject(db, id ?? '');
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
