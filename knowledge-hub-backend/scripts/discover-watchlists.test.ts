import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { discoverMonitoringRouter } from '../src/routes/discoverWatchlists.js';
import { discoverRouter } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { getToolDefinitions, executeToolCall } from '../src/ai/chatTools.js';
import { listWatchlists, saveWatchlist, runWatchlist, watchlistHistory, parseWatchlist, parseWatchAnalysis,
  evidenceGroups, runDueWatchlists, retrieveWatchlistRecords, matchesEntity, analyzeWatchEvidence } from '../src/services/discoverWatchlists.js';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { saveInterestWeight, parseInterestWeight } from '../src/services/discoverInterests.js';
import type { WatchlistInput, WatchFinding, WatchRun, Watchlist } from '../src/types/watchlists.js';

const sourceId = '11111111-1111-4111-8111-111111111111';
const articleId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const thirdId = '44444444-4444-4444-8444-444444444444';
const config = (): WatchlistInput => ({
  name: 'User configured monitoring', description: 'An explicit test purpose',
  question: 'Does the new capability challenge our user-defined proposition?', searchContext: '',
  entities: [{ name: 'Example Product', relationship: 'competitor' }],
  criteria: ['Availability', 'Target buyer'], baseline: { text: 'CONFIDENTIAL baseline proposition', links: ['https://app.example/think?noteId=mine'] },
  sourceIds: [sourceId], projectIds: ['project-a'], cadence: 'weekly', paused: false,
});
const finding = (id = articleId): WatchFinding => ({
  entity: 'Example Product', criterion: 'Availability', kind: 'announced-capability', changed: 'Newly observed product announcement',
  matters: 'Challenges an assumption in the private baseline.', uncertainty: 'An announcement does not establish general availability.',
  response: 'Validate documentation before changing our proposition.', evidenceIds: [id],
});
const enrichedFinding = (): WatchFinding => ({
  ...finding(), headline: 'Managed claims agents announced',
  field: 'Claims processing', microsoftInvolvement: 'Not established in the collected sources',
  projectImpact: 'Specific claims capability intersection; availability unconfirmed.',
  evidenceHighlight: { text: 'The announcement describes managed claims agents.', evidenceIds: [articleId] },
  watchNext: { statement: 'Whether supporting documentation establishes availability.', evidenceIds: [articleId] },
  projectAssessments: [{ projectId: 'project-a', projectName: 'IMAGINE', relevance: 'medium',
    impact: 'Claims agents intersect with the saved claims-processing goal; delivery remains unconfirmed.' }],
});
async function fixture(): Promise<{ pg: PGlite; db: Pool }> {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', goal TEXT DEFAULT '',
      role TEXT DEFAULT '', ownership TEXT DEFAULT '', lifecycle_state TEXT DEFAULT 'active', start_date DATE, target_end_date DATE,
      importance TEXT DEFAULT 'high', priority TEXT DEFAULT 'high', category TEXT DEFAULT '', project_type TEXT DEFAULT '',
      expected_outputs JSONB DEFAULT '[]', links JSONB DEFAULT '[]', gitlab_paths JSONB DEFAULT '[]',
      github_repos JSONB DEFAULT '[]', tags JSONB DEFAULT '[]', has_ica_document_collection BOOLEAN DEFAULT false,
      ica_document_collection_name TEXT DEFAULT '', ica_document_collection_id TEXT DEFAULT '');
    INSERT INTO projects(id,name,description) VALUES ('project-a','IMAGINE','Claims processing with grounded agents');
    CREATE TABLE discovery_sources(id UUID PRIMARY KEY,title TEXT,last_success_at TIMESTAMPTZ,is_active BOOLEAN,last_error TEXT);
    INSERT INTO discovery_sources VALUES ('${sourceId}','Test source',NOW(),true,NULL);
    CREATE TABLE content_items(id UUID PRIMARY KEY,source TEXT,source_id TEXT,title TEXT,body TEXT,url TEXT,
      published_at TIMESTAMPTZ,indexed_at TIMESTAMPTZ DEFAULT NOW(),metadata JSONB DEFAULT '{}',
      workflow_state TEXT DEFAULT 'to-review',relevance_score REAL,relevance_explanation TEXT,
      summary TEXT DEFAULT '',project_context TEXT,tags TEXT[] DEFAULT '{}');
    CREATE TABLE discover_item_tags(discover_item_id UUID,tag_id UUID);`);
  const migration = await readFile(new URL('../src/db/migrations/083_discover_watchlists.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  await pg.exec(migration);
  await pg.exec(await readFile(new URL('../src/db/migrations/087_discover_parking.sql', import.meta.url), 'utf8'));
  return { pg, db: pg as unknown as Pool };
}
async function article(pg: PGlite, id = articleId, title = 'Example Product announces managed agents', body = 'Example Product announced a capability. Availability is not documented.'): Promise<void> {
  await pg.query(`INSERT INTO content_items(id,source,source_id,title,body,url,published_at,relevance_score,relevance_explanation,metadata)
    VALUES($1::uuid,'discovered-article',$1::text,$2,$3,$4,date_trunc('hour',NOW())-INTERVAL '1 hour',0.8,'Useful evidence',$5)`, [
    id, title, body, `https://news.example/${id}`, JSON.stringify({ sourceId, sourceTitle: 'Test source' }),
  ]);
}

test('watchlist inputs require explicit user choices and strict bounded typed analysis', () => {
  assert.deepEqual(parseWatchlist(config()), config());
  assert.equal(parseWatchlist({ ...config(), baseline: { text: '', links: [] }, sourceIds: [] }).baseline.text, '');
  for (const patch of [{ entities: [] }, { criteria: [] },
    { cadence: 'hourly' }, { paused: 'false' }, { entities: [{ name: 'a', relationship: 'invented' }] },
    { baseline: { text: 'Private', links: ['javascript:alert(1)'] } }]) {
    assert.throws(() => parseWatchlist({ ...config(), ...patch }));
  }
  assert.equal(matchesEntity('Example Product announces', 'Example Product'), true);
  assert.equal(matchesEntity('SuperExample Productive', 'Example Product'), false);
  const evidence = evidenceGroups([{ id: articleId, title: 'Example Product announces agents', body: 'Public statement', url: 'https://example.com/news',
    published_at: new Date(), metadata: {} }], config());
  assert.equal(parseWatchAnalysis(JSON.stringify({ summary: 'Evidence backed', findings: [finding()] }), config(), evidence).findings.length, 1);
  for (const kind of ['positioning', 'announced-capability', 'documented-availability', 'customer-outcome']) {
    assert.equal(parseWatchAnalysis(JSON.stringify({ summary: 'Evidence backed', findings: [{ ...finding(), kind }] }), config(), evidence).findings[0]?.kind, kind);
  }
  for (const patch of [{ evidenceIds: [secondId] }, { evidenceIds: [] }, { entity: 'Invented' },
    { criterion: 'Invented' }, { kind: 'generally-available' }, { uncertainty: '' }]) {
    assert.throws(() => parseWatchAnalysis(JSON.stringify({ summary: 'Unsupported', findings: [{ ...finding(), ...patch }] }), config(), evidence));
  }
  for (const value of [-1, 2.1, NaN, Infinity, '2']) assert.throws(() => parseInterestWeight({ kind: 'topic', term: 'AI', weight: value }));
});

test('focused findings require structured fields and validate grounded project identities and relationships', () => {
  const evidence = evidenceGroups([{ id: articleId, title: 'Example Product announces agents', body: 'Public statement',
    url: 'https://example.com/news', published_at: new Date(), metadata: {} }], config());
  const projects = [{ id: 'project-a', name: 'IMAGINE', information: 'Claims agents', sources: [] }];
  const focused = { ...finding(), field: 'Claims processing', microsoftInvolvement: 'Not established in the collected sources',
    projectImpact: 'Potential overlap with IMAGINE', projectAssessments: [{ projectId: 'project-a', projectName: 'Invented name',
      relationship: 'possible-relevance', impact: 'Potential overlap in claims processing; deployment details not established.' }] };
  const parse = (value: unknown) => parseWatchAnalysis(JSON.stringify({ summary: 'Supported assessment', findings: [value] }), config(), evidence, true, projects);
  assert.equal(parse(focused).findings[0]?.projectAssessments?.[0]?.projectName, 'IMAGINE', 'Canonical saved name wins');
  assert.throws(() => parse(finding()), /project assessments/);
  assert.throws(() => parse({ ...focused, field: '' }), /activity field/);
  assert.throws(() => parse({ ...focused, projectAssessments: [{ ...focused.projectAssessments[0], projectId: 'invented' }] }), /Unsupported/);
  assert.throws(() => parse({ ...focused, projectAssessments: [{ ...focused.projectAssessments[0], relationship: 'high-risk' }] }), /Unsupported/);
  assert.throws(() => parse({ ...focused, projectAssessments: [...focused.projectAssessments, ...focused.projectAssessments] }), /duplicate/);
  assert.equal(parse({ ...focused, projectAssessments: [] }).findings[0]?.projectAssessments?.length, 0);
  assert.equal(parseWatchAnalysis(JSON.stringify({ summary: 'Legacy', findings: [finding()] }), config(), evidence).findings[0]?.projectAssessments, undefined);
});

test('intelligence fields preserve five impact meanings and require bounded finding-specific citations', () => {
  const evidence = evidenceGroups([{ id: articleId, title: 'Example Product announces agents', body: 'Public statement',
    url: 'https://example.com/news', published_at: new Date(), metadata: {} }], config());
  evidence.push({ ...evidence[0]!, id: secondId });
  const projects = [{ id: 'project-a', name: 'IMAGINE', information: 'Claims agents', sources: [] }];
  const parse = (value: unknown, enriched = true) => parseWatchAnalysis(JSON.stringify({ summary: 'Claims capability announced; availability is unconfirmed.', findings: [value] }),
    config(), evidence, true, projects, enriched).findings[0]!;
  for (const relevance of ['high', 'medium', 'low', 'no-material-impact', 'insufficient-evidence']) {
    const f = enrichedFinding();
    const result = parse({ ...f, projectAssessments: [{ ...f.projectAssessments![0], projectName: 'Spoofed', relevance }] });
    assert.equal(result.projectAssessments?.[0]?.relevance, relevance);
    assert.equal(result.projectAssessments?.[0]?.projectName, 'IMAGINE');
    assert.equal(result.projectAssessments?.[0]?.relationship, undefined, 'Do not invent overlap certainty for a relevance assessment');
    assert.deepEqual(result.evidenceHighlight, f.evidenceHighlight);
    assert.deepEqual(result.watchNext, f.watchNext);
  }
  for (const patch of [
    { headline: '' }, { headline: 'x'.repeat(161) }, { evidenceHighlight: undefined },
    { evidenceHighlight: { text: 'Unsupported source', evidenceIds: [secondId] } },
    { evidenceHighlight: { text: 'x'.repeat(501), evidenceIds: [articleId] } },
    { watchNext: { statement: 'Unsupported watch', evidenceIds: [] } },
    { watchNext: { statement: 'Unsupported watch', evidenceIds: [secondId] } },
    { projectAssessments: [{ projectId: 'project-a', relevance: 'very-high', impact: 'Invalid enum' }] },
    { projectAssessments: [] },
  ]) assert.throws(() => parse({ ...enrichedFinding(), ...patch }));
  assert.equal(parse({ ...enrichedFinding(), watchNext: undefined }).watchNext, undefined);
  assert.throws(() => parse({ ...enrichedFinding(), projectAssessments: [{ projectId: 'project-a', impact: 'No state' }] }, false));
  assert.equal(parseWatchAnalysis(JSON.stringify({ summary: 'No meaningful change.', findings: [] }), config(), evidence, true, projects, true).findings.length, 0);
  const moreProjects = [...projects, { ...projects[0]!, id: 'project-b', name: 'Other project' }];
  assert.equal(parseWatchAnalysis(JSON.stringify({ summary: 'Grounded synthesis', findings: [enrichedFinding(), {
    ...enrichedFinding(), projectAssessments: [{ projectId: 'project-b', projectName: 'Other project', relevance: 'no-material-impact',
      impact: 'Different documented goals and workflow, with no material intersection identified.' }],
  }] }), config(), evidence, true, moreProjects, true).findings.length, 2, 'Assess projects once across the report, not on every finding');
});

test('the existing single analysis call generates concise grounded intelligence without a new pipeline or budget increase', async () => {
  const evidence = evidenceGroups([{ id: articleId, title: 'Example Product announces agents', body: 'Public statement',
    url: 'https://example.com/news', published_at: new Date(), metadata: {} }], config());
  const projects = [{ id: 'project-a', name: 'IMAGINE', information: 'Private claims context', sources: [] }];
  const chat = mock.method(FoundryClient.prototype, 'chat', async (model, messages, budget) => {
    assert.equal(model, 'standard');
    assert.equal(budget, 7000);
    assert.match(messages[0]!.content, /Observation in this review is NOT proof of publication\/event recency/);
    assert.match(messages[0]!.content, /never predictions/);
    assert.match(messages[0]!.content, /Never use low or no-material-impact for missing information/);
    assert.match(messages[1]!.content, /Private claims context/);
    return JSON.stringify({ summary: 'Claims agents announced; availability remains unconfirmed.', findings: [enrichedFinding()] });
  });
  try {
    const result = await analyzeWatchEvidence(config(), evidence, [], projects);
    assert.equal(result.findings[0]?.headline, enrichedFinding().headline);
    assert.equal(chat.mock.callCount(), 1);
  } finally { chat.mock.restore(); }
});

test('an omitted project assessment gets one validated correction, never fabricated defaults or unlimited retries', async () => {
  const evidence = evidenceGroups([{ id: articleId, title: 'Example Product announces agents', body: 'Public statement',
    url: 'https://example.com/news', published_at: new Date(), metadata: {} }], config());
  const projects = [
    { id: 'project-a', name: 'IMAGINE', information: 'Private claims context', sources: [] },
    { id: 'project-b', name: 'Other work', information: 'Limited context', sources: [] },
  ];
  const incomplete = JSON.stringify({ summary: 'Supported development.', findings: [enrichedFinding()] });
  const correctedFinding = { ...enrichedFinding(), projectAssessments: [...enrichedFinding().projectAssessments!, {
    projectId: 'project-b', projectName: 'Other work', relevance: 'insufficient-evidence',
    impact: 'The supplied context does not establish the goals needed for a material impact assessment.',
  }] };
  for (const correction of [
    JSON.stringify({ summary: 'Supported development.', findings: [correctedFinding] }),
    incomplete,
    JSON.stringify({ summary: 'Unsupported.', findings: [{ ...correctedFinding, evidenceIds: ['invented'] }] }),
    JSON.stringify({ summary: 'Unsupported.', findings: [] }),
  ]) {
    let calls = 0;
    const chat = mock.method(FoundryClient.prototype, 'chat', async (_model, messages) => {
      calls++;
      if (calls === 1) return incomplete;
      assert.match(messages[messages.length - 1]!.content, /project-b/);
      assert.match(messages[messages.length - 1]!.content, /Do not invent/);
      return correction;
    });
    try {
      if (correction.includes('Unsupported.') || correction === incomplete) {
        await assert.rejects(analyzeWatchEvidence(config(), evidence, [], projects));
      } else {
        const result = await analyzeWatchEvidence(config(), evidence, [], projects);
        assert.equal(result.findings[0]?.projectAssessments?.length, 2);
        assert.equal(result.findings[0]?.projectAssessments?.[1]?.relevance, 'insufficient-evidence');
      }
      assert.equal(calls, 2, 'Only one correction request is allowed');
    } finally { chat.mock.restore(); }
  }
  const chat = mock.method(FoundryClient.prototype, 'chat', async () => '{invalid JSON');
  try {
    await assert.rejects(analyzeWatchEvidence(config(), evidence, [], projects), SyntaxError);
    assert.equal(chat.mock.callCount(), 1, 'Unrelated failures are not retried by this correction');
  } finally { chat.mock.restore(); }
});

test('monitoring project context does not fan out database queries across active projects', async () => {
  const { pg, db } = await fixture();
  try {
    await article(pg);
    await pg.exec(`INSERT INTO projects(id,name) VALUES ('project-b','Second project'),('project-c','Third project')`);
    const w = await saveWatchlist(db, { ...config(), projectIds: [] });
    const original = pg.query.bind(pg);
    let active = 0;
    let peak = 0;
    const query = mock.method(pg, 'query', async (sql, params) => {
      active++;
      peak = Math.max(peak, active);
      try { return await original(sql, params); }
      finally { active--; }
    });
    try {
      const run = await runWatchlist(db, w.id, false, async (_config, _evidence, _previous, projects) => {
        assert.equal(projects?.length, 3, 'All active projects still reach analysis');
        return { summary: 'Supported observation.', findings: [finding()] };
      });
      assert.equal(run.status, 'changes');
      assert.equal(peak, 1, 'One Watchlist must not open a burst of parallel database connections');
    } finally { query.mock.restore(); }
  } finally { await pg.close(); }
});

test('versioned baseline edits are atomic, optimistic and private; historical runs retain original question and baseline', async () => {
  const { pg, db } = await fixture();
  try {
    await article(pg);
    const initial = await saveWatchlist(db, config());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = runWatchlist(db, initial.id, false, async (_config, _evidence, _previous, projects) => {
      assert.equal(projects?.[0]?.name, 'IMAGINE');
      assert.match(projects?.[0]?.information ?? '', /Claims processing/);
      entered(); await gate;
      return { summary: 'Supported new observation', findings: [{ ...enrichedFinding(), projectAssessments: [{
        projectId: 'project-a', projectName: 'IMAGINE', relationship: 'possible-relevance', impact: 'Potential claims overlap',
        relevance: 'medium', watchNext: 'Whether public delivery documentation establishes the deployment model.',
      }] }] };
    });
    await started;
    await assert.rejects(runWatchlist(db, initial.id, false, async () => { throw new Error('Must not reach analyzer'); }), /already running/);
    const updated = await saveWatchlist(db, { ...config(), question: 'A revised question', baseline: { text: 'CONFIDENTIAL revised baseline', links: [] } }, initial.id, initial.revision);
    assert.equal(updated.baselineVersion, 2);
    assert.equal(updated.revision, 2);
    await assert.rejects(saveWatchlist(db, config(), initial.id, initial.revision), /changed elsewhere/);
    release();
    const run = await pending;
    assert.equal(run.status, 'changes');
    assert.equal(run.baselineVersion, 1);
    assert.equal(run.baseline.text, config().baseline.text);
    assert.equal(run.config.question, config().question);
    assert.equal(run.findings[0]?.evidenceIds[0], articleId);
    const history = await watchlistHistory(db, initial.id);
    assert.equal(history[0]?.baselineVersion, 1);
    assert.equal(history[0]?.findings[0]?.projectAssessments?.[0]?.projectName, 'IMAGINE', 'Structured project implications survive persistence');
    assert.equal(history[0]?.findings[0]?.projectAssessments?.[0]?.relevance, 'medium');
    assert.deepEqual(history[0]?.findings[0]?.evidenceHighlight, enrichedFinding().evidenceHighlight);
    assert.deepEqual(history[0]?.findings[0]?.watchNext, enrichedFinding().watchNext);
    assert.equal((await pg.query('SELECT * FROM discover_watchlist_baselines')).rows.length, 2);
    assert.ok(Date.parse((await listWatchlists(db))[0]!.nextRunAt) <= Date.now(), 'finishing an old-config run must not defer the newly edited question for a week');
    const publicRows = (await pg.query<{ title: string; body: string; metadata: unknown }>('SELECT title,body,metadata FROM content_items')).rows;
    assert.ok(!JSON.stringify(publicRows).includes('CONFIDENTIAL'));
    const unchanged = await saveWatchlist(db, updated.config, initial.id, updated.revision);
    assert.equal(unchanged.baselineVersion, 2, 'non-baseline edit does not create a duplicate baseline');
    const saved = await retrieveWatchlistRecords(db, { watchlistId: initial.id, from: '2000-01-01', to: '2099-01-01' }) as { runs: WatchRun[] };
    assert.equal(saved.runs[0]?.evidence[0]?.url, `https://news.example/${articleId}`);
    assert.equal(saved.runs[0]?.findings[0]?.headline, enrichedFinding().headline, 'Existing knowledge retrieval keeps structured intelligence');
  } finally { await pg.close(); }
});

test('syndicated events count once; no meaningful change differs from missing coverage; errors never leak', async () => {
  const { pg, db } = await fixture();
  try {
    await article(pg);
    await article(pg, secondId);
    const w = await saveWatchlist(db, config());
    const quiet = await runWatchlist(db, w.id, false, async (_config, evidence) => {
      assert.equal(evidence.length, 1);
      assert.deepEqual(evidence[0]?.syndicatedIds, [secondId]);
      return { summary: 'Only repeated positioning; no material difference against the baseline.', findings: [] };
    });
    assert.equal(quiet.status, 'no_meaningful_change');
    assert.equal(quiet.coverage.uniqueEvents, 1);
    assert.equal(quiet.coverage.matched, 2);
    assert.match(quiet.summary, /No meaningful change/);
    await pg.query(`UPDATE discover_watchlist_runs SET started_at=NOW()-INTERVAL '2 days' WHERE id=$1`, [quiet.id]);
    await pg.query('UPDATE discovery_sources SET last_error=$1', ['Sensitive remote error']);
    const missing = await runWatchlist(db, w.id, false, async () => ({ summary: 'Partial evidence only.', findings: [] }));
    assert.equal(missing.status, 'insufficient_coverage');
    assert.equal(missing.coverage.sourcesHealthy, 0);
    assert.ok(!missing.summary.includes('Sensitive remote'));
    await pg.query('UPDATE discovery_sources SET last_error=NULL,last_success_at=NOW()');
    const failed = await runWatchlist(db, w.id, false, async () => { throw new Error('SECRET API credential detail'); });
    assert.equal(failed.status, 'failed');
    assert.ok(!JSON.stringify(failed).includes('SECRET'));
    assert.equal(failed.findings.length, 0);
    await pg.query('DELETE FROM content_items');
    const noCoverage = await runWatchlist(db, w.id, false, async () => { throw new Error('No model call when no evidence'); });
    assert.equal(noCoverage.status, 'no_meaningful_change', 'quiet week with checked sources and prior comparable coverage is valid');
    const newQuestion = await saveWatchlist(db, { ...config(), baseline: { text: 'New explicit baseline', links: [] } }, w.id, w.revision);
    const unobserved = await runWatchlist(db, w.id, false, async () => { throw new Error('No evidence'); });
    assert.equal(unobserved.status, 'insufficient_coverage', 'without a comparable covered baseline, missing evidence is not no change');
    assert.deepEqual(unobserved.coverage.missingEntities, ['Example Product']);
    const paused = await saveWatchlist(db, { ...newQuestion.config, paused: true }, w.id, newQuestion.revision);
    await assert.rejects(runWatchlist(db, paused.id), /paused/);
    await runDueWatchlists(db);
    assert.equal((await watchlistHistory(db, w.id)).length, 5);
  } finally { await pg.close(); }
});

test('claim recovery prevents stale workers saving findings and scheduled runs respect due/paused state', async () => {
  const { pg, db } = await fixture();
  try {
    const w = await saveWatchlist(db, config());
    await runDueWatchlists(db);
    assert.equal((await watchlistHistory(db, w.id))[0]?.status, 'insufficient_coverage');
    await runDueWatchlists(db);
    assert.equal((await watchlistHistory(db, w.id)).length, 1, 'not due twice');
    await pg.query(`INSERT INTO discover_watchlist_runs(watchlist_id,baseline_version,config,started_at,window_start,status)
      VALUES($1,1,$2,NOW()-INTERVAL '11 minutes',NOW()-INTERVAL '7 days','running')`, [w.id, JSON.stringify(config())]);
    await runWatchlist(db, w.id);
    const history = await watchlistHistory(db, w.id);
    assert.equal(history.filter(r => r.status === 'failed').length, 1);
    assert.equal(history.filter(r => r.status === 'running').length, 0);
  } finally { await pg.close(); }
});

test('authenticated API surface validates revisions and retrieves durable data, weights rerank server-side and explain filtered articles', async () => {
  const { pg, db } = await fixture();
  const query = mock.method(getDb(), 'query', (sql: string, values?: unknown[]) => pg.query(sql, values));
  const app = express();
  app.use(express.json());
  app.use('/api/discover', discoverMonitoringRouter, discoverRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/discover`;
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, body: await response.json() as { success: boolean; data: unknown } };
  };
  try {
    await article(pg);
    await article(pg, thirdId, 'Unrelated market story', 'Unrelated announcement.');
    const created = await request('/watchlists', 'POST', config());
    assert.equal(created.response.status, 201);
    const w = created.body.data as Watchlist;
    assert.equal((await request('/watchlists')).response.status, 200);
    assert.equal((await request('/watchlists/not-a-uuid/run', 'POST')).response.status, 422);
    assert.equal((await request(`/watchlists/${w.id}`, 'PUT', { ...config(), revision: 500 })).response.status, 409);
    assert.equal((await request('/watchlists', 'POST', { ...config(), projectIds: ['missing'] })).response.status, 422);
    const ranking = async () => (await request('/')).body.data as { items: Array<{ id: string; rankScore: number; pickReasons: string[]; filteredReason: string }>; total: number };
    assert.equal((await ranking()).items[0]?.id, articleId);
    await saveInterestWeight(db, { kind: 'topic', term: 'unrelated', weight: 2 });
    const boosted = await ranking();
    assert.equal(boosted.items[0]?.id, thirdId, 'server-side weight changes rank before pagination');
    assert.ok(boosted.items[0]?.pickReasons.some(r => r.includes('unrelated')));
    await request('/interests', 'PUT', { kind: 'topic', term: 'unrelated', weight: 0 });
    assert.equal((await ranking()).items.length, 1);
    const filtered = (await request('/?filtered=true')).body.data as Awaited<ReturnType<typeof ranking>>;
    assert.equal(filtered.items[0]?.id, thirdId);
    assert.match(filtered.items[0]!.filteredReason, /topic/);
    const secondBrowser = (await request('/interests')).body.data as unknown[];
    assert.equal(secondBrowser.length, 1, 'weights live on the server, not localStorage');
    await request('/interests', 'PUT', { kind: 'source', term: 'Test source', weight: 0 });
    assert.equal((await ranking()).total, 0);
    assert.equal((await request('/interests', 'PUT', { kind: 'topic', term: 'x', weight: 3 })).response.status, 422);
    await pg.query(`UPDATE content_items SET workflow_state='saved' WHERE id=$1`, [thirdId]);
    await request('/interests', 'PUT', { kind: 'source', term: 'Test source', weight: 1 });
    assert.ok((await ranking()).items[0]!.pickReasons.some(r => r.includes('previously saved')));
    const tools = await getToolDefinitions();
    assert.ok(tools.some(t => t.function.name === 'get_discover_watchlist_records'));
    const result = await executeToolCall(db, 'get_discover_watchlist_records', JSON.stringify({ watchlistId: w.id }));
    assert.ok(JSON.stringify(result).includes(w.id));
    assert.equal((await listWatchlists(db)).length, 1);
    await assert.rejects(retrieveWatchlistRecords(db, { watchlistId: w.id, from: '2026-02-31' }), /valid YYYY-MM-DD/);
    await assert.rejects(retrieveWatchlistRecords(db, { watchlistId: w.id, from: '2026-12-31', to: '2026-01-01' }), /precede/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    query.mock.restore();
    await pg.close();
  }
});
