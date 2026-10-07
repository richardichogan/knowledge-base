import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import express from 'express';
import { getDb } from '../src/db/db.js';
import { getFoundryClient } from '../src/ai/foundryClient.js';
import { parseLinkedInDraft, sourceUrl } from '../src/ai/linkedInDraft.js';
import { discoverRouter } from '../src/routes/discover.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const summary = 'Microsoft has announced a new management capability for cloud environments.';
const observation = 'For enterprise IT, this could simplify governance across teams.';
const raw = JSON.stringify({ summary, observation });

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
    assert.equal((await fetch(`${url}/invalid/linkedin-draft`, { method: 'POST' })).status, 400);
    assert.equal(queries.length, calls);
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
