import { getDb } from '../db/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import type { Pool } from 'pg';
import * as store from './buildStore.js';
import type { BuildSpec, BuildSpecWithTasks } from './buildStore.js';

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_SPEC_CHARS = 60_000;
const MAX_TITLE_CHARS = 200;
const DEFAULT_MAX_FIELD_CHARS = 500;
const MAX_PARALLEL_LIMIT = 5;
const EDITABLE_SPEC_STATUSES: readonly store.SpecStatus[] = ['draft', 'decomposed', 'paused', 'failed', 'done'];

export type BuildSpecRevision = Pick<BuildSpec,
  'title' | 'specMarkdown' | 'repo' | 'baseBranch' | 'useWorkBranch' | 'status' | 'maxParallel' | 'autoMerge'>;

function str(v: unknown, field: string, { required = false, max = DEFAULT_MAX_FIELD_CHARS } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new ValidationError(`${field} is required`, { [field]: 'required' });
    return undefined;
  }
  if (typeof v !== 'string') throw new ValidationError(`${field} must be a string`, { [field]: 'must be a string' });
  const value = v.trim();
  if (required && value === '') throw new ValidationError(`${field} is required`, { [field]: 'required' });
  if (value.length > max) throw new ValidationError(`${field} is too long`, { [field]: `max ${max.toString()} characters` });
  return value;
}

function repoOf(v: unknown): string | undefined {
  const repo = str(v, 'repo', { max: 200 });
  if (repo !== undefined && !REPO_RE.test(repo)) throw new ValidationError('repo must be owner/name', { repo: 'expected owner/name' });
  return repo;
}

function branchOf(v: unknown): string | undefined {
  const branch = str(v, 'baseBranch', { max: 200 });
  if (branch !== undefined && branch !== '' && !BRANCH_RE.test(branch)) {
    throw new ValidationError('Invalid branch name', { baseBranch: 'invalid' });
  }
  return branch === '' ? undefined : branch;
}

function maxParallelOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_PARALLEL_LIMIT) {
    throw new ValidationError('maxParallel must be 1–5', { maxParallel: '1–5' });
  }
  return v;
}

function boolOf(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`${field} must be true or false`, { [field]: 'boolean' });
  return v;
}

function sameRevision(a: BuildSpecRevision, b: BuildSpecRevision): boolean {
  return a.title === b.title && a.specMarkdown === b.specMarkdown && a.repo === b.repo
    && a.baseBranch === b.baseBranch && a.useWorkBranch === b.useWorkBranch
    && a.status === b.status && a.maxParallel === b.maxParallel && a.autoMerge === b.autoMerge;
}

export async function editBuildSpec(
  id: string,
  input: Record<string, unknown>,
  options: { expectedSnapshot?: BuildSpecRevision; source?: 'athena' } = {},
  db: Pool = getDb(),
): Promise<BuildSpecWithTasks> {
  const spec = await store.getSpec(id, db);
  if (spec === null) throw new NotFoundError('Build spec');
  if (!EDITABLE_SPEC_STATUSES.includes(spec.status)) {
    throw new ConflictError(`Can't edit a spec that is ${spec.status}`, 'BUILD_SPEC_STATUS', { status: spec.status });
  }
  if (options.expectedSnapshot !== undefined && !sameRevision(options.expectedSnapshot, spec)) {
    throw new ConflictError('The spec changed since Athena read it. Read the current spec before saving.', 'BUILD_SPEC_REVIEW_CONFLICT');
  }

  const patch: Partial<BuildSpec> = {};
  const title = str(input['title'], 'title', { max: MAX_TITLE_CHARS });
  if (title !== undefined) {
    if (title === '') throw new ValidationError('title is required', { title: 'required' });
    patch.title = title;
  }
  const markdown = str(input['specMarkdown'], 'specMarkdown', { max: MAX_SPEC_CHARS });
  if (markdown !== undefined) patch.specMarkdown = markdown;
  const expectedMarkdown = input['expectedSpecMarkdown'];
  if (expectedMarkdown !== undefined
    && (typeof expectedMarkdown !== 'string' || expectedMarkdown.length > MAX_SPEC_CHARS || markdown === undefined)) {
    throw new ValidationError('A reviewed spec needs its original Markdown and a replacement.');
  }
  const expectedStatus = input['expectedStatus'];
  if (expectedStatus !== undefined && (typeof expectedStatus !== 'string' || expectedStatus !== spec.status)) {
    throw new ConflictError('The build status changed since Athena read this spec. Read it again before saving.', 'BUILD_SPEC_REVIEW_CONFLICT');
  }
  const repo = repoOf(input['repo']);
  if (repo !== undefined) patch.repo = repo;
  const branch = branchOf(input['baseBranch']);
  if (branch !== undefined) patch.baseBranch = branch;
  const useWorkBranch = boolOf(input['useWorkBranch'], 'useWorkBranch');
  if (useWorkBranch !== undefined) patch.useWorkBranch = useWorkBranch;
  const lockedByWorkBranch = spec.workBranch !== null && (
    (patch.repo !== undefined && patch.repo !== spec.repo)
    || (patch.baseBranch !== undefined && patch.baseBranch !== spec.baseBranch)
    || (patch.useWorkBranch !== undefined && patch.useWorkBranch !== spec.useWorkBranch));
  if (lockedByWorkBranch) {
    throw new ConflictError(`The build already works on ${spec.workBranch ?? ''} — repo and branches can't change now`,
      'BUILD_SPEC_BRANCH_LOCKED', { workBranch: spec.workBranch ?? '' });
  }
  const maxParallel = maxParallelOf(input['maxParallel']);
  if (maxParallel !== undefined) patch.maxParallel = maxParallel;
  const autoMerge = boolOf(input['autoMerge'], 'autoMerge');
  if (autoMerge !== undefined) patch.autoMerge = autoMerge;
  if ('projectId' in input) patch.projectId = str(input['projectId'], 'projectId', { max: 100 }) || null;

  const updated = await store.updateSpec(spec.id, patch, db,
    typeof expectedMarkdown === 'string'
      ? { markdown: expectedMarkdown, status: spec.status, ...(options.expectedSnapshot !== undefined && { fields: options.expectedSnapshot }) }
      : undefined);
  if (updated === null && expectedMarkdown !== undefined) {
    throw new ConflictError('The saved spec or build status changed. Your draft is retained; reload and review the current source before saving.', 'BUILD_SPEC_REVIEW_CONFLICT');
  }
  if (updated === null) throw new NotFoundError('Build spec');
  if (options.source === 'athena') {
    await store.addEvent(spec.id, null, 'spec-updated', 'Spec and settings updated by Athena', {}, db);
  }
  const saved = await store.getSpecWithTasks(spec.id, db);
  if (saved === null) throw new NotFoundError('Build spec');
  return saved;
}
