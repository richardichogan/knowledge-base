import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { readDiscoverArgument, sparkSourceArgument } from '../src/services/sparkSourceReading.js';
import { articleProse, readingExcerpt } from '../src/utils/articleReading.js';
import { createThemeForSparks, describeSpark, runClusteringJob } from '../src/jobs/clusteringJob.js';
import { fetchWebPage } from '../src/ai/chatTools.js';
import { updateSpark } from '../src/services/sparkService.js';

const ARTICLE = '11111111-1111-4111-8111-111111111111';
const SPARK = '22222222-2222-4222-8222-222222222222';
const THEME = '33333333-3333-4333-8333-333333333333';
const URL = 'https://93.184.216.34/article';
const thesis = 'The conclusion requires executable organisational authority, delegation controls and runtime governance.';
const prose = `${'Payments are one example. '.repeat(100)}\n${thesis}`;

async function fixture(): Promise<{ db: PGlite; pool: Pool }> {
  const db = new PGlite();
  await db.exec(`CREATE TABLE content_items (id uuid PRIMARY KEY, title text, source text, url text, metadata jsonb DEFAULT '{}');
    CREATE TABLE notes (id uuid PRIMARY KEY, content text, status text DEFAULT 'active');
    CREATE TABLE nodes (ref_id text, ref_type text, title text);
    CREATE TABLE sparks (id uuid PRIMARY KEY, body text, tags text[] DEFAULT '{}', source_id text, source_type text, cluster_id uuid, created_at timestamptz DEFAULT now(),
      used_at timestamptz, used_type text, used_ref text, used_title text);
    CREATE TABLE spark_clusters (id uuid PRIMARY KEY, theme text, status text DEFAULT 'active', spark_count int DEFAULT 0, surfaced boolean DEFAULT true,
      last_grown_at timestamptz, updated_at timestamptz DEFAULT now());`);
  await db.query(`INSERT INTO content_items VALUES ($1, 'Agent payments', 'discovered-article', $2, '{}')`, [ARTICLE, URL]);
  const pool = { query: db.query.bind(db), connect: async () => ({ query: db.query.bind(db), release: () => {} }) };
  return { db, pool: pool as unknown as Pool };
}

test('prose extraction removes navigation but retains the actual argument and conclusion', () => {
  const text = articleProse(`<nav>Not the argument</nav><script>bad()</script><main><article><p>${prose}</p><p>A &amp; B.</p></article></main><footer>Cookies</footer>`);
  assert.match(text, /runtime governance/);
  assert.match(text, /A & B/);
  assert.doesNotMatch(text, /Not the argument|bad\(\)|Cookies/);
  assert.deepEqual(readingExcerpt(prose), { text: prose, truncated: false });
  const long = readingExcerpt(`Opening ${'x'.repeat(40_000)} MIDDLE ARGUMENT ${'y'.repeat(40_000)} Conclusion`);
  assert.equal(long.truncated, true);
  assert.match(long.text, /^Opening/);
  assert.match(long.text, /MIDDLE ARGUMENT/);
  assert.match(long.text, /Conclusion$/);
  assert.ok(long.text.length < 60_100);
});

test('chat receives the full argument beyond 8,000 characters and honest excerpt coverage for long sources', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    new Response(`<article>${'Opening context. '.repeat(900)}${thesis}</article>`, { headers: { 'content-type': 'text/html' } }));
  const full = await fetchWebPage({ url: URL }) as { content: string; truncated: boolean; coverage: string };
  assert.match(full.content, /runtime governance/);
  assert.equal(full.truncated, false);
  fetch.mock.mockImplementation(async () => new Response(`Start ${'x'.repeat(80_000)} ${thesis}`, { headers: { 'content-type': 'text/plain' } }));
  const long = await fetchWebPage({ url: URL }) as typeof full;
  assert.match(long.content, /runtime governance/);
  assert.equal(long.truncated, true);
  assert.match(long.coverage, /not the full article/);
  fetch.mock.mockImplementation(async () => new Response('x'.repeat(2_000_001), { headers: { 'content-type': 'text/plain' } }));
  const tooLarge = await fetchWebPage({ url: URL }) as { error: string };
  assert.match(tooLarge.error, /safe reading size/);
});

test('article synopsis is grounded past the opening and reused with its provenance', async t => {
  const { db, pool } = await fixture();
  t.after(() => db.close());
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(`<article>${prose}</article>`, { headers: { 'content-type': 'text/html' } }));
  const chat = t.mock.method(FoundryClient.prototype, 'chat', async (_model, messages) => {
    const input = JSON.parse(messages[1]!.content) as { sourceText: string; coverage: string };
    assert.match(input.sourceText, /runtime governance/);
    assert.equal(input.coverage, 'Complete supplied source text');
    return thesis;
  });
  assert.deepEqual(await readDiscoverArgument(pool, ARTICLE), { title: 'Agent payments', argument: thesis });
  assert.equal((await readDiscoverArgument(pool, ARTICLE)).argument, thesis);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(chat.mock.callCount(), 1);
  const row = await db.query<{ metadata: { sparkArticleReading: { readAt: string; truncated: boolean; url: string } } }>(`SELECT metadata FROM content_items`);
  assert.equal(row.rows[0]!.metadata.sparkArticleReading.url, URL);
  assert.equal(row.rows[0]!.metadata.sparkArticleReading.truncated, false);
  assert.ok(row.rows[0]!.metadata.sparkArticleReading.readAt);
  await db.query(`UPDATE content_items SET url = $1`, [`${URL}/corrected`]);
  await readDiscoverArgument(pool, ARTICLE);
  assert.equal(fetch.mock.callCount(), 2, 'Changing the source URL invalidates the cached reading');
});

test('thin, blocked, private-redirect and model-rejected sources never become title-only judgements', async t => {
  const { db, pool } = await fixture();
  t.after(() => db.close());
  const chat = t.mock.method(FoundryClient.prototype, 'chat', async () => 'SOURCE_UNAVAILABLE');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('A title only', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(readDiscoverArgument(pool, ARTICLE), /unavailable or too thin/);
  assert.equal(chat.mock.callCount(), 0);
  fetch.mock.mockImplementation(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
  await assert.rejects(readDiscoverArgument(pool, ARTICLE), /not on the public internet/);
  assert.equal(fetch.mock.callCount(), 2);
  fetch.mock.mockImplementation(async () => new Response(prose, { headers: { 'content-type': 'text/plain' } }));
  await assert.rejects(readDiscoverArgument(pool, ARTICLE), /Could not establish/);
  const row = await db.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM content_items`);
  assert.equal(row.rows[0]!.metadata['sparkArticleReading'], undefined);
});

test('Think sources supply the saved writing, not wrapper JSON or a title prefix', async t => {
  const { db, pool } = await fixture();
  t.after(() => db.close());
  await db.query(`INSERT INTO notes (id, content) VALUES ($1, $2)`, [ARTICLE, JSON.stringify({
    title: 'Payments note', contentType: 'note',
    contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: prose, styles: {} }] }]),
  })]);
  const argument = await sparkSourceArgument(pool, ARTICLE, 'note');
  assert.match(argument!, /runtime governance/);
  assert.doesNotMatch(argument!, /contentJson/);
  assert.match(describeSpark({ id: SPARK, body: prose, tags: [], source_title: 'Payments',
    source_id: ARTICLE, source_type: 'note', source_argument: argument }), /runtime governance/);
});

test('legacy loose article sparks use the source argument for existing-theme assignment and recount', async t => {
  const { db, pool } = await fixture();
  t.after(() => db.close());
  await db.query(`UPDATE content_items SET metadata = $1`, [JSON.stringify({ sparkArticleReading: {
    version: 1, url: URL, argument: thesis, readAt: new Date().toISOString(), truncated: false,
  } })]);
  await db.query(`INSERT INTO sparks (id, body, source_id, source_type) VALUES ($1, 'An industry payments article', $2, 'discover_item')`, [SPARK, ARTICLE]);
  await db.query(`INSERT INTO spark_clusters (id, theme) VALUES ($1, 'Agent Platform Governance')`, [THEME]);
  t.mock.method(FoundryClient.prototype, 'chat', async (_model, messages) => {
    assert.match(messages[1]!.content, /runtime governance/);
    return '{"assignments":[{"spark":0,"theme":0}]}';
  });
  await runClusteringJob(pool);
  const spark = await db.query<{ cluster_id: string }>(`SELECT cluster_id FROM sparks`);
  assert.equal(spark.rows[0]!.cluster_id, THEME);
  const theme = await db.query<{ spark_count: number; surfaced: boolean }>(`SELECT spark_count, surfaced FROM spark_clusters`);
  assert.equal(theme.rows[0]!.spark_count, 1);
  assert.equal(theme.rows[0]!.surfaced, false);
});

test('unreadable article sparks stay loose and never enter a tag-only shortcut', async t => {
  const { db, pool } = await fixture();
  t.after(() => db.close());
  await db.query(`UPDATE content_items SET url = NULL`);
  for (let i = 0; i < 3; i++) {
    await db.query(`INSERT INTO sparks (id, body, tags, source_id, source_type) VALUES ($1, 'Payments title', '{AI}', $2, 'discover_item')`,
      [`22222222-2222-4222-8222-22222222222${i}`, ARTICLE]);
  }
  const chat = t.mock.method(FoundryClient.prototype, 'chat', async () => { throw new Error('Must not judge an unread article'); });
  await runClusteringJob(pool);
  assert.equal(chat.mock.callCount(), 0);
  const row = await db.query<{ cluster_id: string | null }>(`SELECT cluster_id FROM sparks`);
  assert.equal(row.rows[0]!.cluster_id, null);
});

test('manual drag move persists membership and updates both old and new theme counts', async t => {
  const { db, pool } = await fixture();
  t.after(() => db.close());
  await db.query(`INSERT INTO sparks (id, body) VALUES ($1, 'An idea')`, [SPARK]);
  await db.query(`INSERT INTO spark_clusters (id, theme) VALUES ($1, 'Agent Platform Governance')`, [THEME]);
  const moved = await updateSpark(pool, SPARK, { clusterId: THEME });
  assert.equal(moved.clusterId, THEME);
  let counts = await db.query<{ spark_count: number }>(`SELECT spark_count FROM spark_clusters`);
  assert.equal(counts.rows[0]!.spark_count, 1);
  await updateSpark(pool, SPARK, { clusterId: THEME });
  counts = await db.query(`SELECT spark_count FROM spark_clusters`);
  assert.equal(counts.rows[0]!.spark_count, 1, 'Retry is idempotent');
  await updateSpark(pool, SPARK, { clusterId: null });
  counts = await db.query(`SELECT spark_count FROM spark_clusters`);
  assert.equal(counts.rows[0]!.spark_count, 0);
});

test('automatic new-theme grouping cannot overwrite a manual drop made while the model was running', async t => {
  const { db, pool } = await fixture();
  t.after(() => db.close());
  await db.query(`INSERT INTO spark_clusters (id, theme) VALUES ($1, 'Chosen manually')`, [THEME]);
  const ids = [SPARK, ARTICLE, THEME];
  for (const id of ids) await db.query(`INSERT INTO sparks (id, body) VALUES ($1, 'An idea')`, [id]);
  await updateSpark(pool, SPARK, { clusterId: THEME });
  await assert.rejects(createThemeForSparks(pool, 'Automatic theme', ids, true), /keeping manual assignments/);
  const spark = await db.query<{ cluster_id: string }>(`SELECT cluster_id FROM sparks WHERE id = $1`, [SPARK]);
  assert.equal(spark.rows[0]!.cluster_id, THEME);
  const themes = await db.query<{ theme: string }>(`SELECT theme FROM spark_clusters`);
  assert.deepEqual(themes.rows, [{ theme: 'Chosen manually' }], 'Raced automatic theme rolls back completely');
});
