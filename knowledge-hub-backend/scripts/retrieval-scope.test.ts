import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createRetrievalAudit, flagDeferredRecovery, resolveRetrievalScope, resolveSearchFilter } from '../src/ai/knowledge/retrievalScope.js';
import { executeToolCall } from '../src/ai/chatTools.js';
import { createDbSearchBackends, searchKnowledge } from '../src/services/knowledge/search.js';
import { createAdmission } from '../src/services/knowledge/admission.js';
import { insertContent, phase2Db } from './knowledge-phase2-fixture.js';
import { upsertContentItem } from '../src/db/queries.js';

const now = new Date('2026-10-24T05:15:00Z');

test('historical collection requests map to meanings, not words in their titles', () => {
  // Source: bounded, read-only review of Richard's recent Athena requests.
  const cases = [
    ['any interesting items in the discovery log?', ['discover-article'], 'search_knowledge_base'],
    ['any interesting items in Discover?', ['discover-article'], 'search_knowledge_base'],
    ['any interesting items in the Discover feed?', ['discover-article'], 'search_knowledge_base'],
    ['what is new in discovery today?', ['discover-article'], 'search_knowledge_base'],
    ['woudl you recomend any additional sources to include for the article discovery fucntionality?', ['discover-source'], 'get_discover_sources'],
    ['show me the saved watchlists in Discover', ['watchlist'], 'get_discover_watchlist_records'],
    ['Can you compare to the turnaround use case that is in the library?', ['library-document'], 'search_knowledge_base'],
    ['Can you see the latest note I added?', ['note'], 'search_knowledge_base'],
    ['review the latest diagram in think', ['canvas'], 'search_diagrams'],
    ['What decisions did we record about RTR?', ['decision'], 'review_decisions'],
    ['What did we discuss in earlier chats?', ['chat'], 'search_past_chats'],
    ['Show overdue tasks', ['task'], 'list_tasks'],
    ['What is new?', ['connected-activity'], 'search_knowledge_base'],
    ['Find emails from yesterday', ['email'], 'search_knowledge_base'],
    ['Discover articles, not notes', ['discover-article'], 'search_knowledge_base'],
  ] as const;
  for (const [query, families, tool] of cases) {
    const scope = resolveRetrievalScope(query, [], now);
    assert.deepEqual(scope?.families, families, query);
    assert.equal(scope?.tool, tool, query);
  }
  for (const query of ['who are you?', 'do you have a personality?', 'create a Think note from this article',
    'is this worth formalising in some of the discover, think, build, publish cycle?', 'rewrite this note',
    'what is the latest on project imagine', 'what is on my diary today?', 'Summarise this note', 'Critique this diagram',
    'Compare this note with the current spec']) {
    assert.equal(resolveRetrievalScope(query, [], now), undefined, query);
  }
});

test('corrections retain user scope, never inherit an assistant invention or cross a topic switch', () => {
  const history = [
    { role: 'user' as const, content: 'any interesting items in the discovery log?' },
    { role: 'assistant' as const, content: 'I read the LOGGING notes. Shall I search the Library?' },
  ];
  assert.deepEqual(resolveRetrievalScope('shall we try that again', history, now)?.filter.sources, ['discovered-article']);
  assert.equal(resolveRetrievalScope('try again', [{ role: 'assistant', content: 'Discover' }], now), undefined);
  assert.deepEqual(resolveRetrievalScope('instead look in the library', history, now)?.families, ['library-document']);
  assert.equal(resolveRetrievalScope('try again', [...history, { role: 'user', content: 'Who are you?' }], now), undefined);
  assert.equal(resolveRetrievalScope('[Viewing note: "Discover strategy"]\nWho are you?', history, now), undefined);
  assert.deepEqual(resolveRetrievalScope('compare Discover articles with my notes', [], now)?.filter.sources, ['discovered-article', 'note']);
  assert.deepEqual(resolveRetrievalScope('compare this note with Discover articles', [], now)?.families, ['discover-article']);
  assert.deepEqual(resolveRetrievalScope('compare this note with other notes', [], now)?.families, ['note']);
  const retry = resolveRetrievalScope('try again', history, now);
  assert.equal(flagDeferredRecovery(retry, "If you want, I'll check the actual Discover records."), true);
  assert.equal(flagDeferredRecovery(retry, 'I checked Discover; here are the results.'), false);
  const refinedHistory = [
    { role: 'user' as const, content: 'Discover articles discovered today, including archived' },
    { role: 'user' as const, content: 'only saved, published yesterday' },
  ];
  const refinedRetry = resolveRetrievalScope('try again', refinedHistory, now)!;
  assert.deepEqual(refinedRetry.filter.states, ['saved']);
  assert.equal(refinedRetry.filter.dateField, 'published');
  assert.equal(refinedRetry.filter.within?.startUtc, '2026-10-22T23:00:00.000Z');
  assert.deepEqual(resolveRetrievalScope('including archived', history, now)?.filter.states, ['to-review', 'archived']);
  assert.equal(resolveRetrievalScope('last 3 days', history, now)?.filter.within?.startUtc, '2026-10-21T05:15:00.000Z');
});

test('interesting is not recent; dates, source activity and first discovery have distinct meanings', () => {
  const scope = resolveRetrievalScope('any interesting items in the discovery log?', [], now)!;
  assert.equal(scope.filter.within, undefined);
  assert.deepEqual(scope.filter.states, ['to-review']);
  const newest = resolveRetrievalScope('latest items in Discover', [], now)!;
  assert.equal(newest.timeDefaulted, true);
  assert.equal(newest.filter.within?.startUtc, '2026-10-17T05:15:00.000Z');
  const yesterday = resolveRetrievalScope('articles discovered yesterday in Discover', [], now)!;
  assert.equal(yesterday.filter.dateField, 'discovered');
  assert.equal(yesterday.filter.within?.startUtc, '2026-10-22T23:00:00.000Z');
  assert.equal(yesterday.filter.within?.endUtc, '2026-10-23T23:00:00.000Z');
  const dst = resolveRetrievalScope('Discover yesterday', [], new Date('2026-10-26T12:00:00Z'))!;
  assert.equal(dst.filter.within?.startUtc, '2026-10-24T23:00:00.000Z');
  assert.equal(dst.filter.within?.endUtc, '2026-10-26T00:00:00.000Z');
  assert.equal(resolveRetrievalScope('Show archived Discover items', [], now)?.filter.states?.[0], 'archived');
  assert.deepEqual(resolveRetrievalScope('Discover articles published yesterday', [], now)?.filter.states, ['to-review']);
  assert.deepEqual(resolveRetrievalScope('Discover, not archived', [], now)?.filter.states, ['to-review']);
  assert.deepEqual(resolveRetrievalScope('Discover including archived', [], now)?.filter.states, ['to-review', 'archived']);
  assert.equal(resolveRetrievalScope('Discover parking lot', [], now)?.filter.parkedOnly, true);
  assert.equal(resolveRetrievalScope('Discover from 2026-10-01 to 2026-10-10', [], now)?.filter.within?.endUtc, '2026-10-10T00:00:00.000Z');
  const history = [{ role: 'user' as const, content: 'Discover yesterday' }];
  assert.equal(resolveRetrievalScope('what about the last 3 days', history, now)?.filter.within?.startUtc, '2026-10-21T05:15:00.000Z');
  assert.equal(resolveRetrievalScope('what about all time', history, now)?.filter.within, undefined);
});

test('model filters can narrow, never erase explicit user constraints', () => {
  const scope = resolveRetrievalScope('Discover today', [], now)!;
  assert.deepEqual(resolveSearchFilter({ sources: ['note'] }, scope, now).sources, []);
  assert.deepEqual(resolveSearchFilter({ states: ['archived'] }, scope, now).states, []);
  const filter = resolveSearchFilter({ within: { start: '2026-01-01', end: '2027-01-01' }, dateField: 'discovered' }, scope, now);
  assert.deepEqual(filter.within, scope.filter.within === undefined ? undefined : {
    ...scope.filter.within, kind: 'explicit', timezone: 'UTC', startLocalDate: '2026-10-23', endLocalDate: '2026-10-24',
  });
  assert.equal(filter.dateField, 'published');
  assert.throws(() => resolveSearchFilter({ sources: ['made-up'] }, scope), /recognised/);
  assert.throws(() => resolveSearchFilter({ within: { period: 'some time' } }, scope), /unbounded/);
  assert.throws(() => resolveSearchFilter({ within: { start: '2020-01-01', end: '2020-02-01' } }, scope), /overlap/);
  assert.throws(() => resolveSearchFilter({ within: { start: '2026-02-30', end: '2026-03-05' } }), /real ISO/);
});

test('SQL scopes precede candidate caps, including exact/semantic hydration, visibility and workflow state', async () => {
  const db = await phase2Db();
  try {
    await db.exec("ALTER TABLE content_items ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'to-review'; CREATE TABLE discover_parking(article_id uuid)");
    for (let i = 0; i < 45; i++) await insertContent(db, { sourceId: `noise-${i}`, title: 'log log log', body: 'log log log' });
    const old = await insertContent(db, { source: 'discovered-article', sourceId: 'old', title: 'log', publishedAt: '2026-01-01',
      metadata: { discoveredAt: '2026-10-24T01:00:00Z' } });
    const good = await insertContent(db, { source: 'discovered-article', sourceId: 'fresh', title: 'log', publishedAt: '2026-10-24T01:00:00Z' });
    const end = await insertContent(db, { source: 'discovered-article', sourceId: 'end', title: 'log', publishedAt: '2026-10-24T23:00:00Z' });
    const archived = await insertContent(db, { source: 'discovered-article', sourceId: 'hidden', title: 'log', publishedAt: '2026-10-24T02:00:00Z' });
    await db.query("UPDATE content_items SET workflow_state='archived' WHERE id=$1", [archived]);
    const fallback = await insertContent(db, { source: 'discovered-article', sourceId: 'fallback', title: 'log',
      publishedAt: '2026-10-24T03:00:00Z', metadata: { publicationDateKnown: false } });
    const scope = resolveRetrievalScope('Discover today', [], now)!;
    const run = (query: string, filter = scope.filter, excludedIds?: ReadonlySet<string>) => searchKnowledge({ query, filter },
      createDbSearchBackends({ db, admission: createAdmission(), filter, ...(excludedIds !== undefined && { excludedIds }),
        retrieveIds: async () => [old, archived, fallback, end, good] }));
    assert.deepEqual((await run('log')).hits.map(hit => hit.ref.id), [good]);
    assert.deepEqual((await run('')).hits.map(hit => hit.ref.id), [good]);
    assert.equal((await run('log', scope.filter, new Set([good]))).hits.length, 0);
    const discovered = { ...scope.filter, dateField: 'discovered' as const };
    assert.deepEqual((await run('', discovered)).hits.map(hit => hit.ref.id), [old]);
    await db.query('INSERT INTO discover_parking VALUES ($1)', [good]);
    assert.deepEqual((await run('', { ...scope.filter, parkedOnly: true })).hits.map(hit => hit.ref.id), [good]);
  } finally { await db.close(); }
});

test('actual tool dispatch rejects cross-collection reads and searches without touching another collection', async () => {
  const db = new Pool();
  try {
    const scope = resolveRetrievalScope('Discover today', [], now)!;
    const audit = createRetrievalAudit(scope);
    const result = await executeToolCall(db, 'search_library', '{"query":"log"}', undefined, { retrievalScope: scope, retrievalAudit: audit });
    assert.equal((result as { code: string }).code, 'scope_mismatch');
    assert.equal(audit.blockedCalls, 1);
    const excluded = await executeToolCall(db, 'search_knowledge_base', '{"query":""}', undefined,
      { retrievalScope: scope, exclusionsFailed: true });
    assert.equal((excluded as { code: string }).code, 'exclusions_unavailable');
  } finally { await db.end(); }
});

test('reimporting a Discover article preserves first discovery and never replaces known publication with ingestion time', async () => {
  const db = await phase2Db();
  try {
    await db.exec("CREATE UNIQUE INDEX discovered_url ON content_items(url) WHERE source = 'discovered-article' AND url IS NOT NULL AND url != ''");
    const id = await insertContent(db, { source: 'discovered-article', sourceId: 'old-import', title: 'Article', publishedAt: '2026-01-01',
      metadata: { discoveredAt: '2026-02-01T00:00:00Z', publicationDateKnown: true } });
    await db.query("UPDATE content_items SET url='https://example.com/article' WHERE id=$1", [id]);
    await upsertContentItem(db as unknown as Pool, { source: 'discovered-article', sourceId: 'reimport', title: 'Article',
      summary: '', body: '', publishedAt: '2026-10-24T00:00:00Z', projectContext: 'personal', url: 'https://example.com/article', tags: [],
      metadata: { discoveredAt: '2026-10-24T00:00:00Z', publicationDateKnown: false } });
    const record = (await db.query<{ published_at: Date; metadata: Record<string, unknown> }>('SELECT published_at,metadata FROM content_items WHERE id=$1', [id])).rows[0]!;
    assert.equal(record.published_at.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(record.metadata['discoveredAt'], '2026-02-01T00:00:00Z');
    assert.equal(record.metadata['publicationDateKnown'], true);
  } finally { await db.close(); }
});
