import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdmission } from '../src/services/knowledge/admission.js';
import {
  createDbSearchBackends, reciprocalRankFusion, searchKnowledge, type SearchBackends, type SearchRecord,
} from '../src/services/knowledge/search.js';
import { insertContent, phase2Db } from './knowledge-phase2-fixture.js';

const rec = (id: string, o: Partial<SearchRecord> = {}): SearchRecord => ({
  id, source: 'note', sourceId: id, title: `Title ${id}`, summary: `Summary ${id}`, body: `Body text for ${id}`,
  projectContext: 'personal', publishedAt: '2026-10-01T00:00:00.000Z', url: null, metadata: {}, ...o,
});
const backends = (o: Partial<SearchBackends> = {}): SearchBackends => ({
  exact: async () => [], lexical: async () => [], semantic: async () => [], ...o,
});

test('SRC-01 exact identity/path matches come first regardless of fused rank', async () => {
  const result = await searchKnowledge({ query: 'docs/plan.md' }, backends({
    exact: async () => [rec('exact', { metadata: { path: 'docs/plan.md' } })],
    lexical: async () => [rec('a'), rec('b'), rec('exact')],
  }));
  assert.equal(result.hits[0]!.ref.id, 'exact');
  assert.equal(result.hits[0]!.matchKind, 'exact');
});

test('SRC-02 reciprocal rank fusion (k=60) is applied before the 20-record cap', async () => {
  assert.equal(reciprocalRankFusion([['a', 'b'], ['b']]).get('b'), 1 / 62 + 1 / 61);
  const lex = Array.from({ length: 40 }, (_, i) => rec(`l${i}`));
  const sem = Array.from({ length: 40 }, (_, i) => rec(i === 30 ? 'l29' : `s${i}`));
  const result = await searchKnowledge({ query: 'x' }, backends({ lexical: async () => [...lex, rec('l-extra')], semantic: async () => sem }));
  assert.equal(result.hits.length, 20);
  // l29 is rank 30 in both lists; fusion lifts it above every single-list rank 2+ item.
  assert.ok(result.hits.findIndex(h => h.ref.id === 'l29') < 2);
  assert.equal(result.hits.find(h => h.ref.id === 'l29')!.matchKind, 'both');
  assert.ok(!result.hits.some(h => h.ref.id === 'l-extra'));
});

test('SRC-03 a slow backend is aborted at the timeout and the result is partial', async () => {
  let aborted = false;
  const started = Date.now();
  const result = await searchKnowledge({ query: 'x', timeoutMs: 40 }, backends({
    lexical: async () => [rec('a')],
    semantic: (_q, _n, signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); }),
  }));
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.issues, ['semantic_unavailable']);
  assert.equal(result.hits.length, 1);
});

test('SRC-04 both backends failing is unavailable, never an empty success', async () => {
  const boom = async (): Promise<SearchRecord[]> => { throw new Error('down'); };
  const both = await searchKnowledge({ query: 'x' }, backends({ lexical: boom, semantic: boom }));
  assert.equal(both.status, 'unavailable');
  const lexOnlyConfigured = await searchKnowledge({ query: 'x' }, { exact: async () => [], lexical: boom });
  assert.equal(lexOnlyConfigured.status, 'unavailable');
  const noSemantic = await searchKnowledge({ query: 'x' }, { exact: async () => [], lexical: async () => [] });
  assert.equal(noSemantic.status, 'ok');
  assert.deepEqual(noSemantic.issues, ['semantic_not_configured']);
});

test('SRC-05 canonical duplicates collapse into one hit', async () => {
  const gh = (id: string, source: string) => rec(id, { source, metadata: { repo: 'Org/Repo', path: 'Docs/A.md' } });
  const result = await searchKnowledge({ query: 'x' }, backends({
    lexical: async () => [gh('g1', 'github-doc'), gh('g2', 'github-content-store'), rec('n1', { sourceId: 'note-1' }), rec('n2', { sourceId: 'note-1' })],
  }));
  assert.deepEqual(result.hits.map(h => h.ref.id), ['g1', 'n1']);
  assert.deepEqual(result.hits[0]!.duplicates, ['g2']);
});

test('SRC-06 project preference only breaks exact rank ties', async () => {
  const result = await searchKnowledge({ query: 'x', projectId: 'p1' }, backends({
    lexical: async () => [rec('other-1', { projectContext: 'p2' }), rec('mine-2', { projectContext: 'p1' })],
    semantic: async () => [],
  }));
  assert.equal(result.hits[0]!.ref.id, 'other-1');
  const tie = await searchKnowledge({ query: 'x', projectId: 'p1' }, backends({
    lexical: async () => [rec('other', { projectContext: 'p2' })],
    semantic: async () => [rec('mine', { projectContext: 'p1' })],
  }));
  assert.deepEqual(tie.hits.map(h => h.ref.id), ['mine', 'other']);
});

test('SRC-07 strict project scope reveals nothing outside the project', async () => {
  const result = await searchKnowledge({ query: 'x', projectId: 'p1', projectScope: 'only' }, backends({
    lexical: async () => [rec('other', { projectContext: 'p2' }), rec('mine', { projectContext: 'p1' })],
  }));
  assert.deepEqual(result.hits.map(h => h.ref.id), ['mine']);
});

test('SRC-08 hits carry snippet, version, match kind, extraction status and read ref', async () => {
  const body = `${'filler '.repeat(80)}the quarterly budget approval is pending`;
  const result = await searchKnowledge({ query: 'budget approval' }, backends({
    lexical: async () => [rec('a', { body }), rec('b', { body: '', metadata: { extractionStatus: 'partial' } }), rec('c', { body: '' })],
  }));
  const [a, b, c] = result.hits;
  assert.ok(a!.snippet.includes('budget approval'));
  assert.equal(a!.matchKind, 'lexical');
  assert.equal(a!.extractionStatus, 'full');
  assert.deepEqual(a!.readRef, { kind: 'content_item', id: 'a', version: a!.version });
  assert.equal(b!.extractionStatus, 'partial');
  assert.equal(c!.extractionStatus, 'metadata_only');
  assert.notEqual(a!.version, b!.version);
});

test('SRC-09 duplicate exact titles return a disambiguation list', async () => {
  const result = await searchKnowledge({ query: 'Roadmap' }, backends({
    exact: async () => [rec('r1', { title: 'Roadmap', projectContext: 'p1', metadata: { path: 'a/roadmap.md' } }),
      rec('r2', { title: 'Roadmap', projectContext: 'p2', metadata: { path: 'b/roadmap.md' } })],
  }));
  assert.deepEqual(result.disambiguation?.map(d => [d.id, d.projectId, d.path]), [['r1', 'p1', 'a/roadmap.md'], ['r2', 'p2', 'b/roadmap.md']]);
});

test('SRC-10 exclusion filtering fails closed', async () => {
  const lexical = async () => [rec('a'), rec('hidden')];
  const filtered = await searchKnowledge({ query: 'x' }, backends({ lexical, filterVisible: async ids => new Set(ids.filter(i => i !== 'hidden')) }));
  assert.deepEqual(filtered.hits.map(h => h.ref.id), ['a']);
  const failed = await searchKnowledge({ query: 'x' }, backends({ lexical, filterVisible: async () => { throw new Error('x'); } }));
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.hits.length, 0);
  assert.ok(failed.issues.includes('exclusion_unavailable'));
});

test('SRC-11 default Postgres backends: OR terms, all-term boost, noisy-source weight, canonical filter', async () => {
  const db = await phase2Db();
  await insertContent(db, { sourceId: 'n1', title: 'Budget approval process', body: 'how budget approval works' });
  await insertContent(db, { sourceId: 'n2', title: 'Budget notes', body: 'only one term' });
  await insertContent(db, { source: 'github-commit', sourceId: 'c1', title: 'Budget approval commit', body: 'budget approval' });
  await insertContent(db, { source: 'github-doc', sourceId: 'g1', title: 'Budget approval mirror', body: 'budget approval',
    metadata: { repo: 'o/r', path: 'a.md' } });
  await db.query(`INSERT INTO note_github_publications (repo, path) VALUES ('o/r', 'a.md')`);
  const result = await searchKnowledge({ query: 'budget approval' }, createDbSearchBackends({ db, admission: createAdmission() }));
  const titles = result.hits.map(h => h.title);
  assert.deepEqual(titles, ['Budget approval process', 'Budget approval commit', 'Budget notes']);
  assert.equal(result.status, 'ok');
  const exact = await searchKnowledge({ query: 'budget notes' }, createDbSearchBackends({ db, admission: createAdmission() }));
  assert.equal(exact.hits[0]!.matchKind === 'exact' || exact.hits[0]!.title === 'Budget notes', true);
  assert.equal(exact.hits[0]!.title, 'Budget notes');
});

test('SRC-12 semantic ids hydrate only live canonical rows and keep rank order', async () => {
  const db = await phase2Db();
  const a = await insertContent(db, { sourceId: 'a', title: 'A' });
  const b = await insertContent(db, { sourceId: 'b', title: 'B' });
  const result = await searchKnowledge({ query: 'paraphrase' }, createDbSearchBackends({
    db, admission: createAdmission(), retrieveIds: async () => [b, '00000000-0000-4000-8000-000000000000', a],
  }));
  assert.deepEqual(result.hits.map(h => h.title), ['B', 'A']);
  assert.ok(result.hits.every(h => h.matchKind === 'semantic'));
});

test('SRC-13 empty queries and oversized limits are bounded', async () => {
  const many = Array.from({ length: 60 }, (_, i) => rec(`m${i}`));
  assert.equal((await searchKnowledge({ query: '   ' }, backends())).hits.length, 0);
  assert.equal((await searchKnowledge({ query: 'x', limit: 500 }, backends({ lexical: async () => many }))).hits.length, 20);
});

test('PERF-02 admission caps in-flight retrieval at 2 per turn and 4 per process', async () => {
  const admission = createAdmission();
  let inFlight = 0;
  let peak = 0;
  const turnPeaks = new Map<string, { now: number; max: number }>();
  const dbFor = (turnId: string) => ({
    query: async () => {
      const t = turnPeaks.get(turnId)!;
      inFlight += 1; peak = Math.max(peak, inFlight);
      t.now += 1; t.max = Math.max(t.max, t.now);
      await new Promise(r => setTimeout(r, 15));
      inFlight -= 1; t.now -= 1;
      return { rows: [] };
    },
  });
  const { admitQueries } = await import('../src/services/knowledge/admission.js');
  const work = ['t1', 't2', 't3'].flatMap(turnId => {
    turnPeaks.set(turnId, { now: 0, max: 0 });
    const q = admitQueries(dbFor(turnId), { kind: 'turn', turnId }, { admission });
    return Array.from({ length: 6 }, () => q.query('select 1'));
  });
  await Promise.all(work);
  assert.equal(peak, 4);
  assert.ok([...turnPeaks.values()].every(t => t.max <= 2));
  assert.equal(admission.stats().retrievalMaxInFlight <= 4, true);
  assert.equal(admission.stats().maxInFlightPerTurn <= 2, true);
  assert.equal(admission.stats().retrievalInFlight, 0);
});

test('PERF-03 the index worker is limited to one in-flight query and never blocks on retrieval slots', async () => {
  const admission = createAdmission();
  let inFlight = 0;
  let peak = 0;
  const db = { query: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 10)); inFlight -= 1; return { rows: [] }; } };
  const { admitQueries } = await import('../src/services/knowledge/admission.js');
  const q = admitQueries(db, { kind: 'index' }, { admission });
  await Promise.all(Array.from({ length: 5 }, () => q.query('select 1')));
  assert.equal(peak, 1);
  assert.equal(admission.stats().indexMaxInFlight, 1);
  const controller = new AbortController();
  const hold = admission.run({ kind: 'index' }, () => new Promise(r => setTimeout(r, 30)));
  const waiting = admission.run({ kind: 'index' }, async () => 1, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  await hold;
});
