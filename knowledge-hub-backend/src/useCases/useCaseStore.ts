/**
 * useCases/useCaseStore.ts
 * Use cases (migration 081): one idea for one product, tracked from its sources to a
 * spec note, a handoff and the PRs that shipped it. Validation lives here so the
 * routes stay thin and the rules are unit-testable.
 */
import type { Pool } from 'pg';
import { ValidationError, NotFoundError } from '../types/errors.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import { parseNoteContent } from '../utils/noteContent.js';

export const USE_CASE_STAGES = ['candidate', 'refining', 'spec_ready', 'handed_off', 'shipped', 'dropped'] as const;
export type UseCaseStage = typeof USE_CASE_STAGES[number];
export const PRODUCT_KINDS = ['imagine_demo', 'imagine_platform', 'product'] as const;
export type ProductKind = typeof PRODUCT_KINDS[number];
export const SOURCE_TYPES = ['discover', 'spark', 'note', 'canvas'] as const;
export type UseCaseSourceType = typeof SOURCE_TYPES[number];

export const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;
const MAX_SOURCES_PER_REQUEST = 20;
const MAX_LINK_TITLE = 200;
const MAX_URL = 1000;
const SOURCE_TITLE_CHARS = 160;
const LIST_LIMIT = 500;

export interface UseCaseSource { sourceType: UseCaseSourceType; sourceId: string; title: string; url: string | null; addedAt: string }
export interface UseCaseLink { id: string; url: string; title: string; addedAt: string }
export interface UseCase {
  id: string;
  title: string;
  summary: string;
  productKind: ProductKind;
  projectId: string | null;
  projectName: string | null;
  repo: string | null;
  stage: UseCaseStage;
  specNoteId: string | null;
  buildSpecId: string | null;
  handoffRepo: string | null;
  handoffPath: string | null;
  handoffUrl: string | null;
  sourceCount: number;
  linkCount: number;
  createdAt: string;
  updatedAt: string;
  stageChangedAt: string;
}
export interface UseCaseDetail extends UseCase { sources: UseCaseSource[]; links: UseCaseLink[] }

export interface SourceRef { sourceType: UseCaseSourceType; sourceId: string }

// ── Validators (pure) ────────────────────────────────────────────────────────

function text(v: unknown, field: string, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new ValidationError(`${field} is required`, { [field]: 'required' });
    return undefined;
  }
  if (typeof v !== 'string') throw new ValidationError(`${field} must be text`, { [field]: 'must be text' });
  const t = v.trim();
  if (required && t === '') throw new ValidationError(`${field} is required`, { [field]: 'required' });
  if (t.length > max) throw new ValidationError(`${field} is too long`, { [field]: `max ${max.toString()} characters` });
  return t;
}

export function parseStage(v: unknown): UseCaseStage {
  if (typeof v !== 'string' || !(USE_CASE_STAGES as readonly string[]).includes(v)) {
    throw new ValidationError('stage is not valid', { stage: USE_CASE_STAGES.join(', ') });
  }
  return v as UseCaseStage;
}

export function parseProductKind(v: unknown): ProductKind {
  if (typeof v !== 'string' || !(PRODUCT_KINDS as readonly string[]).includes(v)) {
    throw new ValidationError('productKind is not valid', { productKind: PRODUCT_KINDS.join(', ') });
  }
  return v as ProductKind;
}

/** Repo as owner/name, or null for an empty value. */
export function parseRepo(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const r = text(v, 'repo', 200, false) ?? '';
  if (r === '') return null;
  if (!REPO_RE.test(r)) throw new ValidationError('repo must be owner/name', { repo: 'expected owner/name' });
  return r;
}

export function parseSourceRef(v: unknown): SourceRef {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const sourceType = o['sourceType'];
  if (typeof sourceType !== 'string' || !(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    throw new ValidationError('sourceType is not valid', { sourceType: SOURCE_TYPES.join(', ') });
  }
  const sourceId = text(o['sourceId'], 'sourceId', 100, true) as string;
  return { sourceType: sourceType as UseCaseSourceType, sourceId };
}

export function parseLinkUrl(v: unknown): string {
  const url = text(v, 'url', MAX_URL, true) as string;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ValidationError('url is not valid', { url: 'invalid' }); }
  if (parsed.protocol !== 'https:') throw new ValidationError('url must start with https://', { url: 'https only' });
  return parsed.toString();
}

/** A short title for a link: "owner/repo#123" for GitHub PRs and issues, otherwise the host and path. */
export function defaultLinkTitle(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)/.exec(url);
  if (m !== null) return `${m[1]!}#${m[3]!}`;
  const u = new URL(url);
  return `${u.host}${u.pathname}`.replace(/\/$/, '').slice(0, MAX_LINK_TITLE);
}

export interface UseCaseCreate {
  title: string; summary: string; productKind: ProductKind; projectId: string | null; repo: string | null; sources: SourceRef[];
}

export function parseCreate(b: Record<string, unknown>): UseCaseCreate {
  const title = text(b['title'], 'title', MAX_TITLE, true) as string;
  const summary = text(b['summary'], 'summary', MAX_SUMMARY, false) ?? '';
  const productKind = parseProductKind(b['productKind']);
  const projectId = (text(b['projectId'], 'projectId', 100, false) ?? '') || null;
  const repo = parseRepo(b['repo']) ?? null;
  if (productKind === 'product' && projectId === null && repo === null) {
    throw new ValidationError('Choose a project or a repo for this product', { projectId: 'project or repo required' });
  }
  const raw = b['sources'];
  if (raw !== undefined && !Array.isArray(raw)) throw new ValidationError('sources must be a list', { sources: 'list' });
  const list = (raw ?? []) as unknown[];
  if (list.length > MAX_SOURCES_PER_REQUEST) throw new ValidationError('Too many sources', { sources: `max ${MAX_SOURCES_PER_REQUEST.toString()}` });
  return { title, summary, productKind, projectId, repo, sources: list.map(parseSourceRef) };
}

export interface UseCasePatch {
  title?: string; summary?: string; productKind?: ProductKind; projectId?: string | null; repo?: string | null; stage?: UseCaseStage;
}

export function parsePatch(b: Record<string, unknown>): UseCasePatch {
  const patch: UseCasePatch = {};
  if (b['title'] !== undefined) patch.title = text(b['title'], 'title', MAX_TITLE, true) as string;
  if (b['summary'] !== undefined) patch.summary = text(b['summary'], 'summary', MAX_SUMMARY, false) ?? '';
  if (b['productKind'] !== undefined) patch.productKind = parseProductKind(b['productKind']);
  if (b['projectId'] !== undefined) patch.projectId = (text(b['projectId'], 'projectId', 100, false) ?? '') || null;
  if (b['repo'] !== undefined) patch.repo = parseRepo(b['repo']) ?? null;
  if (b['stage'] !== undefined) patch.stage = parseStage(b['stage']);
  if (Object.keys(patch).length === 0) throw new ValidationError('Nothing to update', {});
  return patch;
}

export function slugify(title: string): string {
  const s = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s === '' ? 'use-case' : s;
}

// ── Queries ──────────────────────────────────────────────────────────────────

const SELECT = `
  SELECT u.id, u.title, u.summary, u.product_kind, u.project_id, p.name AS project_name, u.repo, u.stage,
         u.spec_note_id, u.build_spec_id, u.handoff_repo, u.handoff_path, u.handoff_url,
         u.created_at, u.updated_at, u.stage_changed_at,
         (SELECT COUNT(*)::int FROM use_case_sources s WHERE s.use_case_id = u.id) AS source_count,
         (SELECT COUNT(*)::int FROM use_case_links l WHERE l.use_case_id = u.id) AS link_count
    FROM use_cases u
    LEFT JOIN projects p ON p.id = u.project_id`;

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toUseCase(r: Row): UseCase {
  return {
    id: String(r['id']),
    title: String(r['title']),
    summary: String(r['summary'] ?? ''),
    productKind: r['product_kind'] as ProductKind,
    projectId: strOrNull(r['project_id']),
    projectName: strOrNull(r['project_name']),
    repo: strOrNull(r['repo']),
    stage: r['stage'] as UseCaseStage,
    specNoteId: strOrNull(r['spec_note_id']),
    buildSpecId: strOrNull(r['build_spec_id']),
    handoffRepo: strOrNull(r['handoff_repo']),
    handoffPath: strOrNull(r['handoff_path']),
    handoffUrl: strOrNull(r['handoff_url']),
    sourceCount: Number(r['source_count'] ?? 0),
    linkCount: Number(r['link_count'] ?? 0),
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
    stageChangedAt: iso(r['stage_changed_at']),
  };
}

async function assertProjectExists(db: Pool, projectId: string | null | undefined): Promise<void> {
  if (projectId === null || projectId === undefined) return;
  const { rows } = await db.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (rows.length === 0) throw new ValidationError('Project not found', { projectId: 'unknown project' });
}

export async function listUseCases(db: Pool, filter: { productKind?: ProductKind; stage?: UseCaseStage } = {}): Promise<UseCase[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.productKind !== undefined) { params.push(filter.productKind); where.push(`u.product_kind = $${params.length.toString()}`); }
  if (filter.stage !== undefined) { params.push(filter.stage); where.push(`u.stage = $${params.length.toString()}`); }
  const { rows } = await db.query(
    `${SELECT}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY u.updated_at DESC LIMIT ${LIST_LIMIT.toString()}`, params);
  return (rows as Row[]).map(toUseCase);
}

export async function getUseCase(db: Pool, id: string): Promise<UseCaseDetail> {
  const { rows } = await db.query(`${SELECT} WHERE u.id::text = $1`, [id]);
  const row = (rows as Row[])[0];
  if (row === undefined) throw new NotFoundError('Use case');
  const [sources, links] = await Promise.all([
    db.query('SELECT source_type, source_id, title, url, added_at FROM use_case_sources WHERE use_case_id::text = $1 ORDER BY added_at, source_type, source_id', [id]),
    db.query('SELECT id, url, title, added_at FROM use_case_links WHERE use_case_id::text = $1 ORDER BY added_at, url', [id]),
  ]);
  return {
    ...toUseCase(row),
    sources: (sources.rows as Row[]).map((s) => ({
      sourceType: s['source_type'] as UseCaseSourceType, sourceId: String(s['source_id']), title: String(s['title'] ?? ''),
      url: strOrNull(s['url']), addedAt: iso(s['added_at']),
    })),
    links: (links.rows as Row[]).map((l) => ({ id: String(l['id']), url: String(l['url']), title: String(l['title'] ?? ''), addedAt: iso(l['added_at']) })),
  };
}

const firstLine = (t: string): string => (t.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^#+\s*/, '').trim();
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** The note's own title, else its first line of text. */
export async function noteTitle(db: Pool, content: string): Promise<string> {
  const own = parseNoteContent(content).title?.trim() ?? '';
  if (own !== '' && own !== 'Untitled') return own;
  return firstLine(await renderNoteAsText(db, content)) || 'Untitled note';
}

/** Looks the source up (it must exist) and returns a title and URL to store with it. */
export async function resolveSource(db: Pool, ref: SourceRef): Promise<{ title: string; url: string | null }> {
  const missing = (): never => { throw new NotFoundError(`Source ${ref.sourceType} ${ref.sourceId}`); };
  switch (ref.sourceType) {
    case 'discover': {
      const { rows } = await db.query('SELECT title, url FROM content_items WHERE id::text = $1', [ref.sourceId]);
      const r = (rows as Row[])[0] ?? missing();
      return { title: clip(String(r['title'] ?? 'Discover item'), SOURCE_TITLE_CHARS), url: strOrNull(r['url']) };
    }
    case 'spark': {
      const { rows } = await db.query('SELECT body FROM sparks WHERE id::text = $1', [ref.sourceId]);
      const r = (rows as Row[])[0] ?? missing();
      return { title: clip(firstLine(String(r['body'] ?? '')) || 'Spark', SOURCE_TITLE_CHARS), url: null };
    }
    case 'note': {
      const { rows } = await db.query(`SELECT content FROM notes WHERE id::text = $1 AND status = 'active'`, [ref.sourceId]);
      const r = (rows as Row[])[0] ?? missing();
      return { title: clip(await noteTitle(db, String(r['content'] ?? '')), SOURCE_TITLE_CHARS), url: null };
    }
    case 'canvas': {
      const { rows } = await db.query('SELECT title FROM canvases WHERE id::text = $1 AND deleted_at IS NULL', [ref.sourceId]);
      const r = (rows as Row[])[0] ?? missing();
      return { title: clip(String(r['title'] ?? 'Canvas'), SOURCE_TITLE_CHARS), url: null };
    }
  }
}

async function touch(db: Pool, id: string): Promise<void> {
  await db.query('UPDATE use_cases SET updated_at = NOW() WHERE id::text = $1', [id]);
}

export async function addSources(db: Pool, useCaseId: string, refs: SourceRef[]): Promise<UseCaseDetail> {
  await getUseCase(db, useCaseId);
  const resolved = [];
  for (const ref of refs) resolved.push({ ref, ...(await resolveSource(db, ref)) });
  for (const { ref, title, url } of resolved) {
    await db.query(
      `INSERT INTO use_case_sources (use_case_id, source_type, source_id, title, url) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (use_case_id, source_type, source_id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url`,
      [useCaseId, ref.sourceType, ref.sourceId, title, url]);
  }
  await touch(db, useCaseId);
  return getUseCase(db, useCaseId);
}

export async function createUseCase(db: Pool, input: UseCaseCreate): Promise<UseCaseDetail> {
  await assertProjectExists(db, input.projectId);
  // Resolve every source before writing anything, so a bad source leaves no half-created use case.
  for (const ref of input.sources) await resolveSource(db, ref);
  const { rows } = await db.query(
    'INSERT INTO use_cases (title, summary, product_kind, project_id, repo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [input.title, input.summary, input.productKind, input.projectId, input.repo]);
  const id = String((rows as Row[])[0]!['id']);
  if (input.sources.length > 0) return addSources(db, id, input.sources);
  return getUseCase(db, id);
}

export async function updateUseCase(db: Pool, id: string, patch: UseCasePatch): Promise<UseCaseDetail> {
  const current = await getUseCase(db, id);
  await assertProjectExists(db, patch.projectId);
  const kind = patch.productKind ?? current.productKind;
  const projectId = patch.projectId !== undefined ? patch.projectId : current.projectId;
  const repo = patch.repo !== undefined ? patch.repo : current.repo;
  if (kind === 'product' && projectId === null && repo === null) {
    throw new ValidationError('Choose a project or a repo for this product', { projectId: 'project or repo required' });
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, v: unknown): void => { params.push(v); sets.push(`${col} = $${params.length.toString()}`); };
  if (patch.title !== undefined) set('title', patch.title);
  if (patch.summary !== undefined) set('summary', patch.summary);
  if (patch.productKind !== undefined) set('product_kind', patch.productKind);
  if (patch.projectId !== undefined) set('project_id', patch.projectId);
  if (patch.repo !== undefined) set('repo', patch.repo);
  if (patch.stage !== undefined && patch.stage !== current.stage) { set('stage', patch.stage); sets.push('stage_changed_at = NOW()'); }
  sets.push('updated_at = NOW()');
  params.push(id);
  await db.query(`UPDATE use_cases SET ${sets.join(', ')} WHERE id::text = $${params.length.toString()}`, params);
  return getUseCase(db, id);
}

/** Internal updates made by actions (draft spec, handoff). */
export async function recordAction(db: Pool, id: string, fields: {
  stage?: UseCaseStage; specNoteId?: string; buildSpecId?: string; handoffRepo?: string; handoffPath?: string; handoffUrl?: string | null;
}): Promise<UseCaseDetail> {
  const current = await getUseCase(db, id);
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  const set = (col: string, v: unknown): void => { params.push(v); sets.push(`${col} = $${params.length.toString()}`); };
  if (fields.stage !== undefined && fields.stage !== current.stage) { set('stage', fields.stage); sets.push('stage_changed_at = NOW()'); }
  if (fields.specNoteId !== undefined) set('spec_note_id', fields.specNoteId);
  if (fields.buildSpecId !== undefined) set('build_spec_id', fields.buildSpecId);
  if (fields.handoffRepo !== undefined) set('handoff_repo', fields.handoffRepo);
  if (fields.handoffPath !== undefined) set('handoff_path', fields.handoffPath);
  if (fields.handoffUrl !== undefined) set('handoff_url', fields.handoffUrl);
  params.push(id);
  await db.query(`UPDATE use_cases SET ${sets.join(', ')} WHERE id::text = $${params.length.toString()}`, params);
  return getUseCase(db, id);
}

export async function deleteUseCase(db: Pool, id: string): Promise<void> {
  const { rowCount } = await db.query('DELETE FROM use_cases WHERE id::text = $1', [id]);
  if (rowCount === 0) throw new NotFoundError('Use case');
}

export async function removeSource(db: Pool, id: string, ref: SourceRef): Promise<UseCaseDetail> {
  await getUseCase(db, id);
  await db.query('DELETE FROM use_case_sources WHERE use_case_id::text = $1 AND source_type = $2 AND source_id = $3', [id, ref.sourceType, ref.sourceId]);
  await touch(db, id);
  return getUseCase(db, id);
}

export async function addLink(db: Pool, id: string, b: Record<string, unknown>): Promise<UseCaseDetail> {
  await getUseCase(db, id);
  const url = parseLinkUrl(b['url']);
  const title = text(b['title'], 'title', MAX_LINK_TITLE, false) || defaultLinkTitle(url);
  await db.query(
    `INSERT INTO use_case_links (use_case_id, url, title) VALUES ($1, $2, $3)
     ON CONFLICT (use_case_id, url) DO UPDATE SET title = EXCLUDED.title`, [id, url, title]);
  await touch(db, id);
  return getUseCase(db, id);
}

export async function removeLink(db: Pool, id: string, linkId: string): Promise<UseCaseDetail> {
  await getUseCase(db, id);
  await db.query('DELETE FROM use_case_links WHERE use_case_id::text = $1 AND id::text = $2', [id, linkId]);
  await touch(db, id);
  return getUseCase(db, id);
}

/** Use cases still being shaped (refining / spec ready) with no update for `days` days. */
export async function countStalled(db: Pool, days = 14): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM use_cases WHERE stage IN ('refining', 'spec_ready') AND updated_at < NOW() - make_interval(days => $1::int)`, [days]);
  return Number((rows as Row[])[0]?.['n'] ?? 0);
}
