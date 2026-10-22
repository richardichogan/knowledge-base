import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { knowledgeHealthRouter } from '../src/routes/knowledgeHealth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { getKnowledgeHealth, parseHealthQuery, semanticStatus } from '../src/health/knowledgeHealth.js';
import { CONTENT_SOURCE_DISPOSITIONS, KNOWLEDGE_FAMILIES } from '../src/ai/knowledge/manifest.js';
import type { Pool } from 'pg';

async function fixtureDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of ['054_ai_usage_log.sql', '065_runtime_runs.sql', '067_ai_usage_measured.sql']) {
    await db.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await db.exec(`CREATE TABLE content_items (id SERIAL PRIMARY KEY, source TEXT, indexed_at TIMESTAMPTZ, relevance_explanation TEXT, body TEXT NOT NULL DEFAULT '');`);
  return db;
}

const usage = (db: PGlite, at: string, o: { env?: string; feature?: string; persona?: string | null; deployment?: string; known?: boolean;
  prompt?: number; cached?: number; completion?: number; reasoning?: number; ms?: number; ok?: boolean; error?: string | null } = {}) =>
  db.query(`INSERT INTO ai_usage_log (at, environment, feature, persona, session_id, slot, deployment, prompt_tokens, cached_tokens,
    completion_tokens, reasoning_tokens, duration_ms, ok, error, usage_known) VALUES ($1,$2,$3,$4,'secret-session','standard',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [at, o.env ?? 'prod', o.feature ?? 'chat', o.persona ?? null, o.deployment ?? 'gpt-a', o.prompt ?? 0, o.cached ?? 0, o.completion ?? 0,
    o.reasoning ?? 0, o.ms ?? 100, o.ok ?? true, o.error ?? null, o.known ?? true]);

test('health usage totals respect day boundaries, environments and unmeasured calls, with redacted bounded output', async () => {
  const db = await fixtureDb();
  await db.exec(await readFile(new URL('../src/db/migrations/067_ai_usage_measured.sql', import.meta.url), 'utf8'));
  await usage(db, '2026-03-09T23:59:59Z', { prompt: 999 });
  await usage(db, '2026-03-10T00:00:00Z', { prompt: 100, cached: 40, completion: 50, reasoning: 20, ms: 200 });
  await usage(db, '2026-03-11T23:59:59Z', { prompt: 10, completion: 5, ms: 100, persona: 'athena' });
  await usage(db, '2026-03-11T12:00:00Z', { known: false, ok: false, error: 'SECRET failure detail', ms: 300 });
  await usage(db, '2026-03-12T00:00:00Z', { prompt: 777 });
  await usage(db, '2026-03-10T12:00:00Z', { env: 'dev', prompt: 555 });
  await db.query(`INSERT INTO sync_runs (id, claim_key, status, started_at, finished_at, results) VALUES
    ('00000000-0000-4000-8000-000000000001','k','partial','2026-03-11T01:00:00Z','2026-03-11T01:05:00Z','[{"source":"email","indexed":4,"errors":1,"durationMs":9,"error":"LEAK"}]')`);
  await db.query(`INSERT INTO content_items (source, indexed_at, relevance_explanation) VALUES
    ('discovered-article','2026-03-11T00:00:00Z',NULL),('discovered-article','2026-03-12T00:00:00Z','why'),('email','2026-03-10T00:00:00Z',NULL)`);

  const filters = parseHealthQuery({ from: '2026-03-10', to: '2026-03-11' }, new Date('2026-03-12T10:00:00Z'));
  const health = await getKnowledgeHealth(db as unknown as Pool, filters, new Date('2026-03-12T10:00:00Z'));
  assert.ok(health.usage.available);
  const { totals } = health.usage.data;
  assert.equal(totals.calls, 3);
  assert.equal(totals.measuredCalls, 2);
  assert.equal(totals.unmeasuredCalls, 1);
  assert.equal(totals.failures, 1);
  assert.equal(totals.promptTokens, 110);
  assert.equal(totals.cachedPromptTokens, 40);
  assert.equal(totals.completionTokens, 55);
  assert.equal(totals.reasoningCompletionTokens, 20);
  assert.equal(totals.totalTokens, 165);
  assert.equal(totals.avgLatencyMs, 200);
  assert.equal(health.windowEnd, '2026-03-12T00:00:00.000Z');
  assert.deepEqual(health.usage.data.facets.personas, ['athena']);

  const dev = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: '2026-03-10', to: '2026-03-11', environment: 'dev' }));
  assert.ok(dev.usage.available && dev.usage.data.totals.promptTokens === 555);
  const persona = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: '2026-03-10', to: '2026-03-11', persona: 'athena' }));
  assert.ok(persona.usage.available && persona.usage.data.totals.calls === 1);

  assert.ok(health.syncRuns.available && health.syncRuns.data.runs[0]?.sources[0]?.errors === 1);
  assert.ok(health.index.available);
  assert.deepEqual(health.index.data.scoring, { discoveredArticles: 2, unscored: 1 });
  const text = JSON.stringify(health);
  for (const secret of ['secret-session', 'SECRET failure detail', 'LEAK']) assert.ok(!text.includes(secret), `${secret} leaked`);
});

test('health validates ranges, isolates failing sections and is served by the route', async () => {
  assert.throws(() => parseHealthQuery({ from: '2026-01-01', to: '2026-06-01' }), /90 days/);
  assert.throws(() => parseHealthQuery({ from: '2026-02-30' }), /calendar/);
  assert.throws(() => parseHealthQuery({ environment: 'staging' }), /prod or dev/);
  assert.equal(parseHealthQuery({}, new Date('2026-03-12T10:00:00Z')).from, '2026-03-06');

  const db = await fixtureDb();
  await db.exec('DROP TABLE sync_runs');
  const query = mock.method(getDb(), 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  const app = express();
  app.use('/api/health', knowledgeHealthRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const ok = await fetch(`http://127.0.0.1:${address.port}/api/health/knowledge`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as { data: { usage: { available: boolean }; syncRuns: { available: boolean }; index: { available: boolean } } };
    assert.deepEqual([body.data.usage.available, body.data.syncRuns.available, body.data.index.available], [true, false, true]);
    const bad = await fetch(`http://127.0.0.1:${address.port}/api/health/knowledge?environment=x`);
    assert.equal(bad.status, 422);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    query.mock.restore();
    await db.close();
  }
});

test('UI-01 health reports per-family capability and measured counts, with unmeasured values as null', async () => {
  const db = await fixtureDb();
  await db.query(`INSERT INTO content_items (source, indexed_at, body) VALUES
    ('note','2026-03-10T00:00:00Z','text'),('note','2026-03-11T00:00:00Z',''),('github-doc','2026-03-09T00:00:00Z',$1)`, ['x'.repeat(8000)]);
  const health = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({}), new Date('2026-03-12T10:00:00Z'));
  assert.ok(health.families.available);
  const { families, semantic } = health.families.data;
  assert.deepEqual(families.map((f) => f.kind), KNOWLEDGE_FAMILIES.map((f) => f.kind));
  const note = families.find((f) => f.kind === 'note');
  assert.deepEqual(note?.counts, { eligible: null, indexed: 2, pending: null, failed: null });
  assert.deepEqual(note?.extraction, { fullText: 1, metadataOnly: 1, atIngestionCap: 0 });
  assert.equal(note?.state, 'unsupported-extraction');
  assert.equal(note?.lastIndexedAt, '2026-03-11T00:00:00.000Z');
  assert.equal(families.find((f) => f.kind === 'library-document')?.extraction?.atIngestionCap, 1);
  const live = families.find((f) => f.kind === 'project');
  assert.equal(live?.state, 'up-to-date');
  assert.equal(live?.counts.indexed, null);
  assert.equal(families.find((f) => f.kind === 'person')?.state, 'not-configured');
  assert.equal(semantic.state, 'not-configured');
  assert.equal(semantic.work.measured, false);
  assert.equal(health.families.data.decisionTablesMeasured, false);
  const mapped = new Set(families.flatMap((f) => f.sources));
  for (const source of Object.keys(CONTENT_SOURCE_DISPOSITIONS)) assert.ok(mapped.has(source), `${source} unmapped`);
});

test('AC-13 semantic status is never up to date from a provider connection alone, and failures surface safely', async () => {
  const unmeasured = { measured: false, pending: null, failed: null, done: null } as const;
  assert.equal(semanticStatus(true, unmeasured).state, 'coverage-not-measured');
  assert.equal(semanticStatus(false, { measured: true, pending: 0, failed: 0, done: 9 }).state, 'not-configured');
  assert.equal(semanticStatus(true, { measured: true, pending: 0, failed: 0, done: 0 }).state, 'coverage-not-measured');
  assert.equal(semanticStatus(true, { measured: true, pending: 3, failed: 0, done: 9 }).state, 'pending-work');
  assert.equal(semanticStatus(true, { measured: true, pending: 0, failed: 1, done: 9 }).state, 'temporarily-unavailable');
  assert.equal(semanticStatus(true, { measured: true, pending: 0, failed: 0, done: 9 }).state, 'up-to-date');

  const db = await fixtureDb();
  await db.exec(`CREATE TABLE knowledge_index_work (id SERIAL PRIMARY KEY, status TEXT NOT NULL, last_error TEXT)`);
  await db.exec(`INSERT INTO knowledge_index_work (status, last_error) VALUES ('done',NULL),('pending',NULL),('failed','SECRET prompt text')`);
  await db.query(`INSERT INTO content_items (source, indexed_at) VALUES ('email','2026-03-10T00:00:00Z')`);
  await db.query(`INSERT INTO sync_runs (id, claim_key, status, started_at, finished_at, results) VALUES
    ('00000000-0000-4000-8000-000000000002','k2','partial','2026-03-11T01:00:00Z','2026-03-11T01:05:00Z','[{"source":"email","indexed":1,"errors":2,"error":"LEAK"}]')`);
  const health = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({}), new Date(), { semanticConfigured: true, orchestrationEnabled: true });
  assert.ok(health.families.available);
  const { semantic, families, orchestrationEnabled } = health.families.data;
  assert.equal(orchestrationEnabled, true);
  assert.deepEqual([semantic.work.pending, semantic.work.failed, semantic.state], [1, 1, 'temporarily-unavailable']);
  const connected = families.find((f) => f.kind === 'connected-activity');
  assert.equal(connected?.state, 'temporarily-unavailable');
  assert.deepEqual(connected?.errorCategories, ['sync-errors']);
  const text = JSON.stringify(health.families);
  for (const secret of ['SECRET prompt text', 'LEAK']) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.ok(!text.includes('100%'));
});
