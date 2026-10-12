/**
 * health/knowledgeHealth.ts — bounded, read-only aggregates for the Knowledge health page.
 * Each section fails independently so one unavailable table never hides the rest. Nothing here reads
 * prompts, message content, session ids or error text, and nothing calls a model or a provider.
 */
import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';

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
export interface KnowledgeHealth {
  generatedAt: string;
  filters: HealthFilters;
  windowStart: string;
  windowEnd: string;
  usage: Section<UsageSection>;
  syncRuns: Section<{ runs: SyncRunSummary[]; jobs: JobClaimSummary[] }>;
  index: Section<IndexSection>;
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

async function guarded<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { available: true, data: await read() };
  } catch {
    // The cause can carry SQL or connection detail, so only a fixed message leaves the server.
    return { available: false, message: 'This section could not be read right now.' };
  }
}

export async function getKnowledgeHealth(db: Pool, filters: HealthFilters, now: Date = new Date()): Promise<KnowledgeHealth> {
  const start = new Date(dayStart(filters.from)).toISOString();
  const end = new Date(dayStart(filters.to) + DAY_MS).toISOString();
  const [usage, syncRuns, index] = await Promise.all([
    guarded(() => usageSection(db, filters, start, end)),
    guarded(() => syncSection(db)),
    guarded(() => indexSection(db)),
  ]);
  return { generatedAt: now.toISOString(), filters, windowStart: start, windowEnd: end, usage, syncRuns, index };
}
