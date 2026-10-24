/* eslint-disable @typescript-eslint/no-magic-numbers -- time, size and ranking constants */
/**
 * Knowledge search (spec 5.4): exact identity/path first, then lexical and
 * semantic candidates fetched in parallel (3s each, abortable), fused with
 * reciprocal rank fusion before the final cap, canonically deduplicated.
 * Backends are injectable; both failing is "unavailable", never an empty hit list.
 */
import { randomUUID } from 'node:crypto';
import { admitQueries, processAdmission, type Admission, type AdmittedQuery } from './admission.js';
import { hashText } from './chunking.js';
import { intervalContains, type KnowledgeInterval } from './intervalResolver.js';

export interface SearchFilter {
  sources?: readonly string[];
  states?: readonly string[];
  parkedOnly?: boolean;
  within?: KnowledgeInterval;
  dateField?: 'published' | 'discovered' | 'updated';
}

export const SEARCH_RRF_K = 60;
export const SEARCH_BACKEND_CANDIDATES = 40;
export const SEARCH_MAX_RESULTS = 20;
export const SEARCH_BACKEND_TIMEOUT_MS = 3000;

export interface SearchRecord {
  id: string;
  source: string;
  sourceId: string;
  title: string;
  summary: string;
  body: string;
  projectContext: string;
  publishedAt: string;
  indexedAt?: string;
  state?: string;
  url: string | null;
  metadata: Record<string, unknown>;
  tags?: string[];
}

export type MatchKind = 'exact' | 'lexical' | 'semantic' | 'both';
export type ExtractionStatus = 'full' | 'partial' | 'metadata_only' | 'failed';
export type SearchIssue = 'lexical_unavailable' | 'semantic_unavailable' | 'semantic_not_configured' | 'exclusion_unavailable';

export interface SearchHit {
  ref: { kind: 'content_item'; id: string };
  readRef: { kind: 'content_item'; id: string; version: string };
  version: string;
  title: string;
  source: string;
  projectId: string;
  snippet: string;
  matchKind: MatchKind;
  extractionStatus: ExtractionStatus;
  score: number;
  duplicates: string[];
  record: SearchRecord;
}

export interface SearchBackends {
  exact(query: string, signal: AbortSignal): Promise<SearchRecord[]>;
  lexical(query: string, limit: number, signal: AbortSignal): Promise<SearchRecord[]>;
  /** Undefined when no semantic provider is configured. */
  semantic?: (query: string, limit: number, signal: AbortSignal) => Promise<SearchRecord[]>;
  /** Returns the subset of ids still visible (not excluded). Throwing fails closed. */
  filterVisible?: (ids: string[]) => Promise<ReadonlySet<string>>;
  browse?: (limit: number, signal: AbortSignal) => Promise<SearchRecord[]>;
}

export interface SearchRequest {
  query: string;
  projectId?: string;
  /** 'prefer' only breaks rank ties; 'only' hides everything outside the project. */
  projectScope?: 'prefer' | 'only';
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  filter?: SearchFilter;
}

export interface SearchDisambiguation { id: string; title: string; projectId: string; path: string }

export interface SearchResult {
  status: 'ok' | 'partial' | 'unavailable';
  hits: SearchHit[];
  issues: SearchIssue[];
  disambiguation?: SearchDisambiguation[];
}

type Guarded<T> = { ok: true; value: T } | { ok: false };

async function guarded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<Guarded<T>> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, ms);
    });
    const value = await Promise.race([run(controller.signal), timeout]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

const meta = (r: SearchRecord, key: string): string => {
  const v = r.metadata[key];
  return typeof v === 'string' ? v : '';
};

/** Identity of the underlying document, so mirrors/syndicated copies collapse. */
export function canonicalKey(r: SearchRecord): string {
  if (r.source === 'note') return `note:${r.sourceId}`;
  const repo = meta(r, 'repo').toLowerCase();
  const path = meta(r, 'path').toLowerCase();
  if ((r.source === 'github-doc' || r.source === 'github-content-store') && repo !== '' && path !== '') return `gh:${repo}/${path}`;
  const syndicated = meta(r, 'syndicatedFrom') || meta(r, 'contentHash');
  if (syndicated !== '') return `hash:${syndicated}`;
  return `id:${r.id}`;
}

export function recordVersion(r: SearchRecord): string {
  return hashText([r.title, r.summary, r.body, r.projectContext, (r.tags ?? []).join(',')].join('\u001f')).slice(0, 16);
}

export function extractionStatusOf(r: SearchRecord): ExtractionStatus {
  const declared = meta(r, 'extractionStatus');
  if (declared === 'full' || declared === 'partial' || declared === 'metadata_only' || declared === 'failed') return declared;
  return r.body.trim() === '' ? 'metadata_only' : 'full';
}

export function queryTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length >= 2))].slice(0, 12);
}

export function makeSnippet(r: SearchRecord, query: string, width = 240): string {
  const text = (r.body.trim() !== '' ? r.body : r.summary).replace(/\s+/g, ' ');
  if (text === '') return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of queryTerms(query)) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(width / 4));
  const slice = text.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${slice}${start + width < text.length ? '…' : ''}`;
}

export function reciprocalRankFusion(lists: string[][], k = SEARCH_RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return scores;
}

const TIE_EPSILON = 1e-12;

export async function searchKnowledge(request: SearchRequest, backends: SearchBackends): Promise<SearchResult> {
  const query = request.query.trim();
  const limit = Math.min(Math.max(1, request.limit ?? SEARCH_MAX_RESULTS), SEARCH_MAX_RESULTS);
  const timeoutMs = request.timeoutMs ?? SEARCH_BACKEND_TIMEOUT_MS;
  if (query === '' && (backends.browse === undefined || request.filter?.sources === undefined)) return { status: 'ok', hits: [], issues: [] };

  const [exact, lexical, semantic] = await Promise.all([
    query === '' ? Promise.resolve<Guarded<SearchRecord[]>>({ ok: true, value: [] }) : guarded(s => backends.exact(query, s), timeoutMs, request.signal),
    guarded(s => query === '' ? backends.browse!(SEARCH_BACKEND_CANDIDATES, s) : backends.lexical(query, SEARCH_BACKEND_CANDIDATES, s), timeoutMs, request.signal),
    backends.semantic === undefined || query === ''
      ? Promise.resolve<Guarded<SearchRecord[]>>({ ok: false })
      : guarded(s => backends.semantic!(query, SEARCH_BACKEND_CANDIDATES, s), timeoutMs, request.signal),
  ]);

  const issues: SearchIssue[] = [];
  if (!lexical.ok) issues.push('lexical_unavailable');
  if (backends.semantic === undefined) issues.push('semantic_not_configured');
  else if (query !== '' && !semantic.ok) issues.push('semantic_unavailable');

  const semanticDown = backends.semantic === undefined || !semantic.ok;
  if (!lexical.ok && semanticDown) return { status: 'unavailable', hits: [], issues };

  const byId = new Map<string, SearchRecord>();
  const take = (list: SearchRecord[]): string[] => list.map(r => { if (!byId.has(r.id)) byId.set(r.id, r); return r.id; });
  const exactIds = exact.ok ? take(exact.value) : [];
  const lexIds = lexical.ok ? take(lexical.value.slice(0, SEARCH_BACKEND_CANDIDATES)) : [];
  const semIds = semantic.ok ? take(semantic.value.slice(0, SEARCH_BACKEND_CANDIDATES)) : [];

  let visible: ReadonlySet<string> | undefined;
  if (backends.filterVisible !== undefined) {
    try { visible = await backends.filterVisible([...byId.keys()]); }
    catch { return { status: 'unavailable', hits: [], issues: [...issues, 'exclusion_unavailable'] }; }
  }
  const allowed = (id: string): boolean => {
    if (visible !== undefined && !visible.has(id)) return false;
    if (!matchesSearchFilter(byId.get(id)!, request.filter)) return false;
    return request.projectScope !== 'only' || request.projectId === undefined || byId.get(id)!.projectContext === request.projectId;
  };

  const fused = reciprocalRankFusion([lexIds.filter(allowed), semIds.filter(allowed)]);
  const lexSet = new Set(lexIds);
  const semSet = new Set(semIds);
  const exactSet = new Set(exactIds.filter(allowed));
  const projectRank = (id: string): number => (request.projectId !== undefined && byId.get(id)!.projectContext === request.projectId ? 0 : 1);

  const ordered = [...new Set([...exactSet, ...fused.keys()])].sort((a, b) => {
    const ea = exactSet.has(a) ? 0 : 1;
    const eb = exactSet.has(b) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const diff = (fused.get(b) ?? 0) - (fused.get(a) ?? 0);
    if (Math.abs(diff) > TIE_EPSILON) return diff;
    return projectRank(a) - projectRank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });

  const hits: SearchHit[] = [];
  const seenKeys = new Map<string, SearchHit>();
  for (const id of ordered) {
    const record = byId.get(id)!;
    const key = canonicalKey(record);
    const existing = seenKeys.get(key);
    if (existing !== undefined) { existing.duplicates.push(id); continue; }
    if (hits.length >= limit) continue;
    const version = recordVersion(record);
    const matchKind: MatchKind = exactSet.has(id) ? 'exact' : lexSet.has(id) && semSet.has(id) ? 'both' : lexSet.has(id) ? 'lexical' : 'semantic';
    const hit: SearchHit = {
      ref: { kind: 'content_item', id }, readRef: { kind: 'content_item', id, version }, version,
      title: record.title, source: record.source, projectId: record.projectContext,
      snippet: makeSnippet(record, query), matchKind, extractionStatus: extractionStatusOf(record),
      score: fused.get(id) ?? 0, duplicates: [], record,
    };
    seenKeys.set(key, hit);
    hits.push(hit);
  }

  const exactTitles = hits.filter(h => h.matchKind === 'exact');
  const sameTitle = exactTitles.filter(h => h.title.toLowerCase() === exactTitles[0]?.title.toLowerCase());
  const disambiguation = sameTitle.length > 1
    ? sameTitle.map(h => ({ id: h.ref.id, title: h.title, projectId: h.projectId, path: meta(h.record, 'path') || meta(h.record, 'filename') }))
    : undefined;

  const degraded = issues.some(i => i === 'lexical_unavailable' || i === 'semantic_unavailable');
  return { status: degraded ? 'partial' : 'ok', hits, issues, ...(disambiguation !== undefined && { disambiguation }) };
}

// ── default Postgres / Foundry IQ backends ──────────────────────────────────

interface Row {
  id: string; source: string; source_id: string; title: string; summary: string; body: string; project_context: string;
  published_at: Date | string; url: string | null; metadata: Record<string, unknown> | null; tags: string[] | null;
  indexed_at?: Date | string; workflow_state?: string;
}

const COLUMNS = `ci.id::text AS id, ci.source, ci.source_id, ci.title, ci.summary, ci.body, ci.project_context,
  ci.published_at, ci.indexed_at, ci.url, ci.metadata, ci.tags`;
const CANONICAL = `NOT EXISTS (
    SELECT 1 FROM note_github_publications publication
    WHERE ci.source IN ('github-doc', 'github-content-store')
      AND lower(publication.repo) = lower(ci.metadata->>'repo') AND publication.path = ci.metadata->>'path')`;
const NOISY_SOURCES = `('github-commit', 'github-pr', 'github-issue', 'github-pipeline', 'github-deployment', 'gitlab-mr', 'gitlab-pipeline')`;

export function toSearchRecord(r: Row): SearchRecord {
  return {
    id: r.id, source: r.source, sourceId: r.source_id, title: r.title, summary: r.summary, body: r.body ?? '',
    projectContext: r.project_context, publishedAt: new Date(r.published_at).toISOString(), url: r.url,
    metadata: r.metadata ?? {}, tags: r.tags ?? [],
    ...(r.indexed_at !== undefined && { indexedAt: new Date(r.indexed_at).toISOString() }),
    ...(r.workflow_state !== undefined && { state: r.workflow_state }),
  };
}

export interface DbBackendOptions {
  db: { query: (...args: never[]) => unknown };
  turnId?: string;
  admission?: Admission;
  /** Foundry IQ style retrieval (ids in rank order). Omit when not configured. */
  retrieveIds?: (query: string, limit: number, signal: AbortSignal) => Promise<string[]>;
  filterVisible?: SearchBackends['filterVisible'];
  filter?: SearchFilter;
  excludedIds?: ReadonlySet<string>;
  strictProjectId?: string | null;
}

export function searchDate(record: SearchRecord, field: SearchFilter['dateField']): string | undefined {
  if (field === 'discovered') return typeof record.metadata['discoveredAt'] === 'string' ? record.metadata['discoveredAt'] : undefined;
  if (field === 'updated') return typeof record.metadata['updatedAt'] === 'string' ? record.metadata['updatedAt'] : record.publishedAt;
  return record.metadata['publicationDateKnown'] === false ? undefined : record.publishedAt;
}

export function matchesSearchFilter(record: SearchRecord, filter?: SearchFilter): boolean {
  if (filter === undefined) return true;
  if (filter.sources !== undefined && !filter.sources.includes(record.source)) return false;
  if (record.source === 'discovered-article' && filter.states !== undefined && !filter.states.includes(record.state ?? '')) return false;
  if (filter.within !== undefined) {
    const date = searchDate(record, filter.dateField);
    if (date === undefined || !intervalContains(filter.within, date)) return false;
  }
  return true;
}

/** Shared by every candidate path, before LIMIT; semantic IDs are revalidated against live rows. */
export function searchFilterSql(filter: SearchFilter | undefined, values: unknown[]): string {
  if (filter === undefined) return 'TRUE';
  const bind = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const conditions: string[] = [];
  if (filter.sources !== undefined) conditions.push(`ci.source = ANY(${bind(filter.sources)}::text[])`);
  if (filter.states !== undefined) conditions.push(`(ci.source <> 'discovered-article' OR ci.workflow_state = ANY(${bind(filter.states)}::text[]))`);
  if (filter.parkedOnly === true) conditions.push('EXISTS (SELECT 1 FROM discover_parking p WHERE p.article_id = ci.id)');
  if (filter.within !== undefined) {
    const column = searchDateSql(filter.dateField);
    if (filter.dateField === undefined || filter.dateField === 'published') conditions.push(`COALESCE(ci.metadata->>'publicationDateKnown', 'true') <> 'false'`);
    conditions.push(`${column} >= ${bind(filter.within.startUtc)}::timestamptz AND ${column} < ${bind(filter.within.endUtc)}::timestamptz`);
  }
  return conditions.join(' AND ') || 'TRUE';
}

function searchDateSql(field: SearchFilter['dateField']): string {
  return field === 'discovered' ? `NULLIF(ci.metadata->>'discoveredAt', '')::timestamptz`
    : field === 'updated' ? `COALESCE(NULLIF(ci.metadata->>'updatedAt', '')::timestamptz, ci.published_at)` : 'ci.published_at';
}

export function createDbSearchBackends(options: DbBackendOptions): SearchBackends {
  const turnId = options.turnId ?? randomUUID();
  const queryFor = (signal: AbortSignal): AdmittedQuery =>
    admitQueries(options.db, { kind: 'turn', turnId }, { signal, admission: options.admission ?? processAdmission });
  const scoped = (values: unknown[]): string => {
    const where = [searchFilterSql(options.filter, values), CANONICAL];
    if (options.excludedIds !== undefined && options.excludedIds.size > 0) {
      values.push([...options.excludedIds]);
      where.push(`NOT (ci.id::text = ANY($${values.length}::text[]) OR ci.source_id = ANY($${values.length}::text[]))`);
    }
    if (options.strictProjectId) { values.push(options.strictProjectId); where.push(`ci.project_context = $${values.length}`); }
    return where.join(' AND ');
  };
  const columns = options.filter?.states !== undefined ? `${COLUMNS}, ci.workflow_state` : COLUMNS;

  const hydrate = async (q: AdmittedQuery, ids: string[]): Promise<SearchRecord[]> => {
    if (ids.length === 0) return [];
    const values: unknown[] = [ids];
    const where = scoped(values);
    const { rows } = await q.query<Row>(
      `SELECT ${columns} FROM content_items ci WHERE ci.id::text = ANY($1::text[]) AND ${where}`, values);
    const byId = new Map(rows.map(r => [r.id, toSearchRecord(r)]));
    return ids.flatMap(id => byId.get(id) ?? []);
  };

  const backends: SearchBackends = {
    async exact(query, signal) {
      const values: unknown[] = [query];
      const where = scoped(values);
      const { rows } = await queryFor(signal).query<Row>(
        `SELECT ${columns} FROM content_items ci
          WHERE ${where} AND (ci.id::text = $1 OR lower(ci.title) = lower($1) OR lower(ci.source_id) = lower($1)
             OR lower(ci.metadata->>'path') = lower($1) OR lower(ci.metadata->>'filename') = lower($1)
             OR right(lower(ci.metadata->>'path'), length($1) + 1) = '/' || lower($1))
          ORDER BY ci.published_at DESC LIMIT 10`, values);
      return rows.map(toSearchRecord);
    },
    async lexical(query, limit, signal) {
      const terms = queryTerms(query);
      if (terms.length === 0) return [];
      const values: unknown[] = [terms.join(' | '), terms.join(' '), limit];
      const where = scoped(values);
      const { rows } = await queryFor(signal).query<Row>(
        `SELECT ${columns} FROM content_items ci, to_tsquery('english', $1) any_q, plainto_tsquery('english', $2) all_q
          WHERE ci.search_vector @@ any_q AND ${where}
          ORDER BY ts_rank_cd(ci.search_vector, any_q)
                   * CASE WHEN ci.search_vector @@ all_q THEN 2 ELSE 1 END
                   * CASE WHEN ci.source IN ${NOISY_SOURCES} THEN 0.5 ELSE 1 END DESC, ci.id::text
          LIMIT $3`, values);
      return rows.map(toSearchRecord);
    },
    async browse(limit, signal) {
      const values: unknown[] = [limit];
      const where = scoped(values);
      const { rows } = await queryFor(signal).query<Row>(
        `SELECT ${columns} FROM content_items ci WHERE ${where}
         ORDER BY ${searchDateSql(options.filter?.dateField)} DESC NULLS LAST, ci.id LIMIT $1`, values);
      return rows.map(toSearchRecord);
    },
  };
  if (options.retrieveIds !== undefined) {
    const retrieve = options.retrieveIds;
    backends.semantic = async (query, limit, signal): Promise<SearchRecord[]> => hydrate(queryFor(signal), await retrieve(query, limit, signal));
  }
  if (options.filterVisible !== undefined) backends.filterVisible = options.filterVisible;
  return backends;
}
