import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import express from 'express';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { blobIdFromUrl } from '../src/utils/noteContent.js';
import { renderNoteAsText } from '../src/services/noteTextService.js';

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const storedUrl = `https://images.blob.core.windows.net/kb-images/${id}?sv=test#image`;
const unsupported = [
  'data:image/png;base64,86lWTieWAiWgAAAABJRU5ErkJggg==',
  `blob:https://athena.example/${id}`,
  'https://example.com/personaphoto',
  'https://example.com/picture.png',
  'https://example.com/%invalid',
  'http://[invalid',
];

test('only UUID image paths resolve to database identifiers', () => {
  assert.equal(blobIdFromUrl(storedUrl), id);
  assert.equal(blobIdFromUrl(`/api/images/${id.toUpperCase()}`), id);
  for (const url of unsupported) assert.equal(blobIdFromUrl(url), '', url);
});

test('mixed image references cannot poison vision enrichment for valid stored images', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /^SELECT id, vision_analysis FROM kb_images/);
    assert.deepEqual(values, [[id]]);
    return { rows: [{ id, vision_analysis: 'Enterprise architecture diagram' }] };
  });
  const content = (urls: string[]): string => JSON.stringify([
    { type: 'paragraph', content: [{ text: 'My notes' }] },
    ...urls.map(url => ({ type: 'image', props: { url } })),
  ]);
  try {
    const rendered = await renderNoteAsText(db, content([...unsupported, storedUrl, storedUrl]));
    assert.match(rendered, /My notes/);
    assert.match(rendered, /\[Image: Enterprise architecture diagram\]/);
    assert.match(rendered, /\[Image: no analysis available\]/);
    assert.equal(query.mock.callCount(), 1);
    await renderNoteAsText(db, content(unsupported));
    assert.equal(query.mock.callCount(), 1, 'Unsupported images do not reach Postgres');
  } finally {
    query.mock.restore();
    await db.end();
  }
});

test('ACA trusts only the verified rightmost sender and rate limiting emits no proxy warning', async () => {
  const previous = env.CONTAINER_APP_NAME;
  const errors: unknown[][] = [];
  const log = mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  let server: ReturnType<express.Application['listen']> | undefined;
  try {
    Object.defineProperty(env, 'CONTAINER_APP_NAME', { value: undefined });
    assert.equal(createApp().get('trust proxy'), false);
    Object.defineProperty(env, 'CONTAINER_APP_NAME', { value: 'kh-prod-api-vnet' });
    const app = createApp();
    assert.equal(app.get('trust proxy'), 1);
    const trust = app.get('trust proxy fn') as (ip: string, hop: number) => boolean;
    assert.equal(trust('127.0.0.1', 0), true);
    assert.equal(trust('198.51.100.10', 1), false);
    const probe = express();
    probe.set('trust proxy', app.get('trust proxy'));
    probe.get('/', (req, res) => { res.json({ ip: req.ip }); });
    server = probe.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => { server!.once('listening', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: { 'X-Forwarded-For': '192.0.2.99, 198.51.100.10' },
    });
    assert.deepEqual(await response.json(), { ip: '198.51.100.10' });
    await new Promise<void>((resolve, reject) => { server!.close(error => error ? reject(error) : resolve()); });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => { server!.once('listening', resolve); });
    const appAddress = server.address();
    assert.ok(appAddress && typeof appAddress !== 'string');
    const health = await fetch(`http://127.0.0.1:${appAddress.port}/health`, {
      headers: { 'X-Forwarded-For': '192.0.2.99, 198.51.100.10' },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('ratelimit-remaining'), '599');
    const spoofed = await fetch(`http://127.0.0.1:${appAddress.port}/health`, {
      headers: { 'X-Forwarded-For': '192.0.2.77, 198.51.100.10' },
    });
    assert.equal(spoofed.headers.get('ratelimit-remaining'), '598', 'Spoofed earlier hops cannot reset the limit');
    const otherClient = await fetch(`http://127.0.0.1:${appAddress.port}/health`, {
      headers: { 'X-Forwarded-For': '192.0.2.99, 198.51.100.11' },
    });
    assert.equal(otherClient.headers.get('ratelimit-remaining'), '599', 'Verified clients have independent limits');
    assert.equal(errors.length, 0, JSON.stringify(errors));
  } finally {
    Object.defineProperty(env, 'CONTAINER_APP_NAME', { value: previous });
    log.mock.restore();
    if (server?.listening) await new Promise<void>((resolve, reject) => {
      server!.close(error => error ? reject(error) : resolve());
    });
  }
});
