/**
 * Read-only chat tools over the deterministic structured queries (spec 5.5): exact task counts, task lists and
 * content-change lists. They never go through ranked search, accept Europe/London relative periods or explicit
 * UTC ranges, page with an opaque cursor, and report failures as typed errors rather than a count of zero.
 */
import type { Pool } from 'pg';
import type { LlmToolDefinition } from '../foundryClient.js';
import { admitQueries } from '../../services/knowledge/admission.js';
import {
  IntervalError, explicitUtcInterval, parseRelativePhrase, resolveRelativeInterval, type KnowledgeInterval,
} from '../../services/knowledge/intervalResolver.js';
import {
  StructuredQueryError, countTasks, listContentChanges, listTasks, type ChangeFilter, type TaskFilter,
} from '../../services/knowledge/structuredQuery.js';

export const STRUCTURED_TOOL_NAMES: ReadonlySet<string> = new Set(['knowledge_count_tasks', 'knowledge_list_tasks', 'knowledge_list_changes']);

export interface StructuredToolTurn {
  sessionId?: string | undefined;
  strictProjectId?: string | null | undefined;
  signal?: AbortSignal | undefined;
  now?: Date;
}

const INTERVAL_SCHEMA = {
  type: 'object',
  description: 'A time window. Give EITHER period (this week, last week, next week, today, yesterday, tomorrow, this month, last month; resolved in Europe/London) OR start and end (ISO dates or timestamps, UTC; end excluded).',
  properties: {
    period: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
  },
} as const;

const TASK_FILTER_PROPERTIES = {
  projectIds: { type: 'array', items: { type: 'string' }, description: 'Only these project ids.' },
  statuses: { type: 'array', items: { type: 'string' }, description: 'Only these task statuses.' },
  includeArchived: { type: 'boolean', description: 'Include archived tasks (default false).' },
  includeCompleted: { type: 'boolean', description: 'Set false to leave out completed tasks.' },
  overdue: { type: 'boolean', description: 'Only tasks due before today (Europe/London) and not completed.' },
  dueWithin: INTERVAL_SCHEMA,
  updatedWithin: INTERVAL_SCHEMA,
} as const;

const READ_ONLY_NOTE = ' Exact, deterministic and read-only: use it (not search) for all / every / how many / none questions.';

export const STRUCTURED_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'knowledge_count_tasks',
      description: `Returns the exact number of tasks matching a filter.${READ_ONLY_NOTE}`,
      parameters: { type: 'object', properties: TASK_FILTER_PROPERTIES },
    },
  },
  {
    type: 'function',
    function: {
      name: 'knowledge_list_tasks',
      description: `Lists tasks matching a filter, with the exact total. Pass back nextCursor to read the next page; the answer is complete only when hasMore is false.${READ_ONLY_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          ...TASK_FILTER_PROPERTIES,
          limit: { type: 'integer', description: 'Page size (default 50, max 100).' },
          cursor: { type: 'string', description: 'nextCursor from the previous page of the same filter.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'knowledge_list_changes',
      description: `Lists saved records (content items) whose source activity falls in a window, newest first, with the exact total. Pass back nextCursor for the next page.${READ_ONLY_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          within: INTERVAL_SCHEMA,
          projectIds: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' }, description: 'Only these source types.' },
          limit: { type: 'integer' },
          cursor: { type: 'string' },
        },
        required: ['within'],
      },
    },
  },
];

class StructuredInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new StructuredInputError('invalid_filter', `${field} must be a list of strings.`);
  return value as string[];
}

function parseInterval(value: unknown, field: string, now: Date): KnowledgeInterval | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new StructuredInputError('invalid_interval', `${field} must be an object.`);
  const v = value as Record<string, unknown>;
  if (typeof v['period'] === 'string') {
    const kind = parseRelativePhrase(v['period']);
    if (kind === null) throw new StructuredInputError('invalid_interval', `${field}.period "${v['period']}" is not a supported period; use start and end instead.`);
    return resolveRelativeInterval(kind, now);
  }
  if (typeof v['start'] === 'string' && typeof v['end'] === 'string') return explicitUtcInterval(v['start'], v['end']);
  throw new StructuredInputError('invalid_interval', `${field} needs a period, or both start and end.`);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function scopedProjects(requested: string[] | undefined, strict: string | null | undefined): string[] | undefined {
  if (strict === undefined || strict === null || strict === '') return requested;
  return [strict];
}

function buildTaskFilter(args: Record<string, unknown>, turn: StructuredToolTurn, now: Date): TaskFilter {
  const filter: TaskFilter = {};
  const projectIds = scopedProjects(stringArray(args['projectIds'], 'projectIds'), turn.strictProjectId);
  const statuses = stringArray(args['statuses'], 'statuses');
  const dueWithin = parseInterval(args['dueWithin'], 'dueWithin', now);
  const updatedWithin = parseInterval(args['updatedWithin'], 'updatedWithin', now);
  if (projectIds !== undefined) filter.projectIds = projectIds;
  if (statuses !== undefined) filter.statuses = statuses;
  if (optionalBoolean(args['includeArchived']) !== undefined) filter.includeArchived = args['includeArchived'] as boolean;
  if (optionalBoolean(args['includeCompleted']) !== undefined) filter.includeCompleted = args['includeCompleted'] as boolean;
  if (args['overdue'] === true) filter.overdueAsOf = now;
  if (dueWithin !== undefined) filter.dueWithin = dueWithin;
  if (updatedWithin !== undefined) filter.updatedWithin = updatedWithin;
  return filter;
}

function pageArgs(args: Record<string, unknown>): { limit?: number; cursor?: string } {
  return {
    ...(typeof args['limit'] === 'number' && Number.isFinite(args['limit']) ? { limit: args['limit'] } : {}),
    ...(typeof args['cursor'] === 'string' && args['cursor'] !== '' ? { cursor: args['cursor'] } : {}),
  };
}

async function runStructured(db: Pool, name: string, args: Record<string, unknown>, turn: StructuredToolTurn): Promise<Record<string, unknown>> {
  const now = turn.now ?? new Date();
  const q = admitQueries(db as unknown as { query: (...a: never[]) => unknown }, { kind: 'turn', turnId: turn.sessionId ?? 'no-session' }, turn.signal === undefined ? {} : { signal: turn.signal });
  if (name === 'knowledge_count_tasks') {
    const { total, totalExact } = await countTasks(q, buildTaskFilter(args, turn, now));
    return { status: 'ok', total, totalExact };
  }
  if (name === 'knowledge_list_tasks') {
    const page = await listTasks(q, { filter: buildTaskFilter(args, turn, now), ...pageArgs(args) });
    return { status: 'ok', ...page };
  }
  const within = parseInterval(args['within'], 'within', now);
  if (within === undefined) throw new StructuredInputError('invalid_interval', 'within is required.');
  const projectIds = scopedProjects(stringArray(args['projectIds'], 'projectIds'), turn.strictProjectId);
  const sources = stringArray(args['sources'], 'sources');
  const filter: ChangeFilter = { within, ...(projectIds !== undefined ? { projectIds } : {}), ...(sources !== undefined ? { sources } : {}) };
  const page = await listContentChanges(q, { filter, ...pageArgs(args) });
  return { status: 'ok', ...page };
}

/** Runs a structured tool. Input problems and failed queries become typed errors; aborts propagate. */
export async function executeStructuredTool(db: Pool, name: string, args: Record<string, unknown>, turn: StructuredToolTurn = {}): Promise<unknown> {
  try {
    return await runStructured(db, name, args, turn);
  } catch (err) {
    if (err instanceof StructuredInputError) return { status: 'invalid_request', code: err.code, error: err.message };
    if (err instanceof IntervalError) return { status: 'invalid_request', code: 'invalid_interval', error: err.message };
    if (err instanceof StructuredQueryError) return { status: 'invalid_request', code: err.code, error: err.message };
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return { status: 'unavailable', code: 'query_failed', retryable: true, error: 'The query could not be completed, so no count or list is available. Do not report a number.' };
  }
}
