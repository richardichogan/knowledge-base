import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { FocusProject } from '../src/integrations/discovery/projectFit.js';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const {
  PROJECT_BOOST, PROJECT_PROTECT_BOOST, buildProjectFitPrompt, markSharedLink, markUserInterest, sharedLinkUrls, focusProjectsKey, loadFocusProjects, parseProjectFitResponse, projectBoost, saveProjectFit,
} = await import('../src/integrations/discovery/projectFit.js');
const { shelveStaleArticles, archiveAgedArticles } = await import('../src/integrations/discovery/feedSync.js');

const PROJECTS: FocusProject[] = [
  { id: 'imagine', name: 'IMAGINE', importance: 'high', brief: 'Agent-first claims platform on Azure' },
  { id: 'reckitt', name: 'Reckitt', importance: 'normal', brief: 'M365 Copilot rollout' },
];

test('boost favours direct fit to a high-importance project', () => {
  assert.equal(projectBoost([], PROJECTS), 0);
  assert.equal(projectBoost([{ projectId: 'imagine', name: 'IMAGINE', fit: 2, why: '' }], PROJECTS), PROJECT_BOOST.highDirect);
  assert.equal(projectBoost([{ projectId: 'imagine', name: 'IMAGINE', fit: 1, why: '' }], PROJECTS), PROJECT_BOOST.highRelated);
  assert.equal(projectBoost([
    { projectId: 'reckitt', name: 'Reckitt', fit: 2, why: '' },
    { projectId: 'imagine', name: 'IMAGINE', fit: 1, why: '' },
  ], PROJECTS), PROJECT_BOOST.normalDirect);
});

test('prompt lists projects and parsing ignores unknown keys, projects and fits', () => {
  const prompt = buildProjectFitPrompt(PROJECTS);
  assert.match(prompt, /id "imagine" — IMAGINE \(HIGH importance\)/);
  assert.match(prompt, /NOT an editorial judgement/);
  const keys = new Map([['a1', 'art-1'], ['a2', 'art-2']]);
  const parsed = parseProjectFitResponse('```json\n' + JSON.stringify({ results: [
    { key: 'a1', projects: [{ id: 'reckitt', fit: 1, why: 'x' }, { id: 'imagine', fit: 2, why: 'agent platform' }, { id: 'nope', fit: 2 }, { id: 'imagine', fit: 1 }] },
    { key: 'a2', projects: [{ id: 'reckitt', fit: 3 }] },
    { key: 'zz', projects: [{ id: 'imagine', fit: 2 }] },
  ] }) + '\n```', keys, PROJECTS);
  assert.deepEqual(parsed.get('art-1')?.map((f) => [f.projectId, f.fit]), [['imagine', 2], ['reckitt', 1]]);
  assert.deepEqual(parsed.get('art-2'), []);
  assert.equal(parsed.size, 2);
  assert.notEqual(focusProjectsKey(PROJECTS), focusProjectsKey([PROJECTS[0]!]));
});

test('focus projects, restore from shelved, and shelving protection', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE TABLE projects (id text, name text, importance text, priority text, category text, lifecycle_state text, goal text, description text, tags text[]);
      INSERT INTO projects VALUES
        ('imagine', 'IMAGINE', 'high', 'normal', 'work', 'active', 'Agent-first claims', null, '{azure}'),
        ('reckitt', 'Reckitt', 'normal', 'high', 'work', 'active', null, 'Copilot rollout', null),
        ('side', 'Side', 'normal', 'high', 'side-hustle', 'active', null, null, null),
        ('old', 'Old', 'high', 'high', 'work', 'archived', null, null, null);
      CREATE TABLE content_items (id text, source text, title text, body text, url text, project_context text, published_at timestamptz,
        indexed_at timestamptz, workflow_state text, relevance_score real, relevance_explanation text, metadata jsonb DEFAULT '{}'::jsonb);
      INSERT INTO content_items VALUES
        ('n1', 'note', 'Agent platform design', '', null, 'imagine', now(), now(), null, null, null, '{}'),
        ('a1', 'discovered-article', 'Agent-first platforms', '', 'https://x/a', 'msft-blog', now() - interval '20 days', now() - interval '20 days', 'shelved', 0.82, 'x', '{"shelvedReason":"stale","platform":"Archive","scoringVersion":2}'),
        ('a2', 'discovered-article', 'Old routine', '', 'https://x/b', 'msft-blog', now() - interval '20 days', now() - interval '20 days', 'to-review', 0.5, 'x', '{}'),
        ('a3', 'discovered-article', 'Imagine relevant', '', 'https://x/c', 'msft-blog', now() - interval '20 days', now() - interval '20 days', 'to-review', 0.5, 'x', '{"projectBoost":0.5,"platform":"Archive","scoringVersion":2}');
    `);
    const db = { query: async (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
    const projects = await loadFocusProjects(db);
    assert.deepEqual(projects.map((p) => p.id), ['imagine', 'reckitt']);
    assert.match(projects[0]!.brief, /Agent platform design/);

    await saveProjectFit(db, 'a1', [{ projectId: 'imagine', name: 'IMAGINE', fit: 2, why: 'agents' }], PROJECT_BOOST.highDirect, 'k');
    const a1 = (await pg.query<{ workflow_state: string; metadata: Record<string, unknown> }>(`SELECT workflow_state, metadata FROM content_items WHERE id = 'a1'`)).rows[0]!;
    assert.equal(a1.workflow_state, 'to-review');
    assert.equal(a1.metadata['restoredReason'], 'project');
    assert.equal(a1.metadata['projectFitKey'], 'k');

    await shelveStaleArticles(db);
    const states = Object.fromEntries((await pg.query<{ id: string; workflow_state: string }>(`SELECT id, workflow_state FROM content_items WHERE source = 'discovered-article'`)).rows.map((r) => [r.id, r.workflow_state]));
    assert.deepEqual(states, { a1: 'to-review', a2: 'to-review', a3: 'to-review' });
  } finally {
    await pg.close();
  }
});

test('age never shelves unseen recommendations; explicit low-value triage still respects restores and project protection', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE content_items (
      id text, source text, workflow_state text, relevance_score real,
      indexed_at timestamptz DEFAULT now()-interval '365 days', metadata jsonb);
      INSERT INTO content_items(id,source,workflow_state,relevance_score,metadata) VALUES
      ('good','discovered-article','to-review',0.74,'{"platform":"LinkedIn Standalone","scoringVersion":2}'),
      ('strong','discovered-article','to-review',0.95,'{"platform":"Full Blog Post","scoringVersion":2}'),
      ('low','discovered-article','to-review',0.2,'{"platform":"Archive","scoringVersion":2}'),
      ('restored','discovered-article','to-review',0.2,'{"platform":"Archive","scoringVersion":2,"restoredAt":"2025-01-01T00:00:00Z"}'),
      ('protected','discovered-article','to-review',0.2,'{"platform":"Archive","scoringVersion":2,"projectBoost":0.5}'),
      ('saved','discovered-article','saved',0.2,'{"platform":"Archive","scoringVersion":2}');
    `);
    const db = { query: async (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
    await shelveStaleArticles(db);
    const states = Object.fromEntries((await pg.query<{ id: string; workflow_state: string }>(
      'SELECT id,workflow_state FROM content_items')).rows.map(row => [row.id, row.workflow_state]));
    assert.deepEqual(states, { good: 'to-review', strong: 'to-review', low: 'shelved',
      restored: 'to-review', protected: 'to-review', saved: 'saved' });
  } finally { await pg.close(); }
});
test('archives unactioned articles after 14 days and low-value ones after 7, never saved, parked or live publishing sources', async () => {
  const pg = new PGlite();
  try {
    const low = '{"platform":"Archive","scoringVersion":2}';
    const good = '{"platform":"LinkedIn Standalone","scoringVersion":2}';
    await pg.exec(`CREATE TABLE content_items (id text, source text, workflow_state text, published_at timestamptz, created_at timestamptz DEFAULT now(), metadata jsonb);
      CREATE TABLE discover_parking (article_id text);
      CREATE TABLE publishing_topics (id text, state text);
      CREATE TABLE publishing_sources (item_id text, topic_id text);
      INSERT INTO content_items(id,source,workflow_state,published_at,metadata) VALUES
      ('low-8d','discovered-article','shelved',now()-interval '8 days','${low}'),
      ('low-5d','discovered-article','shelved',now()-interval '5 days','${low}'),
      ('good-10d','discovered-article','to-review',now()-interval '10 days','${good}'),
      ('good-15d','discovered-article','to-review',now()-interval '15 days','${good}'),
      ('protected-low-10d','discovered-article','to-review',now()-interval '10 days','{"platform":"Archive","scoringVersion":2,"projectBoost":0.5}'),
      ('saved-30d','discovered-article','saved',now()-interval '30 days','${good}'),
      ('parked-30d','discovered-article','to-review',now()-interval '30 days','${good}'),
      ('publishing-30d','discovered-article','to-review',now()-interval '30 days','${good}'),
      ('published-topic-30d','discovered-article','to-review',now()-interval '30 days','${good}'),
      ('note','note','to-review',now()-interval '30 days','{}');
      INSERT INTO discover_parking VALUES ('parked-30d');
      INSERT INTO publishing_topics VALUES ('live','ready'),('done','published');
      INSERT INTO publishing_sources VALUES ('publishing-30d','live'),('published-topic-30d','done');
    `);
    const db = { query: async (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
    assert.deepEqual(await archiveAgedArticles(db), { low: 1, aged: 2 });
    const rows = (await pg.query<{ id: string; workflow_state: string; metadata: Record<string, unknown> }>('SELECT id,workflow_state,metadata FROM content_items')).rows;
    const states = Object.fromEntries(rows.map(row => [row.id, row.workflow_state]));
    assert.deepEqual(states, { 'low-8d': 'archived', 'low-5d': 'shelved', 'good-10d': 'to-review', 'good-15d': 'archived',
      'protected-low-10d': 'to-review', 'saved-30d': 'saved', 'parked-30d': 'to-review', 'publishing-30d': 'to-review',
      'published-topic-30d': 'archived', note: 'to-review' });
    assert.equal(rows.find(row => row.id === 'good-15d')?.metadata['autoArchived'], true);
  } finally { await pg.close(); }
});

test('shared links are read from both share formats', () => {
  assert.deepEqual(sharedLinkUrls('[Shared link]\nTitle: T\nURL: https://x.test/a?utm=1\n\nThe user has shared https://ignored.test'), ['https://x.test/a?utm=1']);
  assert.deepEqual(sharedLinkUrls('[Shared from Android]\nTitle: T\nDescription: https://x.test/b/\n\nThe user has shared a link'), ['https://x.test/b/']);
  assert.deepEqual(sharedLinkUrls('please read https://x.test/c'), []);
});

test('sharing or noting an article restores it and the fit pass keeps that signal', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE TABLE content_items (id text, source text, title text, url text, workflow_state text, metadata jsonb DEFAULT '{}'::jsonb);
      INSERT INTO content_items VALUES
        ('s1', 'discovered-article', 'Agent-first', 'https://Azure.test/blog/agent-first/', 'shelved', '{"shelvedReason":"stale"}'),
        ('s2', 'discovered-article', 'Manual shelf', 'https://x.test/manual', 'shelved', '{"shelvedReason":"manual"}'),
        ('s3', 'discovered-article', 'Other', 'https://x.test/other', 'shelved', '{"shelvedReason":"stale"}');
    `);
    const db = { query: async (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
    const row = async (id: string) => (await pg.query<{ workflow_state: string; metadata: Record<string, unknown> }>(`SELECT workflow_state, metadata FROM content_items WHERE id = $1`, [id])).rows[0]!;

    assert.equal(await markSharedLink(db, '[Shared from Android]\nTitle: Agent-first\nDescription: https://azure.test/blog/agent-first/?wt.mc_id=x\n\nThe user has shared a link.'), 1);
    let s1 = await row('s1');
    assert.equal(s1.workflow_state, 'to-review');
    assert.equal(s1.metadata['restoredReason'], 'share');
    assert.equal(Number(s1.metadata['projectBoost']), PROJECT_PROTECT_BOOST);

    await saveProjectFit(db, 's1', [], 0, 'k');
    s1 = await row('s1');
    assert.equal(Number(s1.metadata['projectBoost']), PROJECT_PROTECT_BOOST, 'fit pass must not wipe the share boost');

    assert.equal(await markUserInterest(db, ['https://x.test/manual'], {
      reason: 'note', noteId: 'n9', boost: PROJECT_BOOST.highDirect, fit: { projectId: 'imagine', name: 'IMAGINE', fit: 2, why: 'note' },
    }), 1);
    await saveProjectFit(db, 's2', [{ projectId: 'imagine', name: 'IMAGINE', fit: 1, why: 'llm' }, { projectId: 'reckitt', name: 'Reckitt', fit: 1, why: 'llm' }], 0.08, 'k');
    const s2 = await row('s2');
    assert.equal(s2.workflow_state, 'to-review');
    assert.deepEqual(s2.metadata['linkedNoteIds'], ['n9']);
    assert.deepEqual((s2.metadata['projectFit'] as { projectId: string; why: string }[]).map((f) => [f.projectId, f.why]), [['imagine', 'note'], ['reckitt', 'llm']]);
    assert.equal((await row('s3')).workflow_state, 'shelved');
  } finally {
    await pg.close();
  }
});
