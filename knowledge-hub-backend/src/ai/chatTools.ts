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
import { getRagItems, getContentItemsByIds } from '../db/queries.js';
import { isFoundryIqEnabled, retrieveContentItemIds } from './foundryIqClient.js';
import { createNoteRecord } from '../routes/notes.js';
import { rowToTask, type Task } from '../routes/tasks.js';
import { buildLibrary, CONTENT_STORE } from '../routes/documents.js';
import { GitHubClient } from '../integrations/github/githubClient.js';
import { AI_TOOL_SEARCH_DEFAULT_LIMIT, AI_TOOL_SEARCH_MAX_LIMIT } from '../config/constants.js';
import { env } from '../config/env.js';
import { isIcaEnabled, icaChat } from './icaClient.js';
import {
  parseNoteContent,
  extractImageBlockUrls,
  blocksToTextWithImages,
  blobIdFromUrl,
} from '../utils/noteContent.js';
import { getLearnMcpTools, isLearnMcpTool, callLearnMcpTool } from './learnMcpClient.js';

/** Cap on how much note text (including image vision analysis) we hand to the model per result. */
const NOTE_CONTENT_MAX_CHARS = 6000;

const TASK_STATUSES = ['backlog', 'in-progress', 'blocked', 'awaiting-feedback', 'completed'] as const;
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const NOTE_CONTENT_TYPES = [
  'blog', 'podcast', 'podcast-show-notes', 'newsletter', 'project', 'note', 'script', 'architecture', 'meeting', 'research', 'spec',
] as const;

export async function getToolDefinitions(): Promise<LlmToolDefinition[]> {
  const learnTools = await getLearnMcpTools();
  return [
    ...(isIcaEnabled() ? [{
      type: 'function' as const,
      function: {
        name: 'search_ica',
        description:
          'Queries ICA — IBM\'s internal Gen AI gateway — for ibm.com-domain work context (IBM-internal ' +
          'projects, initiatives, and material) that search_knowledge_base cannot see, since IBM does not ' +
          'permit that data to flow through the Alliance-tenant integrations this app otherwise uses. Use ' +
          'this for questions specifically about IBM-internal work (e.g. ATOM/ACRE, IBM-side IMAGINE detail, ' +
          'internal IBM initiatives) that search_knowledge_base alone would not have visibility into. For a ' +
          'question that spans both IBM-internal and Alliance-tenant/personal context, call both tools and ' +
          'synthesise the results into one answer — do not treat them as alternatives, they cover disjoint data.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The question or topic to ask ICA about.' },
          },
          required: ['query'],
        },
      },
    }] : []),
    {
      type: 'function',
      function: {
        name: 'search_knowledge_base',
        description:
          'Full-text search across everything indexed in the knowledge hub: GitHub/GitLab commits, pull ' +
          'requests, issues, releases, deployments, calendar events, emails, blog posts, discovered articles, ' +
          "and notes. Always call this before answering questions about the user's own projects, activity, " +
          "or existing content — don't answer from memory alone. For notes, results include a `content` " +
          'field with the full note text; any pasted diagram/screenshot is included there as ' +
          '"[Image: <description>]" using its stored vision analysis — treat that description as what the ' +
          "image actually shows, don't claim you can't see embedded images.",
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
        name: 'search_knowledge_graph',
        description:
          'Searches the knowledge graph — explicit, typed connections between items (notes, discovered ' +
          'articles, documents, tasks, commits, sparks, canvases, CFP items), each with a confidence score. ' +
          'This answers "what is X actually linked to?" in a way full-text search cannot, since two items ' +
          'can be explicitly connected without sharing any matching words. Use it whenever the user asks how ' +
          'things relate/connect, or after finding something relevant via search_knowledge_base and you want ' +
          "to check what else it's explicitly linked to. Matches node titles by substring (case-insensitive).",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to match against graph node titles (e.g. a project or note name).' },
            limit: { type: 'integer', description: `Max matching nodes to seed from (default ${AI_TOOL_SEARCH_DEFAULT_LIMIT}, max ${AI_TOOL_SEARCH_MAX_LIMIT}).` },
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
          "Searches ONLY the Library section — formal markdown documents (specs, READMEs, docs/ folders) " +
          "stored in the user's GitHub repos. It does NOT cover notes, the discovery feed, tasks, emails, " +
          "or anything else — those are search_knowledge_base only. Never use this as a substitute for " +
          "search_knowledge_base on a project question; call search_knowledge_base first (or alongside) so " +
          "notes and discovered articles are represented, and use this in addition when the question is " +
          "specifically about formal docs/specs/READMEs.",
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
          'create_task/search_knowledge_base call in this conversation); otherwise provide matchTitle — a ' +
          'paraphrase or description is fine, it does not need to be an exact substring of the title. The ' +
          'tool does fuzzy keyword matching, not just literal substring matching. If the result has ' +
          '`ambiguous: true` or `needsConfirmation: true`, do not treat the task as updated — show the ' +
          'candidate(s) to the user and ask them to confirm which one they mean before re-calling with the ' +
          'exact taskId.',
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
    {
      type: 'function',
      function: {
        name: 'fetch_web_page',
        description:
          'Fetches and reads the text content of a single external web page by URL — for grounding a claim, ' +
          'a competitor product, an article, or any external source outside the knowledge hub. Use this ' +
          "(especially in the brainstorming persona) instead of answering from memory when the user references " +
          'a specific URL, or when a concrete external fact would materially change the critique. Does not ' +
          'perform a web search — it can only read a page whose exact URL you already have (from the user\'s ' +
          'message or a prior tool result); it cannot discover new URLs.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full http(s) URL of the page to fetch.' },
          },
          required: ['url'],
        },
      },
    },
    // Microsoft Learn MCP tools (microsoft_docs_search, microsoft_docs_fetch,
    // microsoft_code_sample_search as of writing) — fetched live from the
    // remote MCP server so we track whatever it currently advertises rather
    // than hardcoding a schema that may drift. Empty array (not an error) if
    // the server is unreachable this turn.
    ...learnTools,
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
    case 'search_knowledge_graph': return searchKnowledgeGraph(db, args);
    case 'list_tasks':            return listTasks(db, args);
    case 'search_library':        return searchLibrary(db, args);
    case 'create_task':           return createTask(db, args);
    case 'update_task':           return updateTask(db, args);
    case 'create_note_draft':     return createNoteDraft(db, args);
    case 'fetch_web_page':        return fetchWebPage(args);
    case 'search_ica':            return searchIca(args);
    default:
      if (isLearnMcpTool(name)) return callLearnMcpTool(name, args);
      return { error: `Unknown tool: ${name}` };
  }
}

// ── search_knowledge_base ───────────────────────────────────────────────────

/**
 * Resolves the ranked item set for search_knowledge_base. Prefers Foundry IQ
 * (Azure AI Search agentic retrieval — semantic/hybrid search, handles
 * paraphrases the Postgres FTS path structurally cannot), falling back to
 * the Postgres tsvector path (getRagItems) if Foundry IQ isn't configured or
 * the request fails, so a Search outage degrades quality rather than
 * breaking the tool outright.
 */
async function getKnowledgeBaseItems(db: Pool, query: string, limit: number) {
  if (isFoundryIqEnabled()) {
    try {
      const ids = await retrieveContentItemIds(query, limit);
      if (ids.length > 0) return getContentItemsByIds(db, ids);
    } catch (err) {
      console.error('Foundry IQ retrieval failed, falling back to Postgres FTS:', err);
    }
  }
  return getRagItems(db, query, limit);
}

async function searchKnowledgeBase(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') return { error: 'query is required' };
  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;

  const items = await getKnowledgeBaseItems(db, query, limit);
  const results = await Promise.all(items.map(async (item) => ({
    source: item.source,
    title: item.title,
    summary: item.summary,
    // For notes, hand the model the actual note text — including any
    // embedded diagrams/screenshots described via their stored GPT-4V vision
    // analysis — not just the plain-text summary, which silently drops
    // images entirely. Without this, Athena can find that a note like
    // "Supply Chain Demo" exists but has no way to say what its diagram
    // actually shows.
    ...(item.source === 'note' && { content: await buildNoteContentForAI(db, item.body) }),
    // For ica-document items, item.body IS the actual extracted plain-text
    // content of the real file (ICA pre-parses PPTX/XLSX server-side) — not
    // just evidence that a document exists. Without this the model only saw
    // a 300-char summary and had no way to distinguish "I have the real
    // document content" from "I found a repo commit that mentions documents".
    ...(item.source === 'ica-document' && { content: item.body }),
    // For user-upload items, item.body is the extracted plain-text content
    // of the file the user attached in chat (docx/xlsx/pptx/pdf/md) — hand
    // over the real content, not just a truncated summary.
    ...(item.source === 'user-upload' && { content: item.body }),
    publishedAt: item.publishedAt,
    // For PRs/issues/MRs/pipelines/deployments this is when the item was
    // created, not when it was last worked on — metadata.updatedAt (surfaced
    // below as lastActivityAt) is the source's own last-touched timestamp
    // and is what "what's new"/"recent activity" questions should use.
    lastActivityAt: (item.metadata as { updatedAt?: string } | null)?.updatedAt ?? item.publishedAt,
    url: item.url ?? null,
  })));

  return { resultCount: results.length, results };
}

// ── search_knowledge_graph ───────────────────────────────────────────────────

async function searchKnowledgeGraph(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') return { error: 'query is required' };
  const rawLimit = Number(args['limit']);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), AI_TOOL_SEARCH_MAX_LIMIT)
    : AI_TOOL_SEARCH_DEFAULT_LIMIT;

  const seedRows = await db.query<{ id: string; ref_type: string; title: string; tags: string[] }>(
    `SELECT id, ref_type, title, tags FROM nodes WHERE title ILIKE $1 ORDER BY updated_at DESC LIMIT $2`,
    [`%${query}%`, limit],
  );
  if (seedRows.rows.length === 0) {
    return { resultCount: 0, results: [], message: 'No knowledge graph nodes matched that title — try a shorter/broader term.' };
  }

  const seedIds = seedRows.rows.map((r) => r.id);
  const edgeRows = await db.query<{
    source_node_id: string; target_node_id: string; edge_type: string; confidence: string;
  }>(
    `SELECT source_node_id, target_node_id, edge_type, confidence FROM edges
     WHERE source_node_id = ANY($1) OR target_node_id = ANY($1)`,
    [seedIds],
  );

  const neighbourIds = new Set<string>();
  for (const e of edgeRows.rows) {
    neighbourIds.add(e.source_node_id);
    neighbourIds.add(e.target_node_id);
  }

  const neighbourRows = neighbourIds.size > 0
    ? await db.query<{ id: string; ref_type: string; title: string }>(
        `SELECT id, ref_type, title FROM nodes WHERE id = ANY($1)`,
        [Array.from(neighbourIds)],
      )
    : { rows: [] as Array<{ id: string; ref_type: string; title: string }> };
  const neighbourMap = new Map(neighbourRows.rows.map((n) => [n.id, n]));

  const results = seedRows.rows.map((seed) => {
    const connections = edgeRows.rows
      .filter((e) => e.source_node_id === seed.id || e.target_node_id === seed.id)
      .map((e) => {
        const otherId = e.source_node_id === seed.id ? e.target_node_id : e.source_node_id;
        const other = neighbourMap.get(otherId);
        return {
          title: other?.title ?? 'Unknown',
          type: other?.ref_type ?? 'unknown',
          edgeType: e.edge_type,
          confidence: Number(e.confidence),
        };
      });
    return { title: seed.title, type: seed.ref_type, tags: seed.tags, connections };
  });

  return { resultCount: results.length, results };
}

/**
 * Renders a note's raw stored content (the `{ title, contentType, contentJson }`
 * wrapper written by the notes editor) as plain text for the model, replacing
 * each embedded image block with its stored GPT-4V vision analysis so
 * Athena actually knows what a pasted diagram/screenshot shows.
 */
async function buildNoteContentForAI(db: Pool, rawContentJson: string): Promise<string> {
  const { blocks } = parseNoteContent(rawContentJson);
  const imageUrls = extractImageBlockUrls(blocks);

  const visionByBlobId = new Map<string, string>();
  if (imageUrls.length > 0) {
    const ids = imageUrls.map(blobIdFromUrl).filter((id) => id !== '');
    if (ids.length > 0) {
      const result = await db.query<{ id: string; vision_analysis: string }>(
        `SELECT id, vision_analysis FROM kb_images WHERE id = ANY($1)`,
        [ids],
      );
      for (const row of result.rows) {
        if (row.vision_analysis !== '') visionByBlobId.set(row.id, row.vision_analysis);
      }
    }
  }

  const text = blocksToTextWithImages(blocks, visionByBlobId);
  return text.length > NOTE_CONTENT_MAX_CHARS ? `${text.slice(0, NOTE_CONTENT_MAX_CHARS)}…` : text;
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
    // Deep link back into the Plan board — lets chat replies point at the
    // actual task in the app instead of just naming it in plain text.
    url: `${env.FRONTEND_BASE_URL}/plan?taskId=${task.id}`,
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

  // First guard: if an active task with the same title already exists in the
  // same project, reuse it instead of creating a second open copy.
  const openDupe = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks
     WHERE archived = false
       AND status <> 'completed'
       AND project_id = $1
       AND lower(title) = lower($2)
     ORDER BY updated_at DESC
     LIMIT 1`,
    [projectId, title],
  );
  const openDupeRow = openDupe.rows[0];
  if (openDupeRow !== undefined) {
    return { success: true, task: summariseTask(rowToTask(openDupeRow)), duplicate: true };
  }

  // Second guard: catches immediate accidental replays (e.g. duplicate tool
  // call in the same chat turn) even when the first row was completed quickly.
  const recentDupe = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks
     WHERE archived = false
       AND project_id = $1
       AND lower(title) = lower($2)
       AND created_at > now() - interval '5 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId, title],
  );
  const recentDupeRow = recentDupe.rows[0];
  if (recentDupeRow !== undefined) {
    return { success: true, task: summariseTask(rowToTask(recentDupeRow)), duplicate: true };
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

// Common English filler words to strip when tokenizing a matchTitle for fuzzy
// keyword matching — keeps the signal on the words that actually identify
// the task (names, subjects) rather than connective words every title has.
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'and', 'or', 'of', 'with', 'on', 'in', 'at', 'is', 'are',
  'we', 'i', 've', 'have', 'has', 'got', 'please', 'set', 'up', 'set up', 'that', 'this',
  'task', 'organise', 'organize', 'arrange', 'schedule', 'about', 'our', 'the', 'move', 'mark',
]);

function tokenizeTitle(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .map((w) => w.replace(/^'|'s$|'$/g, ''))
      .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w)),
  ));
}

async function resolveTask(
  db: Pool,
  taskId: unknown,
  matchTitle: unknown,
): Promise<
  | { id: string; title: string }
  | { ambiguous: Array<{ id: string; title: string }> }
  | { suggested: { id: string; title: string } }
  | { notFound: true }
  | { error: string }
> {
  if (typeof taskId === 'string' && taskId.trim() !== '') {
    const r = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE id = $1 AND archived = false`,
      [taskId.trim()],
    );
    const row = r.rows[0];
    return row !== undefined ? row : { notFound: true };
  }
  if (typeof matchTitle === 'string' && matchTitle.trim() !== '') {
    const trimmed = matchTitle.trim();
    const r = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE archived = false AND title ILIKE $1 ORDER BY created_at DESC LIMIT 5`,
      [`%${trimmed}%`],
    );
    if (r.rows.length === 1) return r.rows[0] as { id: string; title: string };
    if (r.rows.length > 1) return { ambiguous: r.rows };

    // No literal substring match — fall back to fuzzy keyword-overlap matching
    // so a paraphrase like "organise a meeting with Kyle Thompson" can still
    // find "Speak to Kyle's EA and set up meeting on Project Imagine...".
    const keywords = tokenizeTitle(trimmed);
    if (keywords.length === 0) return { notFound: true };

    const orConditions = keywords.map((_, i) => `title ILIKE $${i + 1}`).join(' OR ');
    const params = keywords.map((kw) => `%${kw}%`);
    const fuzzy = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE archived = false AND (${orConditions}) ORDER BY created_at DESC LIMIT 20`,
      params,
    );
    if (fuzzy.rows.length === 0) return { notFound: true };

    const scored = fuzzy.rows
      .map((row) => {
        const titleLower = row.title.toLowerCase();
        const matched = keywords.filter((kw) => titleLower.includes(kw)).length;
        return { row, score: matched / keywords.length };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best === undefined) return { notFound: true };

    // All keywords present — confident enough to resolve outright.
    if (best.score === 1) return best.row;

    const runnerUp = scored[1];
    // Best candidate matched most keywords and clearly beats the next one —
    // still surface it for confirmation rather than silently updating the
    // wrong task, but as a single suggestion rather than a raw "not found".
    if (best.score >= 0.5 && (runnerUp === undefined || best.score - runnerUp.score >= 0.25)) {
      return { suggested: best.row };
    }

    // Multiple plausible candidates within the same ballpark — let the user pick.
    const topCandidates = scored.filter((s) => s.score >= 0.34).slice(0, 5).map((s) => s.row);
    if (topCandidates.length > 0) return { ambiguous: topCandidates };

    return { notFound: true };
  }
  return { error: 'Provide either taskId or matchTitle' };
}

async function updateTask(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const resolved = await resolveTask(db, args['taskId'], args['matchTitle']);
  if ('error' in resolved) return resolved;
  if ('notFound' in resolved) {
    return {
      error: 'No matching task found — this may be worded very differently from any task title. ' +
        'Ask the user for more detail (a keyword, project, or the exact title) rather than giving up silently.',
    };
  }
  if ('ambiguous' in resolved) {
    return {
      ambiguous: true,
      message: 'Multiple tasks matched — ask the user which one they mean, or re-call with the exact taskId.',
      candidates: resolved.ambiguous,
    };
  }
  if ('suggested' in resolved) {
    return {
      needsConfirmation: true,
      message:
        `Found a likely match — "${resolved.suggested.title}" — but the wording didn't match closely enough ` +
        'to update it automatically. Ask the user to confirm this is the right task before re-calling with ' +
        'its exact taskId.',
      candidate: resolved.suggested,
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
export function textToBlocks(text: string): DraftBlock[] {
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
  return {
    success: true,
    note: {
      id: note.id,
      title,
      contentType,
      // Deep link back into the Think library — same pattern as summariseTask().
      url: `${env.FRONTEND_BASE_URL}/think?noteId=${note.id}`,
    },
  };
}

// ── fetch_web_page ──────────────────────────────────────────────────────────

/** Cap on how much extracted page text we hand to the model. */
const WEB_PAGE_MAX_CHARS = 8_000;
/** Cap on raw bytes read from the response before we give up (avoids huge downloads). */
const WEB_PAGE_MAX_BYTES = 2_000_000;
const WEB_FETCH_TIMEOUT_MS = 10_000;

/**
 * Blocks SSRF-risky targets: non-http(s) schemes, loopback/private/link-local
 * ranges, and other non-routable addresses. Resolves the hostname first so
 * a public DNS name that points at an internal IP is also caught, not just
 * literal IPs in the URL.
 */
async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }

  const { lookup } = await import('node:dns/promises');
  const { isIPv4, isIPv6 } = await import('node:net');

  let address: string;
  try {
    const result = await lookup(parsed.hostname);
    address = result.address;
  } catch {
    throw new Error('Could not resolve host');
  }

  if (isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0;
    if (isPrivate) throw new Error('Refusing to fetch a private/internal address');
  } else if (isIPv6(address)) {
    const normalised = address.toLowerCase();
    if (normalised === '::1' || normalised.startsWith('fc') || normalised.startsWith('fd') || normalised.startsWith('fe80')) {
      throw new Error('Refusing to fetch a private/internal address');
    }
  }

  return parsed;
}

/** Strips scripts/styles/tags from HTML and collapses whitespace into plain readable text. */
function htmlToPlainText(html: string): { title: string | undefined; text: string } {
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.trim();

  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = withoutNoise
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();

  return { title, text };
}

async function fetchWebPage(args: Record<string, unknown>): Promise<unknown> {
  const rawUrl = typeof args['url'] === 'string' ? args['url'].trim() : '';
  if (rawUrl === '') return { error: 'url is required' };

  let url: URL;
  try {
    url = await assertSafeExternalUrl(rawUrl);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid or disallowed URL' };
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'KnowledgeHubBot/1.0 (+athena assistant)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { error: `Fetch failed: ${response.status} ${response.statusText}`, url: url.toString() };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/json|application\/xml|text\/xml/i.test(contentType)) {
      return { error: `Unsupported content type: ${contentType || 'unknown'}`, url: url.toString() };
    }

    // Cap how much we read — some servers ignore range requests, so bound
    // the buffered text instead of trusting content-length.
    const buf = await response.arrayBuffer();
    const bytes = buf.byteLength > WEB_PAGE_MAX_BYTES ? buf.slice(0, WEB_PAGE_MAX_BYTES) : buf;
    const raw = Buffer.from(bytes).toString('utf-8');

    const isHtml = /text\/html/i.test(contentType);
    const { title, text } = isHtml ? htmlToPlainText(raw) : { title: undefined, text: raw.trim() };

    const truncated = text.length > WEB_PAGE_MAX_CHARS;
    return {
      success: true,
      url: url.toString(),
      title: title ?? url.hostname,
      content: truncated ? `${text.slice(0, WEB_PAGE_MAX_CHARS)}…` : text,
      truncated,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Fetch failed', url: url.toString() };
  }
}

// ── search_ica ───────────────────────────────────────────────────────────────

async function searchIca(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') return { error: 'query is required' };

  try {
    const { content, modelUsed } = await icaChat([
      {
        role: 'system',
        content:
          'You are being queried as a retrieval step by another assistant, not talking to the end user ' +
          'directly. Answer the question below using IBM-internal work context you have visibility into. Be ' +
          'factual and concise — state plainly if you have nothing relevant rather than guessing.',
      },
      { role: 'user', content: query },
    ]);
    return { success: true, source: 'ica', modelUsed, content };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'ICA request failed' };
  }
}
