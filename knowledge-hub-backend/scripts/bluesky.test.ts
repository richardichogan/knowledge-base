import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import express from 'express';
import { BLUESKY_POST_LIMIT, blueskyCopyAllowance, composeBlueskyText, graphemeLength, postToBluesky } from '../src/integrations/social/bluesky.js';
import { AtpAgent, RichText } from '@atproto/api';
import { renderPodcastArtwork } from '../src/publishing/podcastCampaignAssets.js';
import { blogLinkForCopyBudget } from '../src/services/blogPublisher.js';
import { blueskyLength } from '../../knowledge-hub-web/src/components/discover/socialLength.js';
import { ValidationError } from '../src/types/errors.js';
import { env } from '../src/config/env.js';
import { getDb } from '../src/db/db.js';
import { discoverRouter } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { publishingFixture } from './publishing-fixture.js';

const url = 'https://example.com/news/article';

test('Bluesky embeds actual PNG dimensions without changing reviewed artwork or copy', async () => {
  const previousIdentifier = env.BLUESKY_IDENTIFIER;
  env.BLUESKY_IDENTIFIER = 'fixture.bsky.social';
  const password = mock.getter(env, 'BLUESKY_APP_PASSWORD', () => 'fixture-password-not-real');
  const login = mock.method(AtpAgent.prototype, 'login', async () => ({}));
  const facets = mock.method(RichText.prototype, 'detectFacets', async () => {});
  const network = mock.method(globalThis, 'fetch', async () => { throw new Error('No external requests allowed'); });
  const blob = { $type: 'blob', ref: { $link: 'fixture' }, mimeType: 'image/png', size: 100 };
  let expected: ReturnType<typeof renderPodcastArtwork>;
  const api = new AtpAgent({ service: 'https://fixture.test' });
  const upload = mock.method(Object.getPrototypeOf(api.com.atproto.repo), 'uploadBlob', async (bytes: Uint8Array) => {
    assert.deepEqual(bytes, expected.png);
    return { data: { blob } };
  });
  const post = mock.method(AtpAgent.prototype, 'post', async (record) => {
    assert.equal(record.text, 'Reviewed teaser copy');
    assert.equal(record.embed.$type, 'app.bsky.embed.images');
    assert.deepEqual(record.embed.images[0], {
      image: blob, alt: expected.alt, aspectRatio: { width: expected.width, height: expected.height },
    });
    return { uri: 'at://fixture/app.bsky.feed.post/fixture', cid: 'fixture' };
  });
  try {
    for (const kind of ['teaser', 'quote'] as const) {
      expected = renderPodcastArtwork({ kind, headline: 'Saved headline', quote: kind === 'quote' ? 'Saved quotation.' : null,
        speaker: kind === 'quote' ? 'Richard' : null, timestamp: null, episodeNumber: 46 });
      await postToBluesky('Reviewed teaser copy', null, { bytes: expected.png, alt: expected.alt, mimeType: 'image/png' });
    }
    assert.equal(post.mock.callCount(), 2);
    assert.equal(upload.mock.callCount(), 2);
  } finally {
    post.mock.restore(); upload.mock.restore(); network.mock.restore(); facets.mock.restore();
    login.mock.restore(); password.mock.restore(); env.BLUESKY_IDENTIFIER = previousIdentifier;
  }
});

test('composes copy, blank line and link like Copy post + link', () => {
  assert.equal(composeBlueskyText('  Big news today.  ', url), `Big news today.\n\n${url}`);
  assert.equal(composeBlueskyText('No link.', null), 'No link.');
});

test('counts graphemes the way Bluesky does, and the UI agrees', () => {
  assert.equal(graphemeLength('👨‍👩‍👧 é'), 3);
  const copy = 'x'.repeat(BLUESKY_POST_LIMIT - url.length - 2);
  assert.equal(blueskyLength(copy, url), BLUESKY_POST_LIMIT);
  assert.equal(composeBlueskyText(copy, url).length, BLUESKY_POST_LIMIT);
});

test('rejects empty and over-length posts before signing in', () => {
  assert.throws(() => composeBlueskyText('   ', url), ValidationError);
  assert.throws(() => composeBlueskyText('x'.repeat(BLUESKY_POST_LIMIT), url), /Bluesky allows 300/);
});

test('reserves the complete CMS permalink and separator for a long blog slug', () => {
  const slug = 'github-tightens-the-screws-microsoft-chases-supply-chain-fallout';
  assert.equal(blogLinkForCopyBudget({ slug }, new Date('2026-10-26T13:00:00Z')),
    new URL(`/2026/10/${slug}/`, env.BLOG_POSTS_URL).href);
  const link = `https://themicrosoftcloudblog.com/2026/10/${slug}/`;
  assert.equal(graphemeLength(link), 107);
  assert.equal(blueskyCopyAllowance(link), 191);
  assert.throws(() => composeBlueskyText('x'.repeat(252), link), /361 characters/);
  const copy = '👍🏽'.repeat(blueskyCopyAllowance(link));
  assert.equal(graphemeLength(composeBlueskyText(copy, link)), 300);
  assert.throws(() => composeBlueskyText(copy + 'x', link), /301 characters/);
  assert.throws(() => composeBlueskyText(copy, link.replace(/\/$/, '-2/')), /302 characters/);
  assert.throws(() => blogLinkForCopyBudget({}), /slug is required/);
});

test('copy budgets handle absent links and reject links which leave no room', () => {
  assert.equal(blueskyCopyAllowance(null), 300);
  assert.equal(blueskyCopyAllowance('x'.repeat(297)), 1);
  assert.throws(() => blueskyCopyAllowance('x'.repeat(298)), /no room/);
});

test('post route claims the article atomically so concurrent or repeat requests cannot double-post', async () => {
  const fixture = await publishingFixture();
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const password = mock.getter(env, 'BLUESKY_APP_PASSWORD', () => undefined);
  let blueskyPost: { status: string; url?: string } | null = null;
  let claims = 0;
  let releaseGate: Promise<void> = Promise.resolve();
  const connect = mock.method(getDb(), 'connect', fixture.db.connect.bind(fixture.db));
  const query = mock.method(getDb(), 'query', async (sql: string, values: unknown[]) => {
    if (!sql.includes('content_items') || sql.includes('publishing_deliveries')) return fixture.db.query(sql, values);
    assert.equal(values[0], id);
    if (/'posting', 'claimedAt'/.test(sql)) {
      assert.match(sql, /metadata->'blueskyPost' IS NULL/);
      if (blueskyPost) return { rows: [] };
      blueskyPost = { status: 'posting' };
      claims += 1;
      return { rows: [{ title: 'Title', body: 'Body', url: 'https://example.com/a' }] };
    }
    if (/^SELECT metadata->'blueskyPost'/.test(sql)) return { rows: [{ post_url: blueskyPost?.url ?? null, status: blueskyPost?.status ?? null }] };
    if (/metadata - 'blueskyPost'/.test(sql)) {
      await releaseGate;
      if (blueskyPost?.status === 'posting') blueskyPost = null;
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const app = express();
  app.use(express.json());
  app.use('/api/discover', discoverRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/discover/${id}/bluesky-post`;
  const originalFetch = globalThis.fetch;
  const network = mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(input).startsWith(base), 'Tests must never reach Bluesky');
    return originalFetch(input, init);
  });
  const send = (): Promise<Response> => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"post":"Hello"}' });
  try {
    let open!: () => void;
    releaseGate = new Promise<void>((resolve) => { open = resolve; });
    const first = send();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await send();
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'BLUESKY_POST_IN_PROGRESS');
    open();
    assert.equal((await first).status, 502);
    assert.equal(claims, 1);
    assert.equal(blueskyPost, null, 'a failure before posting releases the claim');

    blueskyPost = { status: 'unconfirmed' };
    const unconfirmed = await send();
    assert.equal(unconfirmed.status, 409);
    assert.match(((await unconfirmed.json()) as { error: { message: string } }).error.message, /Check your Bluesky profile/);

    blueskyPost = { status: 'posted', url: 'https://bsky.app/profile/me/post/1' };
    const repeat = await send();
    assert.equal(repeat.status, 409);
    assert.equal(((await repeat.json()) as { error: { code: string } }).error.code, 'BLUESKY_ALREADY_POSTED');
    assert.equal(claims, 1);
  } finally {
    network.mock.restore();
    query.mock.restore();
    connect.mock.restore();
    password.mock.restore();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    await fixture.close();
  }
});
