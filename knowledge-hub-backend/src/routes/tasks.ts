import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createTodoTask } from '../integrations/graph/todoSync.js';
import { createGitHubIssue } from '../integrations/github/issuesSync.js';
import { getDb } from '../db/db.js';
import { HTTP_STATUS, AI_DEFAULT_MAX_TOKENS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess, PaginatedList } from '../types/apiResponse.js';
import { FoundryClient } from '../ai/foundryClient.js';
import { env } from '../config/env.js';

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
  startDate: string | null;
  endDate: string | null;
  externalUrl: string | null;
  linkedTagId: string | null;
  taxonomyTagIds: string[];
  recurringCadence: 'daily' | 'weekly' | 'fortnightly' | 'monthly' | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToTask(row: Record<string, unknown>): Task {
  const toDate = (val: unknown): string | null =>
    val ? new Date(val as string).toISOString().substring(0, 'YYYY-MM-DD'.length) : null;
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    body: row['body'] as string,
    status: row['status'] as Task['status'],
    projectId: row['project_id'] as string,
    tags: row['tags'] as string[],
    priority: row['priority'] as Task['priority'],
    dueDate: toDate(row['due_date']),
    startDate: toDate(row['start_date']),
    endDate: toDate(row['end_date']),
    externalUrl: row['external_url'] as string | null,
    linkedTagId: row['linked_tag_id'] as string | null ?? null,
    taxonomyTagIds: ((row['taxonomy_tag_ids'] as string[] | null) ?? []).filter(Boolean),
    recurringCadence: (row['recurring_cadence'] as Task['recurringCadence']) ?? null,
    archived: Boolean(row['archived']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { status, projectId } = req.query as Record<string, string | undefined>;
      const conditions: string[] = ['t.archived = false'];
      const params: unknown[] = [];
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      if (projectId) { params.push(projectId); conditions.push(`project_id = $${params.length}`); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await db.query<Record<string, unknown>>(
        `SELECT t.id, t.title, t.body, t.status, t.project_id, t.tags, t.priority,
                t.due_date, t.start_date, t.end_date, t.external_url, t.linked_tag_id,
                t.recurring_cadence, t.archived, t.created_at, t.updated_at,
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
      const input = req.body as Partial<{ title: string; body: string; status: string; projectId: string; tags: string[]; priority: string; dueDate: string; startDate: string; endDate: string; pushToTodo: boolean; pushToGithub: boolean; githubRepo: string; taxonomyTagIds: string[]; recurringCadence: string }>;
      if (!input.title?.trim()) throw new ValidationError('title is required', { title: 'required' });
      const result = await db.query<Record<string, unknown>>(
        `INSERT INTO tasks (title, body, status, project_id, tags, priority, due_date, start_date, end_date, recurring_cadence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [input.title.trim(), input.body?.trim() ?? '', input.status ?? 'backlog', input.projectId ?? 'personal', input.tags ?? [], input.priority ?? 'normal', input.dueDate ?? null, input.startDate ?? null, input.endDate ?? null, input.recurringCadence ?? null],
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
      const input = req.body as Partial<{ title: string; body: string; status: string; projectId: string; tags: string[]; priority: string; dueDate: string | null; startDate: string | null; endDate: string | null; linkedTagId: string | null; taxonomyTagIds: string[]; recurringCadence: string | null }>;
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
      if ('startDate' in input) add('start_date', input.startDate ?? null);
      if ('endDate' in input) add('end_date', input.endDate ?? null);
      if ('linkedTagId' in input) add('linked_tag_id', input.linkedTagId ?? null);
      if ('recurringCadence' in input) add('recurring_cadence', input.recurringCadence ?? null);

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

      // Auto-spawn next instance when a recurring task is completed
      if (input.status === 'completed' && task.recurringCadence != null) {
        const cadence = task.recurringCadence;
        const DATE_LEN = 'YYYY-MM-DD'.length;
        const todayStr = new Date().toISOString().substring(0, DATE_LEN);
        const baseStr: string = task.startDate ?? todayStr;
        const base = new Date(baseStr);
        const next = new Date(base);
        if (cadence === 'daily')            { next.setDate(base.getDate() + 1); }
        else if (cadence === 'weekly')      { next.setDate(base.getDate() + 7); }
        else if (cadence === 'fortnightly') { next.setDate(base.getDate() + 14); }
        else                               { next.setMonth(base.getMonth() + 1); }
        const nextStart = next.toISOString().substring(0, DATE_LEN);
        // Don't spawn if next start would be after the recurrence end date
        const shouldSpawn = task.endDate == null || nextStart <= task.endDate;
        if (shouldSpawn) {
          const spawnResult = await db.query<Record<string, unknown>>(
            `INSERT INTO tasks (title, body, status, project_id, tags, priority, start_date, end_date, recurring_cadence)
             VALUES ($1,$2,'backlog',$3,$4,$5,$6,$7,$8) RETURNING *`,
            [task.title, task.body, task.projectId, task.tags, task.priority, nextStart, task.endDate, cadence],
          );
          const spawned = rowToTask(spawnResult.rows[0] as Record<string, unknown>);
          if (task.taxonomyTagIds.length > 0) {
            const tagOffset = 2;
            const vals = task.taxonomyTagIds.map((_, i) => `($1, $${i + tagOffset})`).join(', ');
            await db.query(`INSERT INTO task_tags (task_id, tag_id) VALUES ${vals}`, [spawned.id, ...task.taxonomyTagIds]);
          }
        }
      }

      const body: ApiSuccess<Task> = { success: true, data: task };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

router.post('/:id/archive', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { id } = req.params;
      const result = await db.query<Record<string, unknown>>(
        `UPDATE tasks SET archived = true, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id],
      );
      if (result.rows.length === 0) throw new NotFoundError(`Task ${id} not found`);
      const body: ApiSuccess<Task> = { success: true, data: rowToTask(result.rows[0] as Record<string, unknown>) };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {  void (async () => {
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

// ── Activity log ──────────────────────────────────────────────────────────────

interface TaskNote {
  id: string;
  taskId: string;
  body: string;
  createdAt: string;
}

router.get('/:id/notes', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const result = await db.query<Record<string, unknown>>(
        `SELECT id, task_id, body, created_at FROM task_notes WHERE task_id = $1 ORDER BY created_at ASC`,
        [req.params['id']],
      );
      const notes: TaskNote[] = result.rows.map((r) => ({
        id: r['id'] as string,
        taskId: r['task_id'] as string,
        body: r['body'] as string,
        createdAt: String(r['created_at']),
      }));
      const body: ApiSuccess<TaskNote[]> = { success: true, data: notes };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

router.post('/:id/notes', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { id } = req.params;
      const input = req.body as { body?: string };
      if (!input.body?.trim()) throw new ValidationError('body is required', { body: 'required' });
      const result = await db.query<Record<string, unknown>>(
        `INSERT INTO task_notes (task_id, body) VALUES ($1, $2) RETURNING id, task_id, body, created_at`,
        [id, input.body.trim()],
      );
      const row = result.rows[0] as Record<string, unknown>;
      const note: TaskNote = { id: row['id'] as string, taskId: row['task_id'] as string, body: row['body'] as string, createdAt: String(row['created_at']) };
      const body: ApiSuccess<TaskNote> = { success: true, data: note };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) { next(err); }
  })();
});

// ── Linked items ──────────────────────────────────────────────────────────────

interface TaskLink {
  id: string;
  taskId: string;
  targetType: 'note' | 'document';
  targetId: string;
  targetTitle: string;
  targetUrl: string;
  createdAt: string;
}

router.get('/:id/links', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const result = await db.query<Record<string, unknown>>(
        `SELECT id, task_id, target_type, target_id, target_title, target_url, created_at FROM task_links WHERE task_id = $1 ORDER BY created_at ASC`,
        [req.params['id']],
      );
      const links: TaskLink[] = result.rows.map((r) => ({
        id: r['id'] as string,
        taskId: r['task_id'] as string,
        targetType: r['target_type'] as TaskLink['targetType'],
        targetId: r['target_id'] as string,
        targetTitle: r['target_title'] as string,
        targetUrl: (r['target_url'] as string) ?? '',
        createdAt: String(r['created_at']),
      }));
      const body: ApiSuccess<TaskLink[]> = { success: true, data: links };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

router.post('/:id/links', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { id } = req.params;
      const input = req.body as { targetType?: string; targetId?: string; targetTitle?: string; targetUrl?: string };
      if (!input.targetType || !input.targetId) throw new ValidationError('targetType and targetId are required', {});
      const result = await db.query<Record<string, unknown>>(
        `INSERT INTO task_links (task_id, target_type, target_id, target_title, target_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (task_id, target_type, target_id) DO NOTHING
         RETURNING id, task_id, target_type, target_id, target_title, target_url, created_at`,
        [id, input.targetType, input.targetId, input.targetTitle ?? '', input.targetUrl ?? ''],
      );
      if (result.rows.length === 0) {
        // Already linked — fetch existing
        const existing = await db.query<Record<string, unknown>>(
          `SELECT id, task_id, target_type, target_id, target_title, target_url, created_at FROM task_links WHERE task_id=$1 AND target_type=$2 AND target_id=$3`,
          [id, input.targetType, input.targetId],
        );
        const r = existing.rows[0] as Record<string, unknown>;
        const link: TaskLink = { id: r['id'] as string, taskId: r['task_id'] as string, targetType: r['target_type'] as TaskLink['targetType'], targetId: r['target_id'] as string, targetTitle: r['target_title'] as string, targetUrl: (r['target_url'] as string) ?? '', createdAt: String(r['created_at']) };
        res.status(HTTP_STATUS.OK).json({ success: true, data: link });
        return;
      }
      const r = result.rows[0] as Record<string, unknown>;
      const link: TaskLink = { id: r['id'] as string, taskId: r['task_id'] as string, targetType: r['target_type'] as TaskLink['targetType'], targetId: r['target_id'] as string, targetTitle: r['target_title'] as string, targetUrl: (r['target_url'] as string) ?? '', createdAt: String(r['created_at']) };
      const body: ApiSuccess<TaskLink> = { success: true, data: link };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) { next(err); }
  })();
});

router.delete('/:id/links/:linkId', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const { id, linkId } = req.params;
      const result = await db.query(`DELETE FROM task_links WHERE id = $1 AND task_id = $2`, [linkId, id]);
      if (result.rowCount === 0) throw new NotFoundError(`Link ${linkId} not found`);
      res.status(HTTP_STATUS.OK).json({ success: true, data: undefined });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/tasks/import ────────────────────────────────────────────────────
// Accepts markdown + a document type and uses AI to extract/generate tasks.

const IMPORT_PROMPTS: Record<string, string> = {

  podcast: `You are a task planning assistant for a technology podcast and blog.

TODAY'S DATE: {{TODAY}}

Given podcast episode marketing plan markdown, generate the exact tasks needed to publish and promote this episode.
Always produce tasks covering (where applicable):
- Finalising / uploading show notes before release
- Pre-release teaser posts for LinkedIn, X and Bluesky (3 days before release)
- Release day social posts (LinkedIn, X, Bluesky)
- Weekly follow-up LinkedIn posts (weeks 1, 2 and 3 after release)
- Companion blog post

Rules:
- Extract the episode title and release date. Release date is usually in a "Date:" or "Release:" field.
- If no release date is found, default to TODAY + 7 days. Never use dates before today.
- Set body to 2-3 specific talking points from the episode content relevant to that task.
- Priority: "urgent" for release-day/pre-release; "high" for blog post; "normal" for follow-up social posts.
- Status: "backlog". projectId: "microsoft-cloud-blog".
Return ONLY a valid JSON array. No markdown fences. Each object: { "title": string, "body": string, "dueDate": "YYYY-MM-DD" | null, "priority": "urgent"|"high"|"normal"|"low", "status": "backlog", "projectId": string }`,

  meeting: `You are an action-item extraction assistant.

TODAY'S DATE: {{TODAY}}

Given a meeting transcript or notes, extract every action item, commitment or next step that was agreed.

Rules:
- Look for explicit actions ("X will do Y", "we need to", "action:", "follow up:", "TODO") and implicit commitments made in discussion.
- Set title to a short imperative phrase (e.g. "Send proposal to client").
- Set body to 1-2 sentences of context — who raised it, what was decided.
- Include the owner's name in the body if mentioned.
- Infer dueDate from any deadline mentioned near the action ("by Friday", "end of week", "before the 15th"). Resolve relative dates against TODAY. If none, set null.
- Priority: "urgent" if described as urgent/ASAP/critical; "high" if important; otherwise "normal".
- Status: "backlog". Infer projectId from context if a project name is mentioned; otherwise "personal".
Return ONLY a valid JSON array. No markdown fences. Each object: { "title": string, "body": string, "dueDate": "YYYY-MM-DD" | null, "priority": "urgent"|"high"|"normal"|"low", "status": "backlog", "projectId": string }`,

  general: `You are a task extraction assistant.

TODAY'S DATE: {{TODAY}}

Given any markdown document, extract everything that looks like a task, action item or to-do.
Look for: checkbox items (- [ ]), lines starting with TODO/Action/Next step/Follow up, bullet points describing something that needs doing, sentences implying someone needs to act.

Rules:
- Only extract genuine actions — skip headings, background context and observations.
- Set title to a short imperative phrase.
- Set body to supporting context (1-2 sentences). Empty string if none.
- Infer dueDate from any date mentioned near the task. If none, set null.
- Infer priority: urgent/ASAP/critical → "urgent"; important/high priority → "high"; default → "normal".
- Status: "backlog". Infer projectId from context if possible; otherwise "personal".
Return ONLY a valid JSON array. No markdown fences. Each object: { "title": string, "body": string, "dueDate": "YYYY-MM-DD" | null, "priority": "urgent"|"high"|"normal"|"low", "status": "backlog", "projectId": string }`,
};


interface ImportedTaskSuggestion {
  title: string;
  body: string;
  dueDate: string | null;
  priority: Task['priority'];
  status: Task['status'];
  projectId: string;
}

router.post('/import', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { content, type } = req.body as { content?: string; type?: string };
      if (!content?.trim()) throw new ValidationError('content is required', {});
      if (!env.AZURE_OPENAI_API_KEY && !env.AZURE_OPENAI_ENDPOINT) {
        throw new ValidationError('AI service not configured', {});
      }

      const client = new FoundryClient();
      const todayStr = new Date().toISOString().substring(0, 'YYYY-MM-DD'.length);
      const promptTemplate = IMPORT_PROMPTS[type ?? 'general'] ?? IMPORT_PROMPTS['general'] ?? '';
      const systemPrompt = promptTemplate.replace('{{TODAY}}', todayStr);
      const raw = await client.chat(
        'gpt-4o',
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Here is the markdown document:\n\n${content}` },
        ],
        AI_DEFAULT_MAX_TOKENS,
      );

      // Strip any markdown code fences the model might add
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let suggestions: ImportedTaskSuggestion[];
      try {
        suggestions = JSON.parse(cleaned) as ImportedTaskSuggestion[];
      } catch {
        throw new ValidationError('AI returned invalid JSON — please try again', {});
      }


      const body: ApiSuccess<ImportedTaskSuggestion[]> = { success: true, data: suggestions };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export { router as tasksRouter };
