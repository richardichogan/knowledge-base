import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  expectedOverdueTasks, generatePerfEdges, generatePerfRecords, goldenQueries, perfCounts, perfProjectId, PINNED_NOW_ISO,
  type PerfCounts,
} from './fixtures/knowledge/index.js';

/**
 * Knowledge performance benchmark (spec 12.3). Requires an isolated PostgreSQL 16 via PERF_DATABASE_URL;
 * without it the result is "unverified" (exit 2). PGlite/mock timings are never acceptance evidence.
 * Per path: cold request (reported separately), 10 warm-up, 200 measured; p50/p95, errors, rows scanned, query count.
 * Optional env: PERF_SCALE (default 1; anything else is marked not-acceptance), PERF_OUT (JSON report path),
 * PERF_SEMANTIC_MODE (recorded only), PERF_KEEP=1 (keep the kf_perf schema).
 */

export const WARMUP = 10;
export const MEASURED = 200;
export const THRESHOLDS_MS = { exactRead: 300, structured: 750, lexical: 750 } as const;

/** Nearest-rank percentile on an unsorted sample. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export interface PathResult {
  path: string;
  coldMs: number;
  p50Ms: number;
  p95Ms: number;
  errors: number;
  incorrect: number;
  queriesPerRequest: number;
  rowsScanned: number | null;
  thresholdMs: number;
  passed: boolean;
  plan?: unknown;
}

type Client = pg.PoolClient;

interface Counting { client: Client; queries: () => number; reset: () => void }

function counting(client: Client): Counting {
  let n = 0;
  const original = client.query.bind(client) as (...a: unknown[]) => unknown;
  (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => { n++; return original(...a); };
  return { client, queries: () => n, reset: () => { n = 0; } };
}

async function seed(client: Client, counts: PerfCounts): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS kf_perf CASCADE; CREATE SCHEMA kf_perf;
    CREATE TABLE kf_perf.records (id uuid PRIMARY KEY, kind text NOT NULL, project_id text NOT NULL, title text NOT NULL, body text NOT NULL,
      status text, due date, updated_at timestamptz NOT NULL, tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || body)) STORED);
    CREATE TABLE kf_perf.passages (record_id uuid NOT NULL, idx int NOT NULL, body text NOT NULL, tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED, PRIMARY KEY (record_id, idx));
    CREATE TABLE kf_perf.edges (id uuid PRIMARY KEY, from_id uuid NOT NULL, to_id uuid NOT NULL, type text NOT NULL, provenance text NOT NULL);`);
  const flush = async (sql: string, cols: unknown[][]) => { if (cols[0]!.length) await client.query(sql, cols); };
  let b: unknown[][] = [[], [], [], [], [], [], [], []];
  let pb: unknown[][] = [[], [], []];
  for (const r of generatePerfRecords(counts)) {
    [r.id, r.kind, r.projectId, r.title, r.text, r.status ?? null, r.due ?? null, r.updatedAt].forEach((v, i) => b[i]!.push(v));
    r.passages.forEach((p, i) => { pb[0]!.push(r.id); pb[1]!.push(i); pb[2]!.push(p); });
    if (b[0]!.length >= 1000) {
      await flush('INSERT INTO kf_perf.records (id,kind,project_id,title,body,status,due,updated_at) SELECT * FROM unnest($1::uuid[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::date[],$8::timestamptz[])', b);
      await flush('INSERT INTO kf_perf.passages (record_id,idx,body) SELECT * FROM unnest($1::uuid[],$2::int[],$3::text[])', pb);
      b = [[], [], [], [], [], [], [], []]; pb = [[], [], []];
    }
  }
  await flush('INSERT INTO kf_perf.records (id,kind,project_id,title,body,status,due,updated_at) SELECT * FROM unnest($1::uuid[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::date[],$8::timestamptz[])', b);
  await flush('INSERT INTO kf_perf.passages (record_id,idx,body) SELECT * FROM unnest($1::uuid[],$2::int[],$3::text[])', pb);
  let e: unknown[][] = [[], [], [], [], []];
  const flushEdges = async () => flush('INSERT INTO kf_perf.edges SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::text[],$5::text[])', e);
  for (const edge of generatePerfEdges(counts)) {
    [edge.id, edge.from, edge.to, edge.type, edge.provenance].forEach((v, i) => e[i]!.push(v));
    if (e[0]!.length >= 2000) { await flushEdges(); e = [[], [], [], [], []]; }
  }
  await flushEdges();
  await client.query(`CREATE INDEX ON kf_perf.records USING gin (tsv); CREATE INDEX ON kf_perf.passages USING gin (tsv);
    CREATE INDEX ON kf_perf.records (kind, project_id, status, due); CREATE INDEX ON kf_perf.edges (from_id); CREATE INDEX ON kf_perf.edges (to_id);
    ANALYZE kf_perf.records; ANALYZE kf_perf.passages; ANALYZE kf_perf.edges;`);
}

function scanned(plan: unknown): number {
  const walk = (n: Record<string, unknown>): number => {
    const own = String(n['Node Type'] ?? '').includes('Scan')
      ? Number(n['Actual Rows'] ?? 0) * Number(n['Actual Loops'] ?? 1) + Number(n['Rows Removed by Filter'] ?? 0) : 0;
    return own + ((n['Plans'] as Record<string, unknown>[] | undefined) ?? []).reduce((s, c) => s + walk(c), 0);
  };
  const root = (plan as { Plan: Record<string, unknown> }[])[0]!;
  return walk(root.Plan);
}

async function measure(
  c: Counting, name: string, thresholdMs: number, sql: string, argsFor: (i: number) => unknown[], check: (rows: unknown[], i: number) => boolean,
): Promise<PathResult> {
  const times: number[] = [];
  let errors = 0, incorrect = 0, coldMs = Number.NaN, perRequest = 0;
  for (let i = 0; i < 1 + WARMUP + MEASURED; i++) {
    c.reset();
    const t0 = performance.now();
    try {
      const res = await c.client.query(sql, argsFor(i));
      const dt = performance.now() - t0;
      if (i === 0) coldMs = dt;
      else if (i > WARMUP) {
        times.push(dt);
        if (!check(res.rows, i)) incorrect++;
        perRequest = c.queries();
      }
    } catch { if (i > WARMUP) errors++; }
  }
  const explain = await c.client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, argsFor(0));
  const plan = (explain.rows[0] as Record<string, unknown>)['QUERY PLAN'];
  const p95 = percentile(times, 95);
  return {
    path: name, coldMs, p50Ms: percentile(times, 50), p95Ms: p95, errors, incorrect, queriesPerRequest: perRequest,
    rowsScanned: scanned(plan), thresholdMs, passed: errors === 0 && incorrect === 0 && p95 <= thresholdMs, plan,
  };
}

export async function runBenchmark(url: string, scale: number): Promise<Record<string, unknown>> {
  const counts = perfCounts(scale);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const raw = await pool.connect();
  try {
    const version = String((await raw.query('SHOW server_version')).rows[0]!.server_version);
    if (!version.startsWith('16')) return { status: 'unverified', reason: `PostgreSQL ${version} is not 16` };
    await seed(raw, counts);
    const c = counting(raw);
    const golden = goldenQueries(counts);
    const expectedOverdue = expectedOverdueTasks(counts);
    const projects = Array.from({ length: Math.min(counts.projects, 20) }, (_, i) => perfProjectId(i));
    const results: PathResult[] = [];
    results.push(await measure(c, 'exact-id-read', THRESHOLDS_MS.exactRead, 'SELECT id, title, body FROM kf_perf.records WHERE id = $1',
      (i) => [golden[i % golden.length]!.goldIds[0]], (rows) => rows.length === 1));
    results.push(await measure(c, 'structured-count', THRESHOLDS_MS.structured,
      `SELECT count(*)::int AS n FROM kf_perf.records WHERE kind='task' AND project_id=$1 AND status IN ('open','blocked') AND due < $2::timestamptz::date`,
      (i) => [projects[i % projects.length], PINNED_NOW_ISO],
      (rows, i) => (rows[0] as { n: number }).n === (expectedOverdue[projects[i % projects.length]!] ?? 0)));
    results.push(await measure(c, 'structured-page', THRESHOLDS_MS.structured,
      `SELECT id, title, status, due FROM kf_perf.records WHERE kind='task' AND project_id=$1 AND status IN ('open','blocked') AND due < $2::timestamptz::date ORDER BY due, id LIMIT 50`,
      (i) => [projects[i % projects.length], PINNED_NOW_ISO], (rows) => rows.length <= 50));
    results.push(await measure(c, 'lexical-search', THRESHOLDS_MS.lexical,
      `SELECT id FROM (SELECT id FROM kf_perf.records WHERE tsv @@ plainto_tsquery('simple',$1) UNION SELECT record_id FROM kf_perf.passages WHERE tsv @@ plainto_tsquery('simple',$1)) m LIMIT 10`,
      (i) => [golden[i % golden.length]!.query.toLowerCase()],
      (rows, i) => (rows as { id: string }[]).some((r) => r.id === golden[i % golden.length]!.goldIds[0])));
    if (process.env.PERF_KEEP !== '1') await raw.query('DROP SCHEMA kf_perf CASCADE');
    const acceptance = scale === 1;
    return {
      status: !acceptance ? 'not-acceptance-evidence' : results.every((r) => r.passed) ? 'pass' : 'fail',
      postgres: version, scale, counts, semanticMode: process.env.PERF_SEMANTIC_MODE ?? 'disabled', warmup: WARMUP, measured: MEASURED,
      hardware: { platform: platform(), release: release(), cpus: cpus().length, cpuModel: cpus()[0]?.model, memGiB: Math.round(totalmem() / 2 ** 30) },
      note: 'Concurrency (PERF-02), first-token latency and semantic-provider paths are not covered here and remain unverified.',
      results,
    };
  } finally { raw.release(); await pool.end(); }
}

async function main(): Promise<number> {
  const url = process.env.PERF_DATABASE_URL;
  if (!url) { console.error('unverified: PERF_DATABASE_URL (isolated PostgreSQL 16) is not set. PGlite/mock timings are not performance evidence.'); return 2; }
  const report = await runBenchmark(url, Number(process.env.PERF_SCALE ?? 1));
  const text = JSON.stringify(report, null, 2);
  if (process.env.PERF_OUT) writeFileSync(resolve(process.env.PERF_OUT), text);
  console.log(text);
  return report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error('benchmark error:', e instanceof Error ? e.message : e); process.exitCode = 1; });
}
