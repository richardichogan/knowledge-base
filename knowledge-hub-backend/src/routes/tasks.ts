import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createTodoTask } from '../integrations/graph/todoSync.js';
import { createGitHubIssue } from '../integrations/github/issuesSync.js';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess, PaginatedList } from '../types/apiResponse.js';

const router = Router();

export interface Task {
  id: string;
  title: string;
  body: string;
  status: 'backlog' | 'in-progress' | 'blocked' | 'awaiting-feedback' | 'completed';
  projectId: string;
  tags: string[];
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueDate: string | null;
  externalUrl: string | null;
  linkedTagId: string | null;
  taxonomyTagIds: string[];
  createdAt: string;
  updatedAt: string;
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    body: row['body'] as string,
    status: row['status'] as Task['status'],
    projectId: row['project_id'] as string,
    tags: row['tags'] as string[],
    priority: row['priority'] as Task['priority'],
    dueDate: row['due_date'] ? new Date(row['due_date'] as string).toISOString().substring(0, 'YYYY-MM-DD'.length) : null,
    externalUrl: row['external_url'] as string | null,
    linkedTagId: row['linked_tag_id'] as string | null ?? null,
    taxonomyTagIds: ((row['taxonomy_tag_ids'] as string[] | null) ?? []).filter(Boolean),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { status, projectId } = req.query as Record<string, string | undefined>;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      if (projectId) { params.push(projectId); conditions.push(`project_id = $${params.length}`); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await db.query<Record<string, unknown>>(
        `SELECT t.id, t.title, t.body, t.status, t.project_id, t.tags, t.priority,
                t.due_date, t.external_url, t.linked_tag_id, t.created_at, t.updated_at,
                ARRAY_REMOVE(ARRAY_AGG(tt.tag_id), NULL) AS taxonomy_tag_ids
         FROM tasks t
         LEFT JOIN task_tags tt ON tt.task_id = t.id
         ${where ? where.replace(/status/g, 't.status').replace(/project_id/g, 't.project_id') : ''}
         GROUP BY t.id
         ORDER BY
           CASE t.status WHEN 'in-progress' THEN 1 WHEN 'blocked' THEN 2 WHEN 'awaiting-feedback' THEN 3 WHEN 'backlog' THEN 4 WHEN 'completed' THEN 5 END,
           CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 END,
           t.created_at DESC`,
        params,
      );
      const tasks = result.rows.map(rowToTask);
      const body: ApiSuccess<PaginatedList<Task>> = { success: true, data: { items: tasks, total: tasks.length, page: 1, pageSize: tasks.length, hasMore: false } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

router.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const input = req.body as Partial<{ title: string; body: string; status: string; projectId: string; tags: string[]; priority: string; dueDate: string; pushToTodo: boolean; pushToGithub: boolean; githubRepo: string; taxonomyTagIds: string[] }>;
      if (!input.title?.trim()) throw new ValidationError('title is required', { title: 'required' });
      const result = await db.query<Record<string, unknown>>(
        `INSERT INTO tasks (title, body, status, project_id, tags, priority, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.title.trim(), input.body?.trim() ?? '', input.status ?? 'backlog', input.projectId ?? 'personal', input.tags ?? [], input.priority ?? 'normal', input.dueDate ?? null],
      );
      const task = rowToTask(result.rows[0] as Record<string, unknown>);

      // Save taxonomy tags
      const tagIds = input.taxonomyTagIds ?? [];
      if (tagIds.length > 0) {
        const vals = tagIds.map((_, i) => `($1, $${i + 2})`).join(', ');
        await db.query(`INSERT INTO task_tags (task_id, tag_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [task.id, ...tagIds]);
        task.taxonomyTagIds = tagIds;
      }
      if (input.pushToTodo === true) {
        try { await createTodoTask({ title: task.title, ...(task.body !== '' && { body: task.body }) }); } catch (e) { console.error('[tasks] MS Todo push failed:', e); }
      }
      if (input.pushToGithub === true && input.githubRepo) {
        try {
          const url = await createGitHubIssue(input.githubRepo, task.title, task.body);
          await db.query(`UPDATE tasks SET external_url=$1, updated_at=NOW() WHERE id=$2`, [url, task.id]);
          task.externalUrl = url;
        } catch (e) { console.error('[tasks] GitHub issue push failed:', e); }
      }
      const body: ApiSuccess<Task> = { success: true, data: task };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) { next(err); }
  })();
});

router.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { id } = req.params;
      const input = req.body as Partial<{ title: string; body: string; status: string; projectId: string; tags: string[]; priority: string; dueDate: string | null; linkedTagId: string | null; taxonomyTagIds: string[] }>;
      const fields: string[] = [];
      const params: unknown[] = [];
      const add = (col: string, val: unknown): void => { params.push(val); fields.push(`${col} = $${params.length}`); };
      if (input.title !== undefined) add('title', input.title.trim());
      if (input.body !== undefined) add('body', input.body);
      if (input.status !== undefined) add('status', input.status);
      if (input.projectId !== undefined) add('project_id', input.projectId);
      if (input.tags !== undefined) add('tags', input.tags);
      if (input.priority !== undefined) add('priority', input.priority);
      if ('dueDate' in input) add('due_date', input.dueDate ?? null);
      if ('linkedTagId' in input) add('linked_tag_id', input.linkedTagId ?? null);

      // Sync taxonomy tags if provided
      const syncTags = input.taxonomyTagIds !== undefined;
      if (fields.length === 0 && !syncTags) throw new ValidationError('no fields to update', {});

      let task: Task;
      if (fields.length > 0) {
        fields.push(`updated_at = NOW()`);
        params.push(id);
        const result = await db.query<Record<string, unknown>>(`UPDATE tasks SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        if (result.rows.length === 0) throw new NotFoundError(`Task ${id} not found`);
        task = rowToTask(result.rows[0] as Record<string, unknown>);
      } else {
        const result = await db.query<Record<string, unknown>>(`SELECT * FROM tasks WHERE id = $1`, [id]);
        if (result.rows.length === 0) throw new NotFoundError(`Task ${id} not found`);
        task = rowToTask(result.rows[0] as Record<string, unknown>);
      }

      if (syncTags) {
        const tagIds = input.taxonomyTagIds ?? [];
        await db.query('DELETE FROM task_tags WHERE task_id = $1', [id]);
        if (tagIds.length > 0) {
          const vals = tagIds.map((_, i) => `($1, $${i + 2})`).join(', ');
          await db.query(`INSERT INTO task_tags (task_id, tag_id) VALUES ${vals}`, [id, ...tagIds]);
        }
        task.taxonomyTagIds = tagIds;
      }

      const body: ApiSuccess<Task> = { success: true, data: task };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { id } = req.params;
      const result = await db.query(`DELETE FROM tasks WHERE id = $1`, [id]);
      if (result.rowCount === 0) throw new NotFoundError(`Task ${id} not found`);
      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export { router as tasksRouter };
