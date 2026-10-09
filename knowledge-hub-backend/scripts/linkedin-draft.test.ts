import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import express from 'express';
import { getDb } from '../src/db/db.js';
import { getFoundryClient } from '../src/ai/foundryClient.js';
import { generateShortSocialDraft, parseLinkedInDraft, socialLength, sourceUrl } from '../src/ai/linkedInDraft.js';
import { socialLength as uiSocialLength } from '../../knowledge-hub-web/src/components/discover/socialLength.js';
import { discoverRouter } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const summary = 'Microsoft has announced a new management capability for cloud environments.';
const observation = 'For enterprise IT, this could simplify governance across teams.';
const raw = JSON.stringify({ summary, observation });

test('short social counting includes full URLs, breaks and conservative X weights on both sides', () => {
  const url = 'https://example.com/' + 'a'.repeat(70);
  for (const [post, link] of [
    ['a'.repeat(280), null], ['New announcement', url], ['漢'.repeat(140), null],
    ['😀'.repeat(100), url], ['e\u0301'.repeat(140), null], ['News', 'https://x.co'],
  ] as const) assert.equal(socialLength(post, link), uiSocialLength(post, link));
  assert.equal(socialLength('a'.repeat(280), null), 280);
  assert.equal(socialLength('News', 'https://x.co'), 4 + 2 + 23);
  assert.equal(socialLength('News', url), 4 + 2 + url.length);
  assert.equal(socialLength('漢'.repeat(140), null), 280);
  assert.equal(socialLength('e\u0301'.repeat(140), null), 280);
  assert.equal(socialLength('News https://x.co', null), 5 + 23);
  assert.equal(uiSocialLength('News https://x.co', null), 5 + 23);
  assert.equal(socialLength('a'.repeat(253), 'https://x.co'), 278);
  assert.equal(socialLength('a'.repeat(256), 'https://x.co'), 281);
});

test('short generator reserves link budget, retries oversized copy and never truncates', async () => {
  const source = { title: 'News', body: 'A public announcement.', source: 'discovered-article' as const, url: 'https://example.com/' + 'a'.repeat(90) };
  let calls = 0;
  let alwaysOversized = false;
  const chat = mock.method(getFoundryClient('discover-linkedin'), 'chat', async (_model, messages) => {
    calls++;
    assert.match(messages[0].content, /untrusted data/);
    assert.match(messages[0].content, /private email/);
    assert.match(messages[0].content, /168 weighted characters/);
    assert.match(messages[0].content, /one or two complete, natural sentences/);
    assert.match(messages[0].content, /light Richard Hogan twist/);
    assert.match(messages[0].content, /Observation MUST be empty/);
    return JSON.stringify({ summary: alwaysOversized || calls === 1 ? 'a'.repeat(300) : 'Microsoft announced a cloud management update.', observation: 'Shows the need for governance.' });
  });
  try {
    const result = await generateShortSocialDraft(source);
    assert.equal(calls, 2);
    assert.equal(result.sourceUrl, source.url);
    assert.equal(result.post, 'Microsoft announced a cloud management update.');
    assert.ok(!result.post.includes('\n'));
    assert.ok(socialLength(result.post, result.sourceUrl) <= 280);
    alwaysOversized = true;
    await assert.rejects(generateShortSocialDraft(source), /280 characters/);
    assert.equal(calls, 5);
    await assert.rejects(generateShortSocialDraft({ ...source, url: 'https://example.com/' + 'a'.repeat(250) }), /too little room/);
    assert.equal(calls, 5);
  } finally { chat.mock.restore(); }
});

test('short draft preserves paragraph boundaries and optional observation', () => {
  assert.equal(parseLinkedInDraft(raw), `${summary}\n\n${observation}`);
  assert.equal(parseLinkedInDraft(JSON.stringify({ summary, observation: '' })), summary);
  assert.equal(parseLinkedInDraft(`\`\`\`json\n${raw}\n\`\`\``), `${summary}\n\n${observation}`);
  for (const invalid of ['not JSON', '{}', 'null', JSON.stringify({ summary: 12, observation: '' }),
    JSON.stringify({ summary: 'word '.repeat(91), observation: '' }),
    JSON.stringify({ summary: '**Markdown**', observation: '' }),
    JSON.stringify({ summary: 'See https://invented.example', observation: '' })]) {
    assert.throws(() => parseLinkedInDraft(invalid), /LinkedIn draft/);
  }
  assert.throws(() => parseLinkedInDraft('{"summary":"","observation":""}'), /shareable news/);
});

test('original source URL is never invented and unsafe protocols are excluded', () => {
  assert.equal(sourceUrl('https://outlook.office.com/mail/id/example'), 'https://outlook.office.com/mail/id/example');
  assert.equal(sourceUrl(null), null);
  for (const url of ['javascript:alert(1)', 'file:///private', 'not a URL', 'https://user:password@example.com']) {
    assert.equal(sourceUrl(url), null);
  }
});

test('draft endpoint handles article/email, missing content, invalid IDs and AI failure without writes or live calls', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let source = { title: 'Source', body: 'A public product announcement.', source: 'email', url: 'https://outlook.office.com/mail/id/example' };
  let found = true;
  let invalidReply = false;
  const queries: string[] = [];
  const query = mock.method(getDb(), 'query', async (sql: string, values: unknown[]) => {
    queries.push(sql);
    assert.match(sql, /^SELECT title, body, source, url/);
    assert.match(sql, /source IN \('email', 'discovered-article'\)/);
    assert.deepEqual(values, [id]);
    return { rows: found ? [source] : [] };
  });
  const chat = mock.method(getFoundryClient('discover-linkedin'), 'chat', async (model, messages, tokens) => {
    assert.equal(model, 'light');
    assert.equal(tokens, 700);
    assert.match(messages[0].content, /untrusted data/);
    assert.match(messages[0].content, /private email/);
    assert.equal(JSON.parse(messages[1].content).content, source.body.slice(0, 16000));
    return invalidReply ? 'not JSON' : raw;
  });
  const app = express();
  app.use(express.json());
  app.use('/api/discover', discoverRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/discover`;
  const originalFetch = globalThis.fetch;
  const network = mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(input).startsWith(url), 'Tests must never make external requests');
    return originalFetch(input, init);
  });
  try {
    for (const kind of ['email', 'discovered-article']) {
      source = { ...source, source: kind };
      const res = await fetch(`${url}/${id}/linkedin-draft`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { success: true, data: { post: `${summary}\n\n${observation}`, sourceUrl: source.url, sourceKind: kind } });
    }
    const calls = queries.length;
    const invalidFormat = await fetch(`${url}/${id}/linkedin-draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"format":"invalid"}' });
    assert.equal(invalidFormat.status, 400);
    assert.equal(queries.length, calls);
    const short = await fetch(`${url}/${id}/linkedin-draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"format":"short"}' });
    assert.equal(short.status, 200);
    const shortResult = await short.json() as { data: { post: string; sourceUrl: string | null } };
    assert.ok(socialLength(shortResult.data.post, shortResult.data.sourceUrl) <= 280);
    const afterShort = queries.length;
    assert.equal((await fetch(`${url}/invalid/linkedin-draft`, { method: 'POST' })).status, 400);
    assert.equal(queries.length, afterShort);
    found = false;
    assert.equal((await fetch(`${url}/${id}/linkedin-draft`, { method: 'POST' })).status, 404);
    found = true;
    source.body = '';
    assert.equal((await fetch(`${url}/${id}/linkedin-draft`, { method: 'POST' })).status, 400);
    source.body = 'A public announcement.';
    invalidReply = true;
    const failure = await fetch(`${url}/${id}/linkedin-draft`, { method: 'POST' });
    assert.equal(failure.status, 502);
    assert.match(JSON.stringify(await failure.json()), /generate it again/);
  } finally {
    query.mock.restore();
    chat.mock.restore();
    network.mock.restore();
    await new Promise<void>((resolve, reject) => { server.close((err) => { if (err) reject(err); else resolve(); }); });
  }
});
