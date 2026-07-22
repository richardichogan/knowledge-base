/**
 * AI chat tools — function-calling handlers the model can invoke mid-conversation.
 *
 * Three capabilities, per product requirement:
 *   1. search_knowledge_base — read-only FTS query across everything indexed
 *      in content_items (commits, PRs, issues, releases, emails, calendar,
 *      notes, discovered articles, tasks-adjacent content, etc.).
 *   2. create_task / update_task — Plan board (Kanban) task CRUD.
 *   3. create_note_draft — Think section document draft creation.
 *
 * These execute immediately (no separate confirm step) — they only ever
 * touch the user's own internal Postgres data (tasks/notes), unlike the
 * higher-risk external write actions in writeActionService.ts (GitHub issues,
 * CMS publish, MS Todo push), which still require explicit confirmation.
 */

import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { getRagItems } from '../db/queries.js';
import { createNoteRecord } from '../routes/notes.js';
import { rowToTask, type Task } from '../routes/tasks.js';
import { buildLibrary, CONTENT_STORE } from '../routes/documents.js';
import { GitHubClient } from '../integrations/github/githubClient.js';
import { AI_TOOL_SEARCH_DEFAULT_LIMIT, AI_TOOL_SEARCH_MAX_LIMIT } from '../config/constants.js';

const TASK_STATUSES = ['backlog', 'in-progress', 'blocked', 'awaiting-feedback', 'completed'] as const;
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const NOTE_CONTENT_TYPES = [
  'blog', 'podcast', 'newsletter', 'project', 'note', 'script', 'architecture', 'meeting', 'research', 'spec',
] as const;

export function getToolDefinitions(): LlmToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'search_knowledge_base',
        description:
          'Full-text search across everything indexed in the knowledge hub: GitHub/GitLab commits, pull ' +
          'requests, issues, releases, deployments, calendar events, emails, blog posts, discovered articles, ' +
          "and notes. Always call this before answering questions about the user's own projects, activity, " +
          "or existing content — don't answer from memory alone.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms describing what to look up.' },
            limit: { type: 'integer', description: `Max results to return (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description:
          "Lists real tasks from the user's Plan board (Kanban) — the source of truth for outstanding/due/" +
          'overdue work. Use this (not search_knowledge_base) whenever the user asks what tasks, to-dos, or ' +
          'work items they have, are due, are overdue, or outstanding — search_knowledge_base only searches ' +
          "indexed documents/commits/notes, not the task board.",
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: [...TASK_STATUSES], description: 'Filter to a single status. Omit for all non-completed statuses.' },
            dueOnOrBefore: { type: 'string', description: 'ISO date YYYY-MM-DD — only tasks due on or before this date (e.g. today, for "due today or overdue").' },
            overdueOnly: { type: 'boolean', description: 'If true, only tasks with a due date strictly before today that are not completed.' },
            projectId: { type: 'string', description: 'Filter to a specific project id.' },
            includeCompleted: { type: 'boolean', description: 'If true, include completed tasks too. Defaults to false.' },
            limit: { type: 'integer', description: `Max results (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_library',
        description:
          "Searches the Library section — formal markdown documents (specs, READMEs, docs/ folders) stored " +
          "in the user's GitHub repos, organised by project. Use this for questions about project " +
          'documentation, specs, architecture docs, or README content — search_knowledge_base does not cover ' +
          'these files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms to match against document titles/paths.' },
            projectId: { type: 'string', description: 'Optional project id to scope the search to (e.g. "imagine"). Omit to search across all projects.' },
            limit: { type: 'integer', description: `Max results (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_task',
        description: "Creates a new task on the user's Plan board (Kanban).",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative task title.' },
            body: { type: 'string', description: 'Optional longer description / notes for the task.' },
            status: { type: 'string', enum: [...TASK_STATUSES], description: 'Defaults to "backlog".' },
            priority: { type: 'string', enum: [...TASK_PRIORITIES], description: 'Defaults to "normal".' },
            projectId: { type: 'string', description: 'Project id to file this under (e.g. "personal", "ibm-msft-practice"). Defaults to "personal" if unsure.' },
            dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD, optional.' },
          },
          required: ['title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_task',
        description:
          'Updates an existing task. Provide taskId if already known (e.g. returned from a prior ' +
          'create_task/search_knowledge_base call in this conversation); otherwise provide matchTitle to ' +
          'find it by a partial, case-insensitive title match. If multiple tasks match, the tool returns ' +
          'the candidates instead of updating — ask the user to clarify, or re-call with the exact taskId.',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Exact task UUID, if known.' },
            matchTitle: { type: 'string', description: 'Partial, case-insensitive title to find the task by, if taskId is not known.' },
            title: { type: 'string', description: 'New title.' },
            body: { type: 'string', description: 'New body/description.' },
            status: { type: 'string', enum: [...TASK_STATUSES] },
            priority: { type: 'string', enum: [...TASK_PRIORITIES] },
            dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD, or null to clear it.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_note_draft',
        description: 'Creates a new document draft in the Think section (notes).',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Title of the note/document.' },
            content: {
              type: 'string',
              description:
                'The draft content as plain text or simple markdown. A blank line separates paragraphs; ' +
                'lines starting with #, ## or ### become headings.',
            },
            contentType: { type: 'string', enum: [...NOTE_CONTENT_TYPES], description: 'Defaults to "note".' },
          },
          required: ['title', 'content'],
        },
      },
    },
  ];
}

/** Dispatches a single tool call by name, returning a JSON-serialisable result. */
export async function executeToolCall(db: Pool, name: string, argsJson: string): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return { error: 'Malformed tool arguments — could not parse JSON.' };
  }

  switch (name) {
    case 'search_knowledge_base': return searchKnowledgeBase(db, args);
    case 'list_tasks':            return listTasks(db, args);
    case 'search_library':        return searchLibrary(db, args);
    case 'create_task':           return createTask(db, args);
    case 'update_task':           return updateTask(db, args);
    case 'create_note_draft':     return createNoteDraft(db, args);
    default:                      return { error: `Unknown tool: ${name}` };
  }
}

// ── search_knowledge_base ───────────────────────────────────────────────────

async function searchKnowledgeBase(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') return { error: 'query is required' };
  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;

  const items = await getRagItems(db, query, limit);
  return {
    resultCount: items.length,
    results: items.map((item) => ({
      source: item.source,
      title: item.title,
      summary: item.summary,
      publishedAt: item.publishedAt,
      url: item.url ?? null,
    })),
  };
}

// ── list_tasks ────────────────────────────────────────────────────────────────

async function listTasks(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const conditions: string[] = ['archived = false'];
  const params: unknown[] = [];

  const includeCompleted = args['includeCompleted'] === true;
  const overdueOnly = args['overdueOnly'] === true;

  if (TASK_STATUSES.includes(args['status'] as typeof TASK_STATUSES[number])) {
    params.push(args['status']);
    conditions.push(`status = $${params.length}`);
  } else if (!includeCompleted) {
    conditions.push(`status != 'completed'`);
  }

  if (typeof args['projectId'] === 'string' && args['projectId'].trim() !== '') {
    params.push(args['projectId'].trim());
    conditions.push(`project_id = $${params.length}`);
  }

  if (overdueOnly) {
    conditions.push(`due_date IS NOT NULL AND due_date < CURRENT_DATE`);
  } else if (typeof args['dueOnOrBefore'] === 'string' && args['dueOnOrBefore'].trim() !== '') {
    params.push(args['dueOnOrBefore'].trim());
    conditions.push(`due_date IS NOT NULL AND due_date <= $${params.length}`);
  }

  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;
  params.push(limit);

  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY due_date ASC NULLS LAST, created_at DESC LIMIT $${params.length}`,
    params,
  );

  const tasks = result.rows.map(rowToTask);
  return { resultCount: tasks.length, tasks: tasks.map(summariseTask) };
}

// ── search_library ──────────────────────────────────────────────────────────

async function searchLibrary(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim().toLowerCase() : '';
  const projectId = typeof args['projectId'] === 'string' ? args['projectId'].trim() : '';
  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;

  let repos: string[] = [];
  const labelMap: Record<string, string> = {};

  if (projectId !== '') {
    const r = await db.query<{ id: string; name: string; github_repos: string[] }>(
      `SELECT id, name, github_repos FROM projects WHERE id = $1`,
      [projectId],
    );
    const row = r.rows[0];
    if (row === undefined) return { error: `No project found with id "${projectId}"` };
    repos = row.github_repos ?? [];
    for (const repo of repos) labelMap[repo] = row.name;
  } else {
    const r = await db.query<{ name: string; github_repos: string[] }>(
      `SELECT name, github_repos FROM projects WHERE array_length(github_repos, 1) > 0`,
    );
    for (const row of r.rows) {
      for (const repo of row.github_repos) {
        repos.push(repo);
        labelMap[repo] = row.name;
      }
    }
  }

  const gh = new GitHubClient();
  const docs = await buildLibrary(gh, repos, labelMap);

  const filtered = query === ''
    ? docs
    : docs.filter((d) =>
        d.title.toLowerCase().includes(query) ||
        d.path.toLowerCase().includes(query) ||
        d.sourceLabel.toLowerCase().includes(query) ||
        d.repo.toLowerCase().includes(query),
      );

  const results = filtered.slice(0, limit).map((d) => ({
    title: d.title,
    repo: d.repo === CONTENT_STORE ? 'Content Store' : d.repo,
    path: d.path,
    sourceLabel: d.sourceLabel,
    url: d.htmlUrl,
  }));

  return { resultCount: results.length, totalScanned: docs.length, documents: results };
}

// ── create_task / update_task ────────────────────────────────────────────────

function summariseTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    dueDate: task.dueDate,
  };
}

async function createTask(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
  if (title === '') return { error: 'title is required' };

  const status = TASK_STATUSES.includes(args['status'] as typeof TASK_STATUSES[number]) ? args['status'] as string : 'backlog';
  const priority = TASK_PRIORITIES.includes(args['priority'] as typeof TASK_PRIORITIES[number]) ? args['priority'] as string : 'normal';
  const projectId = typeof args['projectId'] === 'string' && args['projectId'].trim() !== '' ? args['projectId'].trim() : 'personal';
  const body = typeof args['body'] === 'string' ? args['body'] : '';
  const dueDate = typeof args['dueDate'] === 'string' && args['dueDate'].trim() !== '' ? args['dueDate'].trim() : null;

  // Duplicate-call guard: if the model re-issues create_task for a task it
  // (or the user, via another route) already created moments ago — e.g. the
  // model mistakenly re-triggers the same tool call after a follow-up
  // message like "thanks" — return the existing task instead of inserting
  // a second copy. Scoped to an exact-title match created in the last 5
  // minutes, so intentional duplicate titles created later are unaffected.
  const dupe = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks
     WHERE archived = false AND title = $1 AND created_at > now() - interval '5 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [title],
  );
  const dupeRow = dupe.rows[0];
  if (dupeRow !== undefined) {
    return { success: true, task: summariseTask(rowToTask(dupeRow)), duplicate: true };
  }

  const result = await db.query<Record<string, unknown>>(
    `INSERT INTO tasks (title, body, status, project_id, tags, priority, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [title, body, status, projectId, [], priority, dueDate],
  );
  const row = result.rows[0];
  if (row === undefined) return { error: 'Insert returned no rows' };

  const task = rowToTask(row);
  return { success: true, task: summariseTask(task) };
}

async function resolveTask(
  db: Pool,
  taskId: unknown,
  matchTitle: unknown,
): Promise<{ id: string; title: string } | { ambiguous: Array<{ id: string; title: string }> } | { notFound: true } | { error: string }> {
  if (typeof taskId === 'string' && taskId.trim() !== '') {
    const r = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE id = $1 AND archived = false`,
      [taskId.trim()],
    );
    const row = r.rows[0];
    return row !== undefined ? row : { notFound: true };
  }
  if (typeof matchTitle === 'string' && matchTitle.trim() !== '') {
    const r = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE archived = false AND title ILIKE $1 ORDER BY created_at DESC LIMIT 5`,
      [`%${matchTitle.trim()}%`],
    );
    if (r.rows.length === 0) return { notFound: true };
    if (r.rows.length > 1) return { ambiguous: r.rows };
    return r.rows[0] as { id: string; title: string };
  }
  return { error: 'Provide either taskId or matchTitle' };
}

async function updateTask(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const resolved = await resolveTask(db, args['taskId'], args['matchTitle']);
  if ('error' in resolved) return resolved;
  if ('notFound' in resolved) return { error: 'No matching task found.' };
  if ('ambiguous' in resolved) {
    return {
      ambiguous: true,
      message: 'Multiple tasks matched — ask the user which one they mean, or re-call with the exact taskId.',
      candidates: resolved.ambiguous,
    };
  }

  const fields: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown): void => { params.push(val); fields.push(`${col} = $${params.length}`); };

  if (typeof args['title'] === 'string' && args['title'].trim() !== '') add('title', args['title'].trim());
  if (typeof args['body'] === 'string') add('body', args['body']);
  if (TASK_STATUSES.includes(args['status'] as typeof TASK_STATUSES[number])) add('status', args['status']);
  if (TASK_PRIORITIES.includes(args['priority'] as typeof TASK_PRIORITIES[number])) add('priority', args['priority']);
  if ('dueDate' in args) add('due_date', args['dueDate'] === null ? null : (typeof args['dueDate'] === 'string' ? args['dueDate'] : null));

  if (fields.length === 0) return { error: 'No fields to update were provided.' };

  fields.push('updated_at = NOW()');
  params.push(resolved.id);
  const result = await db.query<Record<string, unknown>>(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  const row = result.rows[0];
  if (row === undefined) return { error: 'Update returned no rows' };

  const task = rowToTask(row);
  return { success: true, task: summariseTask(task) };
}

// ── create_note_draft ────────────────────────────────────────────────────────

interface DraftBlock {
  type: 'heading' | 'paragraph';
  props?: { level: number };
  content: Array<{ type: 'text'; text: string; styles: Record<string, never> }>;
}

/** Splits plain/markdown-ish text into simple BlockNote paragraph/heading blocks. */
function textToBlocks(text: string): DraftBlock[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '');
  return paragraphs.map((p) => {
    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(p);
    if (headingMatch) {
      const hashes = headingMatch[1] ?? '#';
      return {
        type: 'heading',
        props: { level: hashes.length },
        content: [{ type: 'text', text: headingMatch[2] ?? '', styles: {} }],
      };
    }
    return { type: 'paragraph', content: [{ type: 'text', text: p, styles: {} }] };
  });
}

async function createNoteDraft(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = typeof args['title'] === 'string' && args['title'].trim() !== '' ? args['title'].trim() : 'Untitled';
  const content = typeof args['content'] === 'string' ? args['content'] : '';
  if (content.trim() === '') return { error: 'content is required' };
  const contentType = NOTE_CONTENT_TYPES.includes(args['contentType'] as typeof NOTE_CONTENT_TYPES[number])
    ? args['contentType'] as string
    : 'note';

  const blocks = textToBlocks(content);
  const wrapper = { title, contentType, contentJson: JSON.stringify(blocks) };

  const note = await createNoteRecord(db, { content: JSON.stringify(wrapper), tags: [] });
  return { success: true, note: { id: note.id, title, contentType } };
}
