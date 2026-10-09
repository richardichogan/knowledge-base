import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { DISCOVER_APP_GUIDANCE, getDiscoverSources, inspectDiscoverFeed, isDiscoverSourceRequest } from '../src/ai/discoveryContext.js';

test('actual failed conversation routes to app configuration, not project retrieval', () => {
  for (const message of [
    'can you suggest some additional soruces that would be really good to show in the discovery page',
    'Do you know what your own discovery page is?',
    'What is the discover page!!',
    "why can't you see the sources i have in this app",
    "I need the feed URL!",
  ]) assert.equal(isDiscoverSourceRequest(message), true, message);
  const history = [{ role: 'user' as const, content: 'Suggest additional feeds for Discover' }];
  assert.equal(isDiscoverSourceRequest('ok, try it', history), true);
  assert.equal(isDiscoverSourceRequest('why are you suggesting feeds that are already in the source?', history), true);
  assert.equal(isDiscoverSourceRequest('Describe IMAGINE architecture'), false);
  assert.equal(isDiscoverSourceRequest('write a claims demo', history), false);
  assert.equal(isDiscoverSourceRequest('ok, try it', [{ role: 'assistant', content: 'Discover sources' }]), false);
  assert.match(DISCOVER_APP_GUIDANCE, /not a project document library/);
  assert.match(DISCOVER_APP_GUIDANCE, /exclude ALL configured sources/);
  assert.match(DISCOVER_APP_GUIDANCE, /Do not ask the user to paste/);
});

test('source lookup and candidate checks are read-only and exclude disabled/URL-variant duplicates', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE discovery_sources (
      id text, title text, feed_url text, group_name text, is_active boolean,
      last_checked_at timestamptz, last_success_at timestamptz, last_error text
    );
    INSERT INTO discovery_sources VALUES
      ('one', 'Azure', 'https://www.example.com/feed/', 'Microsoft', true, now(), now(), null),
      ('two', 'Disabled', 'https://disabled.example/feed?b=2&a=1', 'Other', false, null, null, 'HTTP 500');`);
    const queries: string[] = [];
    const db = { query: async (sql: string) => {
      queries.push(sql);
      return pg.query(sql);
    } } as unknown as Pool;
    const result = await getDiscoverSources(db);
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources.find(source => source.id === 'two')?.active, false);
    assert.equal(result.sources.find(source => source.id === 'two')?.lastError, 'HTTP 500');
    let reads = 0;
    const reader = async () => {
      reads++;
      return Array.from({ length: 8 }, (_, i) => ({ title: `Article ${i}`, url: `https://new.example/${i}`, summary: '', publishedAt: null }));
    };
    const existing = await inspectDiscoverFeed(db, 'http://example.com/feed#fragment', reader);
    assert.equal(existing.alreadyConfigured, true);
    const disabled = await inspectDiscoverFeed(db, 'https://disabled.example/feed?a=1&b=2', reader);
    assert.equal(disabled.alreadyConfigured, true);
    assert.equal(reads, 0, 'Duplicate candidates do not trigger a network check');
    const fresh = await inspectDiscoverFeed(db, 'https://new.example/rss', reader);
    assert.equal(fresh.alreadyConfigured, false);
    assert.ok('verified' in fresh && fresh.verified);
    assert.ok('recentArticles' in fresh && fresh.recentArticles.length === 5);
    await assert.rejects(inspectDiscoverFeed(db, 'https://bad.example/rss', async () => { throw new Error('not an RSS or Atom feed'); }), /not an RSS/);
    assert.ok(queries.every(sql => /^\s*SELECT/i.test(sql)), 'No writes or imports');
  } finally { await pg.close(); }
});

test('tool dispatch exposes current sources even in project-scoped chat', async () => {
  process.env['DATABASE_URL'] = 'postgresql://isolated.invalid/offline';
  const { executeToolCall } = await import('../src/ai/chatTools.js');
  const calls: string[] = [];
  const db = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; } } as unknown as Pool;
  const result = await executeToolCall(db, 'get_discover_sources', '{}', 'imagine');
  assert.deepEqual(result, { page: '/discover', scope: 'App-wide Discover RSS/Atom subscriptions, including disabled sources', sources: [] });
  assert.ok(calls[0]?.includes('discovery_sources'));
  assert.ok(!calls[0]?.includes('project'));
  assert.deepEqual(await executeToolCall(db, 'inspect_discover_feed', '{}'), { error: 'Provide a public RSS/Atom feed URL.' });
  const { assembleMessages } = await import('../src/ai/contextBuilder.js');
  const messages = await assembleMessages({
    staticContext: 'Richard works on IMAGINE',
    projectContext: 'Current Discover subscriptions: https://example.com/feed',
    projectReferences: [], activeProjectName: null, ragItems: [], ragQuery: '', memoryItems: [],
  }, [{ role: 'assistant', content: 'Discover is an IMAGINE onboarding collection' }],
  'Suggest additional Discover feed URLs');
  assert.ok(messages[0]?.content.includes(DISCOVER_APP_GUIDANCE), 'App definition and correction rules are system instructions, above bad previous replies');
  assert.ok(messages[0]?.content.includes('https://example.com/feed'), 'Live configured URLs are visible in the assembled prompt');
});
