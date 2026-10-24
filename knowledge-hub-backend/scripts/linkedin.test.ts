import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { LINKEDIN_POST_LIMIT, LinkedInPostUnconfirmedError, composeLinkedInText, getLinkedInMember, postToLinkedIn } from '../src/integrations/social/linkedin.js';
import { env } from '../src/config/env.js';
import { replaceCredentialValues, setCredentialValue } from '../src/config/credentialValues.js';
import { getDb } from '../src/db/db.js';
import { discoverRouter } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { listConnectionCredentials, updateConnectionCredential } from '../src/services/connectionCredentials.js';
import { publishingFixture } from './publishing-fixture.js';

const articleId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const member = { sub: 'fixture-member', name: 'Fixture Author' };
const token = 'fixture-linkedin-token-not-real';
const urn = 'urn:li:ugcPost:123456789';
const articleUrl = 'https://example.com/article';
const postResponse = (): Response => new Response(null, { status: 201, headers: { 'x-restli-id': urn } });

test('LinkedIn composes the exact reviewed copy and link and rejects unsafe or oversized input', () => {
  assert.equal(composeLinkedInText('  A practical observation.  ', articleUrl), `A practical observation.\n\n${articleUrl}`);
  assert.equal(composeLinkedInText('No link', null), 'No link');
  const boundary = 'x'.repeat(LINKEDIN_POST_LIMIT - articleUrl.length - 2);
  assert.equal(composeLinkedInText(boundary, articleUrl).length, LINKEDIN_POST_LIMIT);
  assert.throws(() => composeLinkedInText(`${boundary}x`, articleUrl), /character limit/);
  assert.throws(() => composeLinkedInText(' ', articleUrl), /Write the post/);
  for (const url of ['not a URL', 'javascript:alert(1)', 'https://user:password@example.com/']) {
    assert.throws(() => composeLinkedInText('Copy', url), /link/);
  }
});

test('member verification and a single publish use fixed LinkedIn endpoints, exact copy and the confirmed personal account', async () => {
  setCredentialValue('LINKEDIN_ACCESS_TOKEN', token);
  const calls: string[] = [];
  const network = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (String(input) === 'https://api.linkedin.com/v2/userinfo') return Response.json(member);
    assert.equal(String(input), 'https://api.linkedin.com/v2/ugcPosts');
    assert.equal(init?.method, 'POST');
    assert.equal(headers.get('X-Restli-Protocol-Version'), '2.0.0');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.author, `urn:li:person:${member.sub}`);
    assert.equal(payload.lifecycleState, 'PUBLISHED');
    assert.equal(payload.visibility['com.linkedin.ugc.MemberNetworkVisibility'], 'PUBLIC');
    const content = payload.specificContent['com.linkedin.ugc.ShareContent'];
    assert.equal(content.shareCommentary.text, `Reviewed text\n\n${articleUrl}`);
    assert.equal(content.shareMediaCategory, 'ARTICLE');
    assert.equal(content.media[0].originalUrl, articleUrl);
    return postResponse();
  });
  try {
    assert.deepEqual(await getLinkedInMember(), { id: member.sub, name: member.name });
    assert.deepEqual(await postToLinkedIn('Reviewed text', { url: articleUrl, title: 'Article' }, member.sub),
      { urn, url: `https://www.linkedin.com/feed/update/${urn}/` });
    assert.equal(calls.filter(url => url.endsWith('/ugcPosts')).length, 1);
    await assert.rejects(postToLinkedIn('Reviewed text', null, 'another-member'), /account changed/);
    assert.equal(calls.filter(url => url.endsWith('/ugcPosts')).length, 1, 'an account switch never publishes');
  } finally { network.mock.restore(); replaceCredentialValues(new Map()); }
});

test('expired credentials and definite rejections stay distinct from uncertain publishing outcomes, without leaking provider data', async () => {
  setCredentialValue('LINKEDIN_ACCESS_TOKEN', token);
  let identity: unknown = member;
  let identityStatus = 200;
  let publish: () => Response = postResponse;
  let sent = 0;
  const network = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === 'https://api.linkedin.com/v2/userinfo') return Response.json(identity, { status: identityStatus });
    assert.equal(String(input), 'https://api.linkedin.com/v2/ugcPosts');
    sent++;
    return publish();
  });
  try {
    identityStatus = 401;
    await assert.rejects(postToLinkedIn('Copy', null, member.sub), /Renew it/);
    assert.equal(sent, 0);
    identityStatus = 200;
    identity = { name: 'Missing ID' };
    await assert.rejects(getLinkedInMember(), /did not identify/);
    assert.equal(sent, 0);
    identity = member;
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      publish = () => new Response(`secret provider detail ${token}`, { status });
      await assert.rejects(postToLinkedIn('Copy', null, member.sub), error =>
        error instanceof Error && !(error instanceof LinkedInPostUnconfirmedError)
        && error.message.includes(`HTTP ${status}`) && !error.message.includes(token));
    }
    for (const outcome of [
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 409 }),
      () => new Response(null, { status: 201 }),
      () => new Response(null, { status: 201, headers: { 'x-restli-id': 'https://attacker.example/' } }),
      () => { throw new Error(`Network timeout with ${token}`); },
    ]) {
      publish = outcome;
      const before = sent;
      await assert.rejects(postToLinkedIn('Copy', null, member.sub), error =>
        error instanceof LinkedInPostUnconfirmedError && !error.message.includes(token));
      assert.equal(sent, before + 1, 'uncertain publishing is attempted exactly once');
    }
  } finally { network.mock.restore(); replaceCredentialValues(new Map()); }
});

interface PostState { status: string; url?: string }
interface RouteFixture {
  send: (body?: unknown) => Promise<Response>;
  pg: PGlite;
  setPublish: (fn: () => Promise<Response>) => void;
  failRecording: () => void;
  postCalls: () => number;
  state: () => Promise<PostState | null>;
}

async function routeFixture(run: (fixture: RouteFixture) => Promise<void>): Promise<void> {
  const fixture = await publishingFixture();
  const { pg } = fixture;
  await pg.query("INSERT INTO content_items(id,source,title,url,workflow_state,metadata) VALUES ($1,'discovered-article','Article',$2,'to-review',NULL)", [articleId, articleUrl]);
  let fail = false;
  const connect = mock.method(getDb(), 'connect', fixture.db.connect.bind(fixture.db));
  const query = mock.method(getDb(), 'query', async (sql: string, params?: unknown[]) => {
    if (fail && sql.includes("workflow_state = 'published'")) throw new Error('Fixture recording failure');
    return fixture.db.query(sql, params);
  });
  setCredentialValue('LINKEDIN_ACCESS_TOKEN', token);
  const app = express();
  app.use(express.json());
  app.use('/api/discover', discoverRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/discover`;
  const originalFetch = globalThis.fetch;
  let posts = 0;
  let publish = async (): Promise<Response> => postResponse();
  const network = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith(`${base}/`)) return originalFetch(input, init);
    if (String(input) === 'https://api.linkedin.com/v2/userinfo') return Response.json(member);
    assert.equal(String(input), 'https://api.linkedin.com/v2/ugcPosts', 'no real external requests');
    posts++;
    return publish();
  });
  try {
    const account = await fetch(`${base}/linkedin-account`);
    assert.deepEqual(await account.json(), { success: true, data: { id: member.sub, name: member.name } });
    await run({
      pg,
      send: (body = { post: 'Reviewed copy', memberId: member.sub, confirmed: true }) =>
        fetch(`${base}/${articleId}/linkedin-post`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      setPublish: fn => { publish = fn; },
      failRecording: () => { fail = true; },
      postCalls: () => posts,
      state: async () => (await pg.query<{ state: PostState | null }>("SELECT metadata->'linkedinPost' AS state FROM content_items WHERE id=$1", [articleId])).rows[0]!.state,
    });
  } finally {
    network.mock.restore(); query.mock.restore(); connect.mock.restore(); replaceCredentialValues(new Map());
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    await pg.close();
  }
}

test('LinkedIn route requires confirmation, excludes email and validates copy and account before publishing', async () => {
  await routeFixture(async fixture => {
    assert.equal((await fixture.send({ post: 'Copy', memberId: member.sub })).status, 409);
    for (const body of [
      { post: '', memberId: member.sub, confirmed: true },
      { post: 'x'.repeat(LINKEDIN_POST_LIMIT + 1), memberId: member.sub, confirmed: true },
      { post: 'Copy', confirmed: true },
    ]) assert.equal((await fixture.send(body)).status, 422);
    assert.equal(await fixture.state(), null);
    const changed = await fixture.send({ post: 'Copy', memberId: 'different-account', confirmed: true });
    assert.equal(changed.status, 422);
    assert.equal(await fixture.state(), null, 'pre-publication failure releases the claim');
    await fixture.pg.query("UPDATE content_items SET source='email' WHERE id=$1", [articleId]);
    assert.equal((await fixture.send()).status, 404);
    assert.equal(fixture.postCalls(), 0);
  });
});

test('LinkedIn claims are atomic across concurrent requests, independent of Bluesky, and persist success', async () => {
  await routeFixture(async fixture => {
    await fixture.pg.query(`UPDATE content_items SET metadata='{"blueskyPost":{"status":"posted","url":"https://bsky.app/fixture"}}' WHERE id=$1`, [articleId]);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    fixture.setPublish(async () => { entered(); await gate; return postResponse(); });
    const first = fixture.send();
    await started;
    try { assert.equal((await fixture.send()).status, 409); }
    finally { release(); }
    const published = await first;
    assert.equal(published.status, 200);
    const result = await published.json();
    assert.equal(result.data.url, `https://www.linkedin.com/feed/update/${urn}/`);
    assert.equal(result.data.warning, undefined);
    assert.equal((await fixture.state())?.status, 'posted');
    const article = (await fixture.pg.query<{ workflow_state: string; metadata: Record<string, unknown> }>('SELECT workflow_state,metadata FROM content_items WHERE id=$1', [articleId])).rows[0]!;
    assert.equal(article.workflow_state, 'published');
    assert.ok(article.metadata.blueskyPost, 'LinkedIn does not overwrite Bluesky publication');
    assert.equal((await fixture.send()).status, 409);
    assert.equal(fixture.postCalls(), 1);
  });
});

test('definite LinkedIn rejection releases the claim but uncertain outcomes block retries without changing workflow', async () => {
  await routeFixture(async fixture => {
    fixture.setPublish(async () => new Response(null, { status: 403 }));
    assert.equal((await fixture.send()).status, 502);
    assert.equal(await fixture.state(), null);
    assert.equal((await fixture.send()).status, 409, 'a definite failure remains held until explicitly reset');
  });
  await routeFixture(async fixture => {
    fixture.setPublish(async () => { throw new Error('Fixture network timeout'); });
    assert.equal((await fixture.send()).status, 502);
    assert.equal((await fixture.state())?.status, 'unconfirmed');
    const article = (await fixture.pg.query<{ workflow_state: string }>('SELECT workflow_state FROM content_items WHERE id=$1', [articleId])).rows[0]!;
    assert.equal(article.workflow_state, 'to-review');
    assert.equal((await fixture.send()).status, 409);
    assert.equal(fixture.postCalls(), 1);
  });
});

test('a live LinkedIn post with a failed local save reports its URL and a warning while blocking duplication', async () => {
  await routeFixture(async fixture => {
    fixture.failRecording();
    const response = await fixture.send();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.url, `https://www.linkedin.com/feed/update/${urn}/`);
    assert.match(body.data.warning, /could not record/);
    assert.equal((await fixture.state())?.status, 'posting');
    assert.equal((await fixture.send()).status, 409);
    assert.equal(fixture.postCalls(), 1);
  });
});

test('Connections verifies and encrypts LinkedIn tokens without exposing or publishing them, retaining the old token on failure', async () => {
  const pg = new PGlite();
  await pg.exec('CREATE TABLE sync_state(source text PRIMARY KEY,last_cursor text,item_count integer,updated_at timestamptz)');
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  env.CREDENTIAL_ENCRYPTION_KEY = 'linkedin-fixture-encryption-key-not-a-secret';
  let rejected = false;
  const network = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(String(input), 'https://api.linkedin.com/v2/userinfo', 'saving a token never posts');
    return rejected ? new Response(null, { status: 401 }) : Response.json(member);
  });
  try {
    assert.deepEqual(await updateConnectionCredential(pg as unknown as Pool, 'linkedin', token), { verified: true });
    const stored = JSON.stringify((await pg.query('SELECT * FROM sync_state')).rows);
    assert.ok(!stored.includes(token));
    const view = (await listConnectionCredentials(pg as unknown as Pool)).find(item => item.id === 'linkedin');
    assert.equal(view?.configured, true);
    assert.ok(!JSON.stringify(view).includes(token));
    rejected = true;
    await assert.rejects(updateConnectionCredential(pg as unknown as Pool, 'linkedin', 'invalid-replacement'), /Renew it/);
    assert.equal(env.LINKEDIN_ACCESS_TOKEN, token);
    assert.equal(JSON.stringify((await pg.query('SELECT * FROM sync_state')).rows), stored);
  } finally {
    network.mock.restore(); replaceCredentialValues(new Map()); env.CREDENTIAL_ENCRYPTION_KEY = encryptionKey; await pg.close();
  }
});
