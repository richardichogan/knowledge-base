import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { FocusProject } from '../src/integrations/discovery/projectFit.js';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const {
  PROJECT_BOOST, buildProjectFitPrompt, focusProjectsKey, loadFocusProjects, parseProjectFitResponse, projectBoost, saveProjectFit,
} = await import('../src/integrations/discovery/projectFit.js');
const { shelveStaleArticles } = await import('../src/integrations/discovery/feedSync.js');

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
    assert.deepEqual(states, { a1: 'to-review', a2: 'shelved', a3: 'to-review' });
  } finally {
    await pg.close();
  }
});
