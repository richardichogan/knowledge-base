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
import { aiFailureCode, withAiStage, withAiWorkflow } from '../src/ai/aiWorkflow.js';
import { backgroundWorkContextBlock } from '../src/ai/agentTools.js';
import type { Pool } from 'pg';

async function fixtureDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of ['054_ai_usage_log.sql', '065_runtime_runs.sql', '067_ai_usage_measured.sql']) {
    await db.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await db.exec('CREATE TABLE agent_jobs(id UUID PRIMARY KEY)');
  await db.exec(await readFile(new URL('../src/db/migrations/117_ai_workflow_attribution.sql', import.meta.url), 'utf8'));
  await db.exec('CREATE TABLE athena_memories(scope_type TEXT, origin TEXT)');
  for (const file of ['140_ai_learning_ledger.sql', '145_ai_workflow_failure_diagnostics.sql']) {
    await db.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await db.exec('CREATE TABLE ai_chat_sessions(id UUID PRIMARY KEY); CREATE TABLE ai_chat_messages(id BIGSERIAL PRIMARY KEY, content TEXT)');
  await db.exec('CREATE TABLE athena_feedback(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID, rating TEXT NOT NULL, reply_excerpt TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const file of ['134_ai_turn_traces.sql', '135_health_measurements.sql']) {
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

test('workflow health separates completion from review and preserves unknown legacy attribution', async () => {
  const db = await fixtureDb();
  try {
    const id = '00000000-0000-4000-8000-000000000008';
    await db.query(`INSERT INTO ai_workflow_runs(id,environment,feature,purpose,attempt,status,outcome,started_at,finished_at)
      VALUES($1,'prod','blog-writer','diagnostic',2,'completed','review-blocked','2026-03-10T01:00:00Z','2026-03-10T01:00:05Z')`, [id]);
    await usage(db, '2026-03-10T01:00:01Z', { prompt: 100, completion: 20 });
    await db.query("UPDATE ai_usage_log SET workflow_run_id=$1,stage='review',purpose='diagnostic'", [id]);
    await usage(db, '2026-03-10T02:00:00Z', { known: false });
    const health = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: '2026-03-10', to: '2026-03-10' }));
    assert.ok(health.workflows.available);
    assert.deepEqual(health.workflows.data.totals, { runs: 1, completed: 1, failed: 0, unfinished: 0, reviewBlocked: 1, delivered: 0 });
    assert.equal(health.workflows.data.attributedCalls, 1);
    assert.equal(health.workflows.data.unattributedCalls, 1);
    assert.equal(health.workflows.data.runs[0]?.tokens, 120);
    assert.equal(health.workflows.data.runs[0]?.durationMs, 5000);
    assert.equal(health.workflows.data.stages[0]?.stage, 'review');
    const filtered = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: '2026-03-10', to: '2026-03-10', deployment: 'other' }));
    assert.ok(filtered.workflows.available);
    assert.equal(filtered.workflows.data.totals.runs, 0);
  } finally { await db.close(); }
});

test('partial vision reads stay distinct across usage, reliability and stage diagnostics', async () => {
  const db = await fixtureDb();
  try {
    const id = '00000000-0000-4000-8000-000000000041';
    await db.query(`INSERT INTO ai_workflow_runs(id,environment,feature,purpose,attempt,started_at,status)
      VALUES($1,'prod','image-description','diagnostic',1,'2026-03-10T01:00:00Z','completed')`, [id]);
    await usage(db, '2026-03-10T01:00:01Z', { feature: 'image-description', ok: false, error: 'Vision response was truncated' });
    await usage(db, '2026-03-10T01:00:02Z', { feature: 'image-description', ok: false, error: 'SECRET actual failure' });
    await usage(db, '2026-03-10T01:00:03Z', { feature: 'image-description' });
    await usage(db, '2026-03-09T01:00:00Z', { feature: 'chat', ok: false, error: 'Vision response was truncated' });
    await db.query("UPDATE ai_usage_log SET workflow_run_id=$1,stage='read'", [id]);
    await db.exec(await readFile(new URL('../src/db/migrations/145_ai_workflow_failure_diagnostics.sql', import.meta.url), 'utf8'));
    const legacy = await db.query<{ failure_code: string | null }>("SELECT failure_code FROM ai_usage_log WHERE feature='chat'");
    assert.equal(legacy.rows[0]?.failure_code, null, 'backfill must not infer categories outside the known vision emitters');
    const report = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: '2026-03-10', to: '2026-03-10' }));
    assert.ok(report.usage.available && report.reliability.available && report.workflows.available);
    assert.equal(report.usage.data.totals.calls, 3);
    assert.equal(report.usage.data.totals.failures, 1);
    assert.equal(report.usage.data.totals.partialCalls, 1);
    assert.equal(report.usage.data.rows[0]?.partialCalls, 1);
    assert.deepEqual(report.reliability.data.daily, [{ day: '2026-03-10', calls: 3, failures: 1, partialCalls: 1 }]);
    assert.deepEqual(report.reliability.data.features, [{ feature: 'image-description', calls: 3, failures: 1, partialCalls: 1 }]);
    assert.equal(report.workflows.data.stages[0]?.failures, 1);
    assert.equal(report.workflows.data.stages[0]?.partialCalls, 1);
    assert.ok(report.workflows.data.failureDiagnostics.some(row => row.code === 'response-truncated' && row.status === 'partial'));
    assert.equal(JSON.stringify(report).includes('SECRET'), false);
  } finally { await db.close(); }
});

test('source failures remain visible under their workflow feature before any model call', async () => {
  const db = await fixtureDb();
  try {
    await db.query(`INSERT INTO ai_workflow_runs(id,environment,feature,purpose,attempt,started_at,status,failure_stage,failure_code)
      VALUES('00000000-0000-4000-8000-000000000042','prod','discovery-editorial-assessment','diagnostic',1,
        '2026-03-10T01:00:00Z','failed','source-reading','source-forbidden')`);
    const report = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({
      from: '2026-03-10', to: '2026-03-10', feature: 'discovery-editorial-assessment',
    }));
    assert.ok(report.workflows.available);
    assert.equal(report.workflows.data.totals.failed, 1);
    assert.equal(report.workflows.data.failureDiagnostics[0]?.code, 'source-forbidden');
    assert.equal(report.workflows.data.failureDiagnostics[0]?.stage, 'source-reading');
  } finally { await db.close(); }
});

test('workflow attribution follows the escaping error, not an earlier recovered error', async () => {
  const db = await fixtureDb();
  try {
    await assert.rejects(withAiWorkflow(db as unknown as Pool, { feature: 'stage-regression' }, async () => {
      try { await withAiStage('recovered', async () => { throw new Error('recovered'); }); } catch { /* intentional recovery */ }
      await withAiStage('outer', () => withAiStage('actual-failure', async () => { throw new Error('final'); }));
    }), /final/);
    const failed = await db.query<{ failure_stage: string; failure_code: string }>('SELECT failure_stage,failure_code FROM ai_workflow_runs');
    assert.equal(failed.rows[0]?.failure_stage, 'actual-failure');
    assert.equal(failed.rows[0]?.failure_code, 'operation-error');
    await withAiWorkflow(db as unknown as Pool, { feature: 'recovered-run' }, async () => {
      try { await withAiStage('recovered', async () => { throw new Error('recovered'); }); } catch { /* intentional recovery */ }
    });
    const succeeded = await db.query(`SELECT status,failure_stage,failure_code FROM ai_workflow_runs WHERE feature='recovered-run'`);
    assert.deepEqual(succeeded.rows[0], { status: 'completed', failure_stage: null, failure_code: null });
    assert.equal(aiFailureCode(new DOMException('Stopped', 'AbortError')), 'cancelled');
    assert.equal(aiFailureCode(new DOMException('Timed out', 'TimeoutError')), 'timeout');
  } finally { await db.close(); }
});

test('artifact outcomes report recorded actions, runtime and linkage without exposing content or inventing acceptance', async () => {
  const db = await fixtureDb();
  try {
    await db.query(`INSERT INTO ai_authored_content(id,at,environment,agent,target_type,target_id,content) VALUES
      ('00000000-0000-4000-8000-000000000043','2026-03-10T01:00:00Z','prod','athena','note','one','SECRET generated content'),
      ('00000000-0000-4000-8000-000000000044','2026-03-10T01:00:00Z','dev','athena','note','two','SECRET dev content')`);
    await db.query(`INSERT INTO ai_decisions(at,updated_at,environment,agent,kind,target_type,target_id,authored_id,final_content) VALUES
      ('2026-03-10T02:00:00Z','2026-03-10T02:00:00Z','prod','athena','edit','note','one','00000000-0000-4000-8000-000000000043','SECRET user edit'),
      ('2026-03-10T03:00:00Z','2026-03-10T03:00:00Z','prod','athena','approve','note','one','00000000-0000-4000-8000-000000000043',NULL),
      ('2026-03-10T04:00:00Z','2026-03-10T04:00:00Z','dev','athena','reject','note','two',NULL,NULL)`);
    const report = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: '2026-03-10', to: '2026-03-10' }));
    assert.ok(report.artifactOutcomes.available);
    assert.equal(report.artifactOutcomes.data.generatedVersions, 1);
    assert.equal(report.artifactOutcomes.data.generatedTargets, 1);
    assert.equal(report.artifactOutcomes.data.editedVersions, 1);
    assert.deepEqual(report.artifactOutcomes.data.decisions, [
      { kind: 'approve', targetType: 'note', events: 1, targets: 1, linkedEvents: 1 },
      { kind: 'edit', targetType: 'note', events: 1, targets: 1, linkedEvents: 1 },
    ]);
    assert.equal(JSON.stringify(report).includes('SECRET'), false);
    const filtered = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ feature: 'chat' }));
    assert.equal(filtered.artifactOutcomes.available, false);
  } finally { await db.close(); }
});

test('background work context is bounded and keeps stable retrieval identities without accepting arbitrary fields', () => {
  const context = { panelOpen: true, activeCount: 1, unreadCount: 1, incomplete: false, truncated: false,
    items: [{ id: 'one', jobId: '00000000-0000-4000-8000-000000000045', subjectId: 'import-source',
      title: 'Import', status: 'Completed', unread: true, summary: 'Saved', secret: 'NOT_ALLOWED' }] };
  const block = backgroundWorkContextBlock(context);
  assert.match(block, /check_specialist_jobs/);
  assert.match(block, /00000000-0000-4000-8000-000000000045/);
  assert.equal(block.includes('NOT_ALLOWED'), false);
  assert.equal(backgroundWorkContextBlock(undefined), '');
  assert.match(backgroundWorkContextBlock({ ...context, activeFilter: 'information' }), /"activeFilter":"information"/);
  assert.throws(() => backgroundWorkContextBlock({ ...context, activeFilter: 'unknown' }), /Invalid updates filter/);
  assert.throws(() => backgroundWorkContextBlock({ ...context, unreadCount: -1 }), /Invalid background work/);
  assert.throws(() => backgroundWorkContextBlock({ ...context, items: Array(11).fill(context.items[0]) }), /Invalid background work/);
  assert.throws(() => backgroundWorkContextBlock({ ...context, items: [{ ...context.items[0], jobId: 'bad-id' }] }), /identifier/);
});

test('measurement coverage separates missing capture, unfinished work, runtime and unreviewed content', async () => {
  const db = await fixtureDb();
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    await db.query(`INSERT INTO ai_turn_measurements(id,environment,persona,status,trace_started,capture_complete,signals)
      VALUES ('00000000-0000-4000-8000-000000000011','prod','general','completed',true,true,
        '{"contextObserved":true,"pageContentSupplied":true,"completeReads":0,"partialReads":1,"replySaved":true,"modelErrors":0,"toolErrors":1,"transportRetries":2}'),
      ('00000000-0000-4000-8000-000000000012','prod','general','failed',false,false,NULL),
      ('00000000-0000-4000-8000-000000000013','prod','general','running',false,false,NULL),
      ('00000000-0000-4000-8000-000000000014','dev','general','completed',true,true,NULL)`);
    const health = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: day, to: day, environment: 'prod' }), now);
    assert.ok(health.measurements.available);
    const data = health.measurements.data;
    assert.equal(data.accepted, 3);
    assert.equal(data.finished, 2);
    assert.equal(data.captureComplete, 1);
    assert.equal(data.missingTraces, 1);
    assert.equal(data.unfinished, 1);
    assert.equal(data.completedAfterErrors, 1);
    assert.equal(data.partialReadTurns, 1);
    assert.equal(data.correctness, 'unreviewed');
    assert.equal(data.evaluated.unreviewed, 2);
    const filtered = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: day, to: day, deployment: 'gpt-a' }), now);
    assert.equal(filtered.measurements.available, false, 'unknown per-deployment denominator must not show zero');
    await db.exec('DROP TABLE ai_turn_measurements');
    const missing = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ from: day, to: day }), now);
    assert.equal(missing.measurements.available, false);
    assert.equal(missing.usage.available, true);
  } finally { await db.close(); }
});

test('source history excludes the other runtime and explicitly preserves unknown legacy provenance', async () => {
  const db = await fixtureDb();
  try {
    await db.query(`INSERT INTO sync_runs(id,status,environment) VALUES
      ('00000000-0000-4000-8000-000000000021','succeeded','prod'),
      ('00000000-0000-4000-8000-000000000022','succeeded','dev'),
      ('00000000-0000-4000-8000-000000000023','succeeded',NULL)`);
    const health = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({ environment: 'prod' }));
    assert.ok(health.syncRuns.available);
    assert.deepEqual(health.syncRuns.data.runs.map(run => run.environment).sort(), ['prod', null].sort());
  } finally { await db.close(); }
});

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
  assert.equal(families.find((f) => f.kind === 'library-document')?.extraction?.atIngestionCap, 0,
    'a complete 8,000-character repo document is not an ingestion truncation');
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
  await db.exec(`CREATE TABLE knowledge_indexing_work (id SERIAL PRIMARY KEY, ref_kind TEXT NOT NULL DEFAULT 'content_item', ref_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error_code TEXT)`);
  await db.exec(`INSERT INTO knowledge_indexing_work (ref_id, status, error_code) VALUES ('1','done',NULL),('2','pending',NULL),('3','leased',NULL),('4','failed','SECRET prompt text')`);
  await db.query(`INSERT INTO content_items (source, indexed_at) VALUES ('email','2026-03-10T00:00:00Z')`);
  await db.query(`INSERT INTO sync_runs (id, claim_key, status, started_at, finished_at, results) VALUES
    ('00000000-0000-4000-8000-000000000002','k2','partial','2026-03-11T01:00:00Z','2026-03-11T01:05:00Z','[{"source":"graph-mail","indexed":1,"errors":2,"error":"LEAK"},{"source":"ica-collections","indexed":0,"errors":1},{"source":"project-docs","indexed":1,"errors":1}]')`);
  const health = await getKnowledgeHealth(db as unknown as Pool, parseHealthQuery({}), new Date(), { semanticConfigured: true, orchestrationEnabled: true });
  assert.ok(health.families.available);
  const { semantic, families, orchestrationEnabled } = health.families.data;
  assert.equal(orchestrationEnabled, true);
  assert.deepEqual([semantic.work.pending, semantic.work.failed, semantic.state], [2, 1, 'temporarily-unavailable']);
  assert.equal(health.families.data.decisionTablesMeasured, false);
  const connected = families.find((f) => f.kind === 'connected-activity');
  assert.equal(connected?.state, 'temporarily-unavailable');
  assert.deepEqual(connected?.errorCategories, ['sync-errors']);
  assert.equal(families.find(f => f.kind === 'library-document')?.state, 'temporarily-unavailable');
  const text = JSON.stringify(health.families);
  for (const secret of ['SECRET prompt text', 'LEAK']) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.ok(!text.includes('100%'));
});
