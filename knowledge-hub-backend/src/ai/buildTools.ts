import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import * as store from '../build/buildStore.js';
import { editBuildSpec, type BuildSpecRevision } from '../build/buildSpecService.js';

const MARKDOWN_PAGE_CHARS = 10_000;
const TASK_BODY_PAGE_CHARS = 10_000;
const TASK_PAGE_SIZE = 20;
const EVENT_PAGE_SIZE = 30;
const MAX_TASK_ID_CHARS = 100;

interface BuildSpecRead {
  revision: string;
  snapshot: BuildSpecRevision;
  markdown: string;
  nextOffset: number | null;
}

interface BuildTaskRead {
  updatedAt: string;
  bodyMarkdown: string;
  nextOffset: number | null;
}

export interface BuildTurnState {
  spec?: BuildSpecRead;
  taskReads: Map<string, BuildTaskRead>;
  changed: boolean;
}

export const BUILD_READ_TOOLS = ['read_build_spec', 'read_build_tasks', 'read_build_task', 'read_build_events'] as const;
export const BUILD_WRITE_TOOLS = ['update_build_spec'];
export const BUILD_TOOL_NAMES = new Set<string>([...BUILD_READ_TOOLS, ...BUILD_WRITE_TOOLS]);

export const BUILD_CHAT_TOOLS: LlmToolDefinition[] = [
  { type: 'function', function: {
    name: 'read_build_spec',
    description: 'Read the selected Build spec’s saved settings and complete Markdown in bounded 10,000-character pages. Start at offset 0, then follow nextOffset exactly until null before claiming a complete read or editing. This reads saved data, not unsaved editor changes.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      offset: { type: 'integer', minimum: 0 },
    } },
  } },
  { type: 'function', function: {
    name: 'read_build_tasks',
    description: 'Read the selected Build spec’s task identities, status, agent and dependencies in pages of 20. Follow nextOffset until null for the full task list. Use read_build_task to retrieve an individual task’s full instructions in bounded pages.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      offset: { type: 'integer', minimum: 0 },
    } },
  } },
  { type: 'function', function: {
    name: 'read_build_task',
    description: 'Read the exact saved instructions and state for one task belonging to the selected Build spec. The body is paged in 10,000-character chunks; follow nextOffset until null before claiming a complete read. This tool cannot change task state.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      taskId: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
    }, required: ['taskId'] },
  } },
  { type: 'function', function: {
    name: 'read_build_events',
    description: 'Read the selected Build spec’s actual activity history, newest first, in pages of 30. Follow nextOffset until null for the full retained event history.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      offset: { type: 'integer', minimum: 0 },
    } },
  } },
  { type: 'function', function: {
    name: 'update_build_spec',
    description: 'Save explicitly requested changes to the selected Build spec’s title, Markdown, repository/branch settings, agent concurrency or auto-merge setting. First read every page of the saved spec with read_build_spec. Supply its revision token. Uses the same server validation, editable-status gate, branch lock and atomic saved-content/settings conflict check as the Build editor. Omitted fields stay unchanged. Does not decompose, start, pause, merge, approve, dispatch or otherwise execute a build.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      expectedRevision: { type: 'string' }, title: { type: 'string' }, specMarkdown: { type: 'string' },
      repo: { type: 'string' }, baseBranch: { type: 'string' }, useWorkBranch: { type: 'boolean' },
      maxParallel: { type: 'integer', minimum: 1, maximum: 5 }, autoMerge: { type: 'boolean' },
    }, required: ['expectedRevision'] },
  } },
];

function assertOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError('Use a nonnegative integer offset.');
  }
  return value;
}

function revisionOf(snapshot: BuildSpecRevision): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function toRevision(spec: store.BuildSpec): BuildSpecRevision {
  return {
    title: spec.title, specMarkdown: spec.specMarkdown, repo: spec.repo, baseBranch: spec.baseBranch,
    useWorkBranch: spec.useWorkBranch, status: spec.status, maxParallel: spec.maxParallel, autoMerge: spec.autoMerge,
  };
}

async function selectedSpec(db: Pool, selectedId: string | undefined, access: {
  strictProjectId?: string | null; retrievalFiltered?: boolean; excludedIds?: ReadonlySet<string>;
}): Promise<store.BuildSpec> {
  if (!selectedId) throw new ValidationError('Open a Build spec before using Build tools.');
  if (access.retrievalFiltered) throw new ValidationError('Build tools do not support the enforced collection filter.', { code: 'scope_mismatch' });
  if (access.excludedIds?.has(selectedId)) throw new ValidationError('The selected Build spec is excluded from this conversation.');
  const spec = await store.getSpec(selectedId, db);
  if (!spec) throw new NotFoundError('Build spec');
  if (access.strictProjectId && spec.projectId !== access.strictProjectId) {
    throw new ValidationError('The selected Build spec is outside the enforced workstream scope.');
  }
  return spec;
}

export async function executeBuildTool(db: Pool, name: string, args: Record<string, unknown>, access: {
  selectedSpecId?: string; strictProjectId?: string | null; retrievalFiltered?: boolean; excludedIds?: ReadonlySet<string>;
  readOnly?: boolean;
}, state: BuildTurnState): Promise<unknown> {
  const spec = await selectedSpec(db, access.selectedSpecId, access);
  if (name === 'read_build_spec') {
    const offset = assertOffset(args['offset']);
    const snapshot = toRevision(spec);
    const revision = revisionOf(snapshot);
    if (offset === 0) {
      state.spec = { revision, snapshot, markdown: '', nextOffset: 0 };
    } else if (state.spec?.revision !== revision || state.spec.nextOffset !== offset) {
      throw new ConflictError('The Build spec changed or the requested page is out of order. Restart the read at offset 0.', 'BUILD_SPEC_REVIEW_CONFLICT');
    }
    const page = spec.specMarkdown.slice(offset, offset + MARKDOWN_PAGE_CHARS);
    const nextOffset = offset + page.length < spec.specMarkdown.length ? offset + page.length : null;
    state.spec = { revision, snapshot, markdown: state.spec.markdown + page, nextOffset };
    return {
      specId: spec.id, revision, ...snapshot, offset, markdown: page, nextOffset,
      markdownChars: spec.specMarkdown.length,
      instructions: nextOffset === null
        ? 'This page completes the saved Markdown read. Use the revision token only for this exact selected spec snapshot.'
        : 'This is a partial Markdown read. Continue at nextOffset before claiming completeness or editing.',
    };
  }
  if (name === 'read_build_tasks') {
    const offset = assertOffset(args['offset']);
    const tasks = await store.listTaskPage(spec.id, TASK_PAGE_SIZE, offset, db);
    const total = await store.countTasks(spec.id, db);
    return {
      specId: spec.id, tasks: tasks.map(({ id, seq, title, agent, status, dependsOn, issueNumber, prNumber, updatedAt }) => ({
        id, seq, title, agent, status, dependsOn, issueNumber, prNumber, updatedAt,
      })),
      total, offset, nextOffset: offset + tasks.length < total ? offset + tasks.length : null,
    };
  }
  if (name === 'read_build_task') {
    const taskId = args['taskId'];
    if (typeof taskId !== 'string' || taskId.length > MAX_TASK_ID_CHARS) throw new ValidationError('Provide a task ID from the selected Build spec.');
    const task = await store.getTask(taskId, db);
    if (!task || task.specId !== spec.id) throw new NotFoundError('Build task in selected spec');
    const offset = assertOffset(args['offset']);
    const previous = state.taskReads.get(taskId);
    if (offset === 0) state.taskReads.set(taskId, { updatedAt: task.updatedAt, bodyMarkdown: '', nextOffset: 0 });
    else if (!previous || previous.updatedAt !== task.updatedAt || previous.nextOffset !== offset) {
      throw new ConflictError('This task changed or the requested page is out of order. Restart the read at offset 0.', 'BUILD_TASK_READ_CONFLICT');
    }
    const current = state.taskReads.get(taskId)!;
    const page = task.bodyMarkdown.slice(offset, offset + TASK_BODY_PAGE_CHARS);
    const nextOffset = offset + page.length < task.bodyMarkdown.length ? offset + page.length : null;
    state.taskReads.set(taskId, { updatedAt: task.updatedAt, bodyMarkdown: current.bodyMarkdown + page, nextOffset });
    return {
      id: task.id, specId: task.specId, seq: task.seq, title: task.title, agent: task.agent, status: task.status,
      dependsOn: task.dependsOn, bodyMarkdown: page, offset, totalChars: task.bodyMarkdown.length, nextOffset,
      updatedAt: task.updatedAt, instructions: nextOffset === null ? 'This page completes the saved task instructions.' : 'Continue at nextOffset for the complete task instructions.',
    };
  }
  if (name === 'read_build_events') {
    const offset = assertOffset(args['offset']);
    const events = await store.listEvents(spec.id, EVENT_PAGE_SIZE, db, offset);
    const total = await store.countEvents(spec.id, db);
    return { specId: spec.id, events, total, offset, nextOffset: offset + events.length < total ? offset + events.length : null };
  }
  if (name === 'update_build_spec') {
    if (access.readOnly) throw new ValidationError('This turn is read-only.');
    const read = state.spec;
    if (!read || read.nextOffset !== null || read.revision !== args['expectedRevision'] || read.revision !== revisionOf(toRevision(spec))) {
      throw new ConflictError('Read every page of the current selected Build spec before saving.', 'BUILD_SPEC_REVIEW_CONFLICT');
    }
    const patch = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'expectedRevision'));
    if (patch['specMarkdown'] === undefined) patch['specMarkdown'] = read.snapshot.specMarkdown;
    const saved = await editBuildSpec(spec.id, {
      ...patch,
      expectedSpecMarkdown: read.snapshot.specMarkdown,
      expectedStatus: read.snapshot.status,
    }, { expectedSnapshot: read.snapshot, source: 'athena' }, db);
    state.changed = true;
    const updatedSnapshot = toRevision(saved);
    state.spec = { revision: revisionOf(updatedSnapshot), snapshot: updatedSnapshot,
      markdown: saved.specMarkdown, nextOffset: null };
    return {
      saved: true, specId: saved.id, title: saved.title, revision: state.spec.revision,
      updatedAt: saved.updatedAt, url: `/build?spec=${encodeURIComponent(saved.id)}`,
      instructions: 'The saved Build spec was updated in the normal editor’s data. No task was decomposed, started, approved, merged or dispatched.',
    };
  }
  throw new ValidationError('Unknown Build operation.');
}
