import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  CONTENT_SOURCES, CORPUS, D1_KEY_OFFSET, D1_KEY_STATEMENT, D1_LENGTH, D7_PAGE_BOUNDARY, EDGES, EVAL_PACK, FAMILY_KINDS, MINIMAL_FIXTURES,
  PINNED_NOW_ISO, SECRET_CANARY, expectedOverdueTasks, evaluateRecall, generatePerfEdges, generatePerfRecords, goldenQueries, noisyMatches,
  perfCounts, perfRecordAt, recallAtK, recordByAlias, seedKnowledgeFixtures, stableUuid, validateEvalPack,
} from './fixtures/knowledge/index.js';
import { KNOWLEDGE_FAMILIES } from '../src/ai/knowledge/manifest.js';
import { createMockAdapter, liveRefusal, runEvaluation } from './knowledge-eval.js';
import { percentile } from './knowledge-perf.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const backend = resolve(import.meta.dirname, '..');

test('corpus: spec aliases exist with stable valid UUIDs and a pinned clock', () => {
  const aliases = ['P1', 'N1', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'C1', 'T1', 'T2', 'T3', 'T4', 'A1', 'A2', 'A3', 'A4', 'W1', 'W2', 'W3',
    'H1', 'H2', 'O1', 'R1', 'U1', 'B1', 'S1', 'PE1', 'PE2', 'M1', 'M2', 'M3', 'V1', 'X1', 'X2', 'X3', 'SD1', 'SD2', 'SD3'];
  for (const a of aliases) assert.match(recordByAlias(a).id, UUID, a);
  assert.equal(recordByAlias('D1').id, stableUuid('D1'));
  assert.equal(new Set(CORPUS.map((r) => r.id)).size, CORPUS.length);
  assert.equal(PINNED_NOW_ISO, '2026-10-22T09:00:00Z');
  for (const e of EDGES) {
    assert.ok(CORPUS.some((r) => r.alias === e.from) && CORPUS.some((r) => r.alias === e.to), `${e.from}->${e.to}`);
  }
  assert.equal(noisyMatches().length, 30);
});

test('corpus: D1 tail fact, D7 surrogate boundary, canary confinement, T1 stale copy', () => {
  const d1 = recordByAlias('D1').text;
  assert.equal(d1.length, D1_LENGTH);
  assert.equal(d1.indexOf(D1_KEY_STATEMENT), D1_KEY_OFFSET);
  assert.equal(d1.lastIndexOf(D1_KEY_STATEMENT), D1_KEY_OFFSET);
  const d7 = recordByAlias('D7').text;
  const high = d7.charCodeAt(D7_PAGE_BOUNDARY - 1);
  assert.ok(high >= 0xd800 && high <= 0xdbff);
  assert.equal(d7.slice(D7_PAGE_BOUNDARY - 1, D7_PAGE_BOUNDARY + 1), '😀');
  for (const r of [...CORPUS, ...MINIMAL_FIXTURES.map((f) => f.record)]) {
    const { excludedField, ...visible } = r;
    assert.ok(!JSON.stringify(visible).includes(SECRET_CANARY), `${r.alias} leaks the canary outside excludedField`);
    if (excludedField) assert.equal(excludedField.value, SECRET_CANARY);
  }
  assert.equal(recordByAlias('X2').excludedField?.value, SECRET_CANARY);
  assert.equal(recordByAlias('T1').state, 'blocked');
  assert.equal(recordByAlias('T1').staleIndexedCopy?.state, 'completed');
  assert.equal(recordByAlias('P1').meta?.['targetDate'], '2026-11-30');
});

test('minimal fixtures: one per manifest family and per ContentSource', async () => {
  assert.deepEqual([...FAMILY_KINDS].sort(), KNOWLEDGE_FAMILIES.map((f) => f.kind).sort());
  const text = await readFile(new URL('../src/types/contentItem.ts', import.meta.url), 'utf8');
  const start = text.indexOf('export type ContentSource');
  const union = text.slice(start, text.indexOf('/**', start));
  const sources = [...union.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(CONTENT_SOURCES.map((s) => s.source).sort(), [...sources].sort());
  assert.equal(MINIMAL_FIXTURES.length, FAMILY_KINDS.length + CONTENT_SOURCES.length);
  assert.equal(new Set(MINIMAL_FIXTURES.map((f) => f.record.id)).size, MINIMAL_FIXTURES.length);
  assert.equal(new Set(MINIMAL_FIXTURES.map((f) => f.token)).size, MINIMAL_FIXTURES.length);
  for (const f of MINIMAL_FIXTURES) {
    assert.ok(f.record.text.includes(f.token));
    assert.equal(f.discovery.expectId, f.record.id);
    assert.ok(f.provenance.origin && f.unsupportedField.field);
    assert.equal(f.update.applicable || Boolean(f.update.reason), true);
    assert.equal(f.delete.applicable || Boolean(f.delete.reason), true);
  }
});

test('perf dataset: spec sizes, determinism and golden queries', () => {
  const full = perfCounts();
  assert.deepEqual(full, { records: 50_000, longRecords: 5_000, passagesPerLong: 10, tasks: 10_000, projects: 100, edges: 100_000 });
  assert.deepEqual(perfRecordAt(3), perfRecordAt(3));
  assert.equal(perfRecordAt(0).passages.length, 10);
  assert.equal(perfRecordAt(5_000).kind, 'task');
  const small = perfCounts(0.02);
  const kinds = new Map<string, number>();
  for (const r of generatePerfRecords(small)) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  assert.equal(kinds.get('long'), small.longRecords);
  assert.equal(kinds.get('task'), small.tasks);
  assert.equal([...kinds.values()].reduce((a, b) => a + b, 0), small.records);
  let edges = 0;
  for (const e of generatePerfEdges(small)) { edges++; assert.notEqual(e.from, e.to); }
  assert.equal(edges, small.edges);
  const golden = goldenQueries(small);
  assert.ok(golden.length >= 10);
  const byId = new Map([...generatePerfRecords(small)].map((r) => [r.id, r]));
  for (const g of golden) {
    const gold = byId.get(g.goldIds[0]!)!;
    assert.ok(`${gold.title} ${gold.text}`.includes(g.query));
    if (g.passageIndex !== undefined) assert.ok(gold.passages[g.passageIndex]!.includes(g.query));
  }
  const overdue = expectedOverdueTasks(small);
  assert.ok(Object.values(overdue).reduce((a, b) => a + b, 0) > 0);
});

test('evaluation pack: shape, categories and authored evidence', () => {
  assert.deepEqual(validateEvalPack(), []);
  assert.ok(EVAL_PACK.length >= 46);
  const by = (c: string) => EVAL_PACK.filter((q) => q.category === c).length;
  assert.equal(by('exact-identity'), 10);
  assert.equal(by('paraphrase-long'), 10);
  assert.equal(by('cross-source'), 10);
  assert.equal(by('conflict-no-answer'), 10);
  assert.equal(by('semantic-live-rule'), 2);
  assert.equal(by('semantic-relationship'), 2);
  assert.equal(by('semantic-contradictory'), 2);
  for (const q of EVAL_PACK.filter((x) => x.category === 'cross-source')) assert.ok(q.requiredRecords.length >= 3, q.id);
  for (const q of EVAL_PACK) {
    assert.ok(q.strictFilters.projectScope && q.sourceRoles && q.forbiddenClaims && q.acceptedUncertainty, q.id);
    for (const a of q.requiredRecords) assert.ok(q.sourceRoles[a], `${q.id} role for ${a}`);
  }
});

test('recall@10: unique parents, first ten only, unanswerable excluded', () => {
  assert.equal(recallAtK(['a', 'b'], ['a', 'c']), 0.5);
  assert.equal(recallAtK(['a', 'a', 'a', 'b'], ['b'], 2), 1);
  const filler = Array.from({ length: 10 }, (_, i) => `f${i}`);
  assert.equal(recallAtK([...filler, 'gold'], ['gold']), 0);
  assert.equal(recallAtK(['x'], []), undefined);
  assert.equal(recallAtK(['A', 'b'], ['a'], 10, (s) => s.toLowerCase()), 1);
  const report = evaluateRecall(EVAL_PACK, (q) => (q.id === 'EI-01' ? ['nothing'] : q.requiredRecords));
  assert.equal(report.perQuestion['EI-01'], 0);
  assert.ok(!('EI-04' in report.perQuestion));
  assert.ok(report.macro < 1 && report.macro > 0.9);
});

test('harness: deterministic mock run passes and live runs are refused without approval', async () => {
  const a = await runEvaluation(createMockAdapter(), 'mock');
  const b = await runEvaluation(createMockAdapter(), 'mock');
  assert.equal(a.passed, true, a.failures.join('; '));
  assert.deepEqual(a.results, b.results);
  assert.equal(a.recall.macro, 1);
  assert.equal(a.deployment, 'mock-model');
  assert.match(liveRefusal({}) ?? '', /KNOWLEDGE_EVAL_LIVE=approved/);
  assert.equal(liveRefusal({ KNOWLEDGE_EVAL_LIVE: 'approved' }), null);
  const leaky = await runEvaluation({
    describe: () => ({ deployment: 'leaky', params: {} }),
    run: async (q) => ({ retrieved: q.requiredRecords, answer: `${q.expectedFacts.join('. ')} ${SECRET_CANARY} purple-heron`, citations: q.requiredRecords }),
  }, 'mock');
  assert.equal(leaky.passed, false);
  assert.ok(leaky.criticalFailures.includes('CN-07') && leaky.criticalFailures.includes('CN-08'));
});

test('CLI: live eval without approval exits 2; perf without PERF_DATABASE_URL is unverified', () => {
  const env = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '' };
  const run = (file: string, args: string[] = []) =>
    spawnSync(process.execPath, ['--import', 'tsx/esm', file, ...args], { cwd: backend, env, encoding: 'utf8' });
  const live = run('scripts/knowledge-eval.ts', ['--live']);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /refused/);
  const perf = run('scripts/knowledge-perf.ts');
  assert.equal(perf.status, 2);
  assert.match(perf.stderr, /unverified/);
});

test('percentile uses nearest rank', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile(Array.from({ length: 200 }, (_, i) => i + 1), 95), 190);
  assert.ok(Number.isNaN(percentile([], 95)));
});

test('PGlite seeding creates only fixture tables, is idempotent and keeps the canary in the excluded column', async () => {
  const db = new PGlite();
  const first = await seedKnowledgeFixtures(db, { noise: true, unrelated: 50, minimal: true });
  const again = await seedKnowledgeFixtures(db, { noise: true, unrelated: 50, minimal: true });
  assert.deepEqual(first, again);
  const tables = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`)).rows;
  assert.deepEqual(tables.map((t) => t.table_name), ['kf_clock', 'kf_edges', 'kf_projects', 'kf_records']);
  const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM kf_records')).rows[0]!.n;
  assert.equal(count, first.records);
  const d1 = (await db.query<{ len: number }>(`SELECT length(body)::int AS len FROM kf_records WHERE id = $1`, [stableUuid('D1')])).rows[0]!;
  assert.equal(d1.len, D1_LENGTH);
  const leaks = (await db.query<{ alias: string }>(`SELECT alias FROM kf_records WHERE body LIKE '%' || $1 || '%' OR title LIKE '%' || $1 || '%' OR meta::text LIKE '%' || $1 || '%'`, [SECRET_CANARY])).rows;
  assert.deepEqual(leaks, []);
  const injection = (await db.query(`SELECT 1 FROM kf_records WHERE title = $1`, ["Robert's feedback'; DROP TABLE kf_records;--"])).rows;
  assert.equal(injection.length, 0);
  const project = (await db.query<{ target_date: string | Date }>(`SELECT target_date FROM kf_projects WHERE id='p-imagine'`)).rows;
  assert.equal(project.length, 1);
  await db.close();
});
