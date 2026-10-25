/**
 * health/knowledgeHealth.ts — bounded, read-only aggregates for the Knowledge health page.
 * Each section fails independently so one unavailable table never hides the rest. Nothing here reads
 * prompts, message content, session ids or error text, and nothing calls a model or a provider.
 */
import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import { CONTENT_SOURCE_DISPOSITIONS, KNOWLEDGE_FAMILIES, type Availability } from '../ai/knowledge/manifest.js';

export const HEALTH_MAX_DAYS = 90;
export const HEALTH_DEFAULT_DAYS = 7;
const USAGE_ROW_LIMIT = 50;
const FACET_LIMIT = 100;
const RUN_LIMIT = 10;
const SOURCE_LIMIT = 50;
const DAY_MS = 86_400_000;
const DATE_LENGTH = 10;
const MAX_FILTER_LENGTH = 120;
const WINDOW_PARAM_COUNT = 3;
const ENVIRONMENTS = ['prod', 'dev'] as const;
export type HealthEnvironment = (typeof ENVIRONMENTS)[number];

export interface HealthQuery {
  from?: string | undefined;
  to?: string | undefined;
  environment?: string | undefined;
  feature?: string | undefined;
  persona?: string | undefined;
  deployment?: string | undefined;
}

export interface HealthFilters {
  from: string;
  to: string;
  environment: HealthEnvironment;
  feature: string | null;
  persona: string | null;
  deployment: string | null;
}

export type Section<T> = { available: true; data: T } | { available: false; message: string };

export interface UsageTotals {
  calls: number;
  failures: number;
  measuredCalls: number;
  unmeasuredCalls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningCompletionTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
}
export interface UsageRow extends UsageTotals {
  feature: string;
  persona: string | null;
  deployment: string;
}
export interface UsageSection {
  totals: UsageTotals;
  rows: UsageRow[];
  rowsTruncated: boolean;
  facets: { features: string[]; personas: string[]; deployments: string[] };
  firstRecordedAt: string | null;
}
export interface SyncRunSummary {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  sources: Array<{ source: string; indexed: number; errors: number }>;
}
export interface JobClaimSummary { job: string; period: string; status: string; startedAt: string; finishedAt: string | null }
export interface IndexSection {
  sources: Array<{ source: string; items: number; lastIndexedAt: string | null }>;
  scoring: { discoveredArticles: number; unscored: number };
}
/** A count that is `null` when it cannot be measured; null is never shown as zero. */
export type MeasuredCount = number | null;
export type FamilyState =
  | 'up-to-date' | 'partial' | 'unsupported-extraction' | 'not-configured' | 'temporarily-unavailable' | 'excluded';
export type ErrorCategory = 'sync-errors' | 'sync-run-failed';
export interface ExtractionDistribution { fullText: number; metadataOnly: number; atIngestionCap: number }
export interface FamilyHealth {
  kind: string;
  availability: Availability;
  state: FamilyState;
  capabilities: readonly string[];
  entryPoint: string;
  reason: string;
  sources: string[];
  counts: { eligible: MeasuredCount; indexed: MeasuredCount; pending: MeasuredCount; failed: MeasuredCount };
  extraction: ExtractionDistribution | null;
  lastIndexedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  errorCategories: ErrorCategory[];
}
export type SemanticState = 'not-configured' | 'coverage-not-measured' | 'pending-work' | 'temporarily-unavailable' | 'up-to-date';
export interface IndexingWork { measured: boolean; pending: MeasuredCount; failed: MeasuredCount; done: MeasuredCount }
export interface SemanticStatus { state: SemanticState; providerConfigured: boolean; message: string; work: IndexingWork }
export interface FamiliesSection {
  families: FamilyHealth[];
  semantic: SemanticStatus;
  orchestrationEnabled: boolean;
  decisionTablesMeasured: boolean;
  lastSuccessfulSyncAt: string | null;
}
export interface KnowledgeHealthOptions { semanticConfigured?: boolean; orchestrationEnabled?: boolean }
export interface KnowledgeHealth {
  generatedAt: string;
  filters: HealthFilters;
  windowStart: string;
  windowEnd: string;
  usage: Section<UsageSection>;
  syncRuns: Section<{ runs: SyncRunSummary[]; jobs: JobClaimSummary[] }>;
  index: Section<IndexSection>;
  families: Section<FamiliesSection>;
  turnReview: Section<TurnReviewSection>;
  retrievalQuality: Section<RetrievalQuality>;
}

export interface RetrievalQuality {
  auditedTurns: number;
  scopeMeasuredTurns: number;
  legacyUnattributedTurns: number;
  scopedTurns: number;
  blockedScopeTurns: number;
  temporalTurns: number;
  defaultWindowTurns: number;
  inheritedScopeTurns: number;
  deferredRecoveryTurns: number;
  documentReviews: number;
  documentReadChars: number;
  documentCheckpoints: number;
  foundNotRead: number;
  quoteWarningTurns: number;
  toolErrorTurns: number;
  budgetHitTurns: number;
  noRetrievalTurns: number;
  categories: Array<{ category: string; turns: number }>;
  legacyCategories: Array<{ category: string; turns: number }>;
  note: string;
}

async function retrievalQualitySection(db: Pool, filters: HealthFilters, start: string, end: string): Promise<RetrievalQuality> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT category, COUNT(*)::int AS turns,
       COUNT(*) FILTER (WHERE retrieval_scope IS NOT NULL)::int AS measured,
       COUNT(*) FILTER (WHERE jsonb_array_length(retrieval_scope->'families') > 0)::int AS scoped,
       COUNT(*) FILTER (WHERE (retrieval_scope->>'blockedCalls')::int > 0)::int AS blocked,
       COUNT(*) FILTER (WHERE (retrieval_scope->>'temporal')::boolean)::int AS temporal,
       COUNT(*) FILTER (WHERE (retrieval_scope->>'timeDefaulted')::boolean)::int AS defaulted,
       COUNT(*) FILTER (WHERE (retrieval_scope->>'inherited')::boolean)::int AS inherited,
       COUNT(*) FILTER (WHERE (retrieval_scope->>'deferredRecovery')::boolean)::int AS deferred,
       COALESCE(SUM((retrieval_scope->>'documentReviews')::bigint),0) AS documents,
       COALESCE(SUM((retrieval_scope->>'documentReadChars')::bigint),0) AS document_chars,
       COALESCE(SUM((retrieval_scope->>'documentCheckpoints')::bigint),0) AS checkpoints,
       COUNT(*) FILTER (WHERE retrieval_used AND found_count > 0 AND read_count = 0)::int AS unread,
       COUNT(*) FILTER (WHERE unverified_quotes > 0)::int AS quotes,
       COUNT(*) FILTER (WHERE tool_error_count > 0)::int AS errors,
       COUNT(*) FILTER (WHERE cardinality(budget_exhausted) > 0)::int AS budget
     FROM knowledge_turn_audit
     WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz AND environment = $3
       AND ($4::text IS NULL OR persona = $4) AND ($5::text IS NULL OR $5 = 'chat')
     GROUP BY category ORDER BY COUNT(*) DESC, category`, [start, end, filters.environment, filters.persona, filters.feature]);
  const legacy = await db.query<Record<string, unknown>>(
    `SELECT category, COUNT(*)::int AS turns FROM knowledge_turn_audit
     WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz AND environment IS NULL
       AND ($3::text IS NULL OR persona = $3) AND ($4::text IS NULL OR $4 = 'chat')
     GROUP BY category ORDER BY COUNT(*) DESC, category`, [start, end, filters.persona, filters.feature]);
  const sum = (key: string): number => rows.reduce((n, r: Record<string, unknown>) => n + num(r[key]), 0);
  return {
    auditedTurns: sum('turns'), scopeMeasuredTurns: sum('measured'),
    legacyUnattributedTurns: legacy.rows.reduce((n, r) => n + num(r['turns']), 0),
    scopedTurns: sum('scoped'), blockedScopeTurns: sum('blocked'), temporalTurns: sum('temporal'),
    defaultWindowTurns: sum('defaulted'), inheritedScopeTurns: sum('inherited'), deferredRecoveryTurns: sum('deferred'), foundNotRead: sum('unread'),
    documentReviews: sum('documents'), documentReadChars: sum('document_chars'), documentCheckpoints: sum('checkpoints'),
    quoteWarningTurns: sum('quotes'), toolErrorTurns: sum('errors'), budgetHitTurns: sum('budget'),
    noRetrievalTurns: rows.filter(r => r['category'] === 'no_retrieval').reduce((n, r) => n + num(r['turns']), 0),
    categories: rows.map(r => ({ category: String(r['category']), turns: num(r['turns']) })),
    legacyCategories: legacy.rows.map(r => ({ category: String(r['category']), turns: num(r['turns']) })),
    note: 'Completed audited general-persona turns only; not all messages or a response-accuracy score. Signals overlap. A blocked scope attempt is prevented drift, not leaked content. Recovery deferral is a heuristic flag for offering another lookup after a retry, not a proven failure. No retrieval can be correct for conversation. Legacy rows have no scope/environment attribution. Wrong intent, missed recovery and stale claims before instrumentation require conversation review; they cannot be inferred as zero.',
  };
}

export interface TurnReviewRow { reviewDate: string; environment: string | null; turns: number; categoryCounts: unknown; rates: unknown; worstTurns: unknown; flags: unknown }
export interface TurnReviewSection { latest: TurnReviewRow | null; trend: TurnReviewRow[]; note: string }

const TREND_DAYS = 7;

async function turnReviewSection(db: Pool, filters: HealthFilters): Promise<TurnReviewSection> {
  const { rows } = await db.query(
    `SELECT to_char(review_date, 'YYYY-MM-DD') AS review_date, to_jsonb(r)->>'environment' AS environment,
       turns, category_counts, rates, worst_turns, flags
     FROM knowledge_daily_review r
     WHERE to_jsonb(r)->>'environment' = $1 OR to_jsonb(r)->>'environment' IS NULL
     ORDER BY review_date DESC LIMIT ${TREND_DAYS}`, [filters.environment]);
  const trend = (rows as Array<Record<string, unknown>>).map((r) => ({
    reviewDate: String(r['review_date']), environment: typeof r['environment'] === 'string' ? r['environment'] : null,
    turns: num(r['turns']), categoryCounts: r['category_counts'], rates: r['rates'],
    worstTurns: Array.isArray(r['worst_turns'])
      ? (r['worst_turns'] as Array<{ category?: string }>).filter(turn => turn.category !== 'no_retrieval') : r['worst_turns'],
    flags: { ...(r['flags'] as Record<string, unknown>), noRetrievalRate: false },
  }));
  return {
    latest: trend[0] ?? null, trend,
    note: 'Nightly snapshots cover whole days and all chat personas, not the usage date/persona filters. New snapshots include attributed production turns only. Older snapshots with environment null may mix local tests, production and unattributed turns; they are not production accuracy scores. No-retrieval rates remain informational and do not raise failure flags or rank a turn among the worst. Other categories are review heuristics, not proof that an answer was wrong.',
  };
}

function dayStart(value: string): number {
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, DATE_LENGTH) !== value) {
    throw new ValidationError('Dates must be real calendar dates in YYYY-MM-DD form', { date: value });
  }
  return ms;
}
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, DATE_LENGTH);

function optionalText(value: string | undefined, name: string): string | null {
  if (value === undefined || value === '') return null;
  if (value.length > MAX_FILTER_LENGTH) throw new ValidationError(`${name} is too long`, { [name]: 'too long' });
  return value;
}

/** Inclusive UTC calendar-day window, at most 90 days; defaults to the last 7 days ending today. */
export function parseHealthQuery(query: HealthQuery, now: Date = new Date()): HealthFilters {
  const today = Date.parse(`${now.toISOString().slice(0, DATE_LENGTH)}T00:00:00.000Z`);
  const toMs = query.to === undefined || query.to === '' ? today : dayStart(query.to);
  const fromMs = query.from === undefined || query.from === '' ? toMs - (HEALTH_DEFAULT_DAYS - 1) * DAY_MS : dayStart(query.from);
  if (fromMs > toMs) throw new ValidationError('from must not be after to', { from: 'after to' });
  if ((toMs - fromMs) / DAY_MS + 1 > HEALTH_MAX_DAYS) {
    throw new ValidationError(`The date range cannot exceed ${HEALTH_MAX_DAYS} days`, { range: 'too long' });
  }
  const environment = query.environment === undefined || query.environment === '' ? 'prod' : query.environment;
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new ValidationError('environment must be prod or dev', { environment });
  }
  return {
    from: isoDay(fromMs), to: isoDay(toMs), environment: environment as HealthEnvironment,
    feature: optionalText(query.feature, 'feature'), persona: optionalText(query.persona, 'persona'),
    deployment: optionalText(query.deployment, 'deployment'),
  };
}

const num = (value: unknown): number => Number(value ?? 0);

function totalsFrom(row: Record<string, unknown>): UsageTotals {
  const promptTokens = num(row['prompt_tokens']);
  const completionTokens = num(row['completion_tokens']);
  return {
    calls: num(row['calls']), failures: num(row['failures']),
    measuredCalls: num(row['measured_calls']), unmeasuredCalls: num(row['calls']) - num(row['measured_calls']),
    promptTokens, cachedPromptTokens: num(row['cached_tokens']),
    completionTokens, reasoningCompletionTokens: num(row['reasoning_tokens']),
    // Cached tokens are part of the prompt and reasoning tokens part of the completion, so neither is added again.
    totalTokens: promptTokens + completionTokens,
    avgLatencyMs: row['avg_ms'] === null || row['avg_ms'] === undefined ? null : num(row['avg_ms']),
  };
}

const AGGREGATES = `COUNT(*)::int AS calls,
  COUNT(*) FILTER (WHERE NOT ok)::int AS failures,
  COUNT(*) FILTER (WHERE usage_known)::int AS measured_calls,
  COALESCE(SUM(prompt_tokens) FILTER (WHERE usage_known), 0)::bigint AS prompt_tokens,
  COALESCE(SUM(cached_tokens) FILTER (WHERE usage_known), 0)::bigint AS cached_tokens,
  COALESCE(SUM(completion_tokens) FILTER (WHERE usage_known), 0)::bigint AS completion_tokens,
  COALESCE(SUM(reasoning_tokens) FILTER (WHERE usage_known), 0)::bigint AS reasoning_tokens,
  ROUND(AVG(duration_ms))::int AS avg_ms`;

async function usageSection(db: Pool, filters: HealthFilters, start: string, end: string): Promise<UsageSection> {
  const window = 'at >= $1::timestamptz AND at < $2::timestamptz AND environment = $3';
  const where = `${window} AND ($4::text IS NULL OR feature = $4) AND ($5::text IS NULL OR persona = $5) AND ($6::text IS NULL OR deployment = $6)`;
  const params = [start, end, filters.environment, filters.feature, filters.persona, filters.deployment];
  const windowParams = params.slice(0, WINDOW_PARAM_COUNT);
  const [totals, rows, features, personas, deployments, first] = await Promise.all([
    db.query(`SELECT ${AGGREGATES} FROM ai_usage_log WHERE ${where}`, params),
    db.query(`SELECT feature, persona, deployment, ${AGGREGATES} FROM ai_usage_log WHERE ${where}
      GROUP BY feature, persona, deployment
      ORDER BY SUM(prompt_tokens + completion_tokens) FILTER (WHERE usage_known) DESC NULLS LAST, COUNT(*) DESC, feature, persona NULLS FIRST, deployment
      LIMIT ${USAGE_ROW_LIMIT + 1}`, params),
    db.query(`SELECT DISTINCT feature AS value FROM ai_usage_log WHERE ${window} ORDER BY 1 LIMIT ${FACET_LIMIT}`, windowParams),
    db.query(`SELECT DISTINCT persona AS value FROM ai_usage_log WHERE ${window} AND persona IS NOT NULL ORDER BY 1 LIMIT ${FACET_LIMIT}`, windowParams),
    db.query(`SELECT DISTINCT deployment AS value FROM ai_usage_log WHERE ${window} ORDER BY 1 LIMIT ${FACET_LIMIT}`, windowParams),
    db.query('SELECT MIN(at) AS first_at FROM ai_usage_log WHERE environment = $1', [filters.environment]),
  ]);
  const firstAt = (first.rows[0] as { first_at: Date | null } | undefined)?.first_at ?? null;
  const values = (result: { rows: unknown[] }): string[] => result.rows.map((row) => String((row as { value: unknown }).value));
  return {
    totals: totalsFrom((totals.rows[0] ?? {}) as Record<string, unknown>),
    rows: rows.rows.slice(0, USAGE_ROW_LIMIT).map((row) => {
      const record = row as Record<string, unknown>;
      return { feature: String(record['feature']), persona: record['persona'] === null ? null : String(record['persona']),
        deployment: String(record['deployment']), ...totalsFrom(record) };
    }),
    rowsTruncated: rows.rows.length > USAGE_ROW_LIMIT,
    facets: { features: values(features), personas: values(personas), deployments: values(deployments) },
    firstRecordedAt: firstAt === null ? null : new Date(firstAt).toISOString(),
  };
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as Date).toISOString());

async function syncSection(db: Pool): Promise<{ runs: SyncRunSummary[]; jobs: JobClaimSummary[] }> {
  const [runs, jobs] = await Promise.all([
    db.query(`SELECT id, status, started_at, finished_at, results FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT ${RUN_LIMIT}`),
    db.query(`SELECT job, period, status, started_at, finished_at FROM scheduled_job_claims ORDER BY started_at DESC LIMIT ${RUN_LIMIT}`),
  ]);
  return {
    runs: runs.rows.map((row) => {
      const record = row as { id: string; status: string; started_at: Date; finished_at: Date | null; results: unknown };
      const results = Array.isArray(record.results) ? record.results as Array<Record<string, unknown>> : [];
      return {
        id: String(record.id), status: record.status, startedAt: iso(record.started_at) ?? '', finishedAt: iso(record.finished_at),
        sources: results.map((result) => ({ source: String(result['source'] ?? 'unknown'), indexed: num(result['indexed']), errors: num(result['errors']) })),
      };
    }),
    jobs: jobs.rows.map((row) => {
      const record = row as { job: string; period: string; status: string; started_at: Date; finished_at: Date | null };
      return { job: record.job, period: record.period, status: record.status, startedAt: iso(record.started_at) ?? '', finishedAt: iso(record.finished_at) };
    }),
  };
}

async function indexSection(db: Pool): Promise<IndexSection> {
  const [sources, scoring] = await Promise.all([
    db.query(`SELECT source, COUNT(*)::int AS items, MAX(indexed_at) AS last_indexed_at
      FROM content_items GROUP BY source ORDER BY MAX(indexed_at) DESC NULLS LAST, source LIMIT ${SOURCE_LIMIT}`),
    db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE relevance_explanation IS NULL)::int AS unscored
      FROM content_items WHERE source = 'discovered-article'`),
  ]);
  const score = (scoring.rows[0] ?? {}) as { total?: number; unscored?: number };
  return {
    sources: sources.rows.map((row) => {
      const record = row as { source: string; items: number; last_indexed_at: Date | null };
      return { source: record.source, items: num(record.items), lastIndexedAt: iso(record.last_indexed_at) };
    }),
    scoring: { discoveredArticles: num(score.total), unscored: num(score.unscored) },
  };
}

// Optional tables added by later migrations; absent tables are reported as "not measured", never as zero.
const INDEXING_WORK_TABLES = ['knowledge_indexing_work'] as const; // migration 089
const DECISION_TABLES = ['semantic_edges'] as const; // migration 090 (decision relationships; acceptance lives on chat_decisions)
// Match ingestion limits, not the unrelated size of search previews.
const INGESTION_BODY_CAP_SQL = `CASE
  WHEN source = 'onedrive-document' THEN 250000
  WHEN source = 'ica-document' THEN 20000
  WHEN source = 'email' THEN 5000
  ELSE NULL END`;
const SYNC_CONTENT_SOURCES: Record<string, string[]> = {
  'graph-mail': ['email'],
  'alliance-mail': ['email'],
  'ica-collections': ['ica-document'],
  'onedrive-documents': ['onedrive-document'],
  'project-docs': ['github-doc'],
  'github-content-store': ['github-content-store'],
  'discovered-articles': ['discovered-article'],
  'gitlab-commits': ['gitlab-commit'],
  'gitlab-mrs': ['gitlab-mr'],
  'gitlab-issues': ['gitlab-issue'],
  'gitlab-pipelines': ['gitlab-pipeline'],
  'gitlab-releases': ['gitlab-release'],
  'gitlab-deployments': ['gitlab-deployment'],
  'github-commits': ['github-commit'],
  'github-prs': ['github-pr'],
  'github-issues': ['github-issue'],
  'github-actions': ['github-action'],
  'github-releases': ['github-release'],
  'github-deployments': ['github-deployment'],
  'github-pr-reviews': ['github-pr-review'],
  cms: ['cms-blog', 'cms-newsletter', 'cms-podcast-show-notes', 'cms-session-summary'],
};
const SOURCE_ROW_LIMIT = 100;
const PENDING_STATUSES = new Set(['pending', 'queued', 'leased', 'retry', 'running']);
const FAILED_STATUSES = new Set(['failed', 'dead', 'error']);
const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'succeeded']);

async function presentTable(db: Pool, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const result = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
    if ((result.rows[0] as { present?: boolean } | undefined)?.present === true) return name;
  }
  return null;
}

async function indexingWork(db: Pool): Promise<IndexingWork> {
  const unmeasured: IndexingWork = { measured: false, pending: null, failed: null, done: null };
  try {
    const table = await presentTable(db, INDEXING_WORK_TABLES);
    if (table === null) return unmeasured;
    const rows = await db.query(`SELECT status, COUNT(*)::int AS total FROM ${table} GROUP BY status LIMIT 20`);
    const sum = (statuses: Set<string>): number => rows.rows
      .filter((row) => statuses.has(String((row as { status: unknown }).status).toLowerCase()))
      .reduce((total: number, row) => total + num((row as { total: unknown }).total), 0);
    return { measured: true, pending: sum(PENDING_STATUSES), failed: sum(FAILED_STATUSES), done: sum(DONE_STATUSES) };
  } catch {
    return unmeasured;
  }
}

/** Semantic status is never "up to date" from a provider connection alone: it needs measured, drained indexing work. */
export function semanticStatus(providerConfigured: boolean, work: IndexingWork): SemanticStatus {
  if (!providerConfigured) {
    return { state: 'not-configured', providerConfigured, work, message: 'Semantic search is not configured; exact and keyword search still work.' };
  }
  if (!work.measured) {
    return { state: 'coverage-not-measured', providerConfigured, work, message: 'The provider is configured but how much has been indexed is not measured.' };
  }
  if ((work.failed ?? 0) > 0) {
    return { state: 'temporarily-unavailable', providerConfigured, work, message: 'Some records failed to index and will be retried.' };
  }
  if ((work.pending ?? 0) > 0) {
    return { state: 'pending-work', providerConfigured, work, message: 'Indexing work is still pending.' };
  }
  if ((work.done ?? 0) > 0) {
    return { state: 'up-to-date', providerConfigured, work, message: 'No pending or failed indexing work.' };
  }
  return { state: 'coverage-not-measured', providerConfigured, work, message: 'No indexing work has completed yet.' };
}

interface SourceStats { items: number; metadataOnly: number; atCap: number; lastIndexedAt: string | null }

function familyState(availability: Availability, stats: SourceStats[], errored: boolean): FamilyState {
  if (availability === 'excluded') return 'excluded';
  if (availability === 'unavailable') return 'not-configured';
  if (errored) return 'temporarily-unavailable';
  if (availability === 'supported') return 'up-to-date';
  return stats.some((s) => s.metadataOnly > 0) ? 'unsupported-extraction' : 'partial';
}

async function familiesSection(db: Pool, options: KnowledgeHealthOptions): Promise<FamiliesSection> {
  const [sourceRows, runRows, work, decisionTable] = await Promise.all([
    db.query(`SELECT source, COUNT(*)::int AS items,
        COUNT(*) FILTER (WHERE body = '')::int AS metadata_only,
        COUNT(*) FILTER (WHERE length(body) >= (${INGESTION_BODY_CAP_SQL}))::int AS at_cap,
        MAX(indexed_at) AS last_indexed_at
      FROM content_items GROUP BY source LIMIT ${SOURCE_ROW_LIMIT}`),
    db.query(`SELECT status, finished_at, results FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT ${RUN_LIMIT}`).catch(() => ({ rows: [] })),
    indexingWork(db),
    presentTable(db, DECISION_TABLES).catch(() => null),
  ]);
  const stats = new Map<string, SourceStats>();
  for (const row of sourceRows.rows) {
    const r = row as { source: string; items: number; metadata_only: number; at_cap: number; last_indexed_at: Date | null };
    stats.set(r.source, { items: num(r.items), metadataOnly: num(r.metadata_only), atCap: num(r.at_cap), lastIndexedAt: iso(r.last_indexed_at) });
  }
  // Latest run that mentioned a source decides whether that source is currently erroring.
  const latestErrors = new Map<string, boolean>();
  const latestSyncKeys = new Set<string>();
  let lastSuccessfulSyncAt: string | null = null;
  const failedRunCategories = new Set<string>();
  for (const row of runRows.rows) {
    const r = row as { status: string; finished_at: Date | null; results: unknown };
    if (r.status === 'completed' || r.status === 'succeeded') lastSuccessfulSyncAt ??= iso(r.finished_at);
    if (r.status === 'failed') failedRunCategories.add('sync-run-failed');
    for (const result of Array.isArray(r.results) ? r.results as Array<Record<string, unknown>> : []) {
      const key = String(result['source'] ?? '');
      if (key !== '' && !latestSyncKeys.has(key)) {
        latestSyncKeys.add(key);
        for (const source of SYNC_CONTENT_SOURCES[key] ?? [key]) {
          latestErrors.set(source, latestErrors.get(source) === true || num(result['errors']) > 0);
        }
      }
    }
  }
  const families: FamilyHealth[] = KNOWLEDGE_FAMILIES.map((family) => {
    const sources = Object.entries(CONTENT_SOURCE_DISPOSITIONS).filter(([, d]) => d.family === family.kind).map(([name]) => name);
    const present = sources.map((name) => stats.get(name)).filter((s): s is SourceStats => s !== undefined);
    const measured = sources.length > 0;
    const errored = sources.some((name) => latestErrors.get(name) === true);
    const lastIndexedAt = present.map((s) => s.lastIndexedAt).filter((v): v is string => v !== null).sort().pop() ?? null;
    const sum = (pick: (s: SourceStats) => number): number => present.reduce((total, s) => total + pick(s), 0);
    const items = sum((s) => s.items);
    return {
      kind: family.kind, availability: family.availability, state: familyState(family.availability, present, errored),
      capabilities: family.capabilities, entryPoint: family.entryPoint, reason: family.reason, sources,
      // Eligible and per-family pending/failed are not recorded anywhere, so they are reported as not measured.
      counts: { eligible: null, indexed: measured ? items : null, pending: null, failed: null },
      extraction: measured ? { fullText: items - sum((s) => s.metadataOnly) - sum((s) => s.atCap), metadataOnly: sum((s) => s.metadataOnly), atIngestionCap: sum((s) => s.atCap) } : null,
      lastIndexedAt, lastSuccessfulSyncAt: measured ? lastSuccessfulSyncAt : null,
      errorCategories: [...(errored ? ['sync-errors' as const] : []), ...(measured && failedRunCategories.size > 0 ? ['sync-run-failed' as const] : [])],
    };
  });
  return {
    families, semantic: semanticStatus(options.semanticConfigured === true, work),
    orchestrationEnabled: options.orchestrationEnabled === true, decisionTablesMeasured: decisionTable !== null, lastSuccessfulSyncAt,
  };
}

async function guarded<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { available: true, data: await read() };
  } catch {
    // The cause can carry SQL or connection detail, so only a fixed message leaves the server.
    return { available: false, message: 'This section could not be read right now.' };
  }
}

export async function getKnowledgeHealth(
  db: Pool, filters: HealthFilters, now: Date = new Date(), options: KnowledgeHealthOptions = {},
): Promise<KnowledgeHealth> {
  const start = new Date(dayStart(filters.from)).toISOString();
  const end = new Date(dayStart(filters.to) + DAY_MS).toISOString();
  const [usage, syncRuns, index, families, turnReview, retrievalQuality] = await Promise.all([
    guarded(() => usageSection(db, filters, start, end)),
    guarded(() => syncSection(db)),
    guarded(() => indexSection(db)),
    guarded(() => familiesSection(db, options)),
    guarded(() => turnReviewSection(db, filters)),
    filters.deployment !== null
      ? Promise.resolve<Section<RetrievalQuality>>({ available: false, message: 'Turn quality has no per-deployment attribution. Clear the deployment filter to review it.' })
      : guarded(() => retrievalQualitySection(db, filters, start, end)),
  ]);
  return { generatedAt: now.toISOString(), filters, windowStart: start, windowEnd: end, usage, syncRuns, index, families, turnReview, retrievalQuality };
}
