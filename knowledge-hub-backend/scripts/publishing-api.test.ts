import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { publishingFixture } from './publishing-fixture.js';
import type { PublishingFeed } from '../src/publishing/contracts.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/publishing-api';
const { createPublishingRouter } = await import('../src/routes/publishing.js');
const { createJobsRouter } = await import('../src/routes/jobs.js');
const { executePublishingTool } = await import('../src/ai/publishingTools.js');
const { env } = await import('../src/config/env.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

test('chat proposes the same two feed settings; only user confirmation changes them, with audit and stale-write guards', async () => {
  const fixture = await publishingFixture();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { userId: 'human' }); next(); });
  app.use('/api/publishing', createPublishingRouter(() => fixture.db));
  app.use('/api/jobs', createJobsRouter(() => fixture.db));
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  async function call(path: string, method = 'GET', data?: unknown) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() as { success: boolean; data: unknown } };
  }
  const mode = env.NODE_ENV; env.NODE_ENV = 'production';
  try {
    const initial = (await call('/publishing/feeds')).body.data as PublishingFeed[];
    assert.equal(initial.length, 2); assert.ok(initial.every(f => !f.enabled));
    const feed = initial.find(f => f.id === 'bluesky')!;
    await executePublishingTool(fixture.db, { action: 'save', ...feed, enabled: true, confirmed: true }, 'chat');
    assert.ok(((await call('/publishing/feeds')).body.data as PublishingFeed[]).every(f => !f.enabled), 'model confirmation is not permission');
    await assert.rejects(executePublishingTool(fixture.db, { action: 'approve', confirmed: true }, 'chat'), /Unknown/);
    const proposals = (await call('/jobs/proposals?sessionId=chat')).body.data as Array<{ id: string }>;
    assert.equal(proposals.length, 1);
    assert.equal((await call(`/jobs/proposals/${proposals[0]!.id}/confirm`, 'POST', {})).status, 200);
    const changed = ((await call('/publishing/feeds')).body.data as PublishingFeed[]).find(f => f.id === 'bluesky')!;
    assert.equal(changed.enabled, true); assert.equal(changed.revision, 2);
    assert.equal((await call('/publishing/feeds/bluesky', 'PUT', { ...feed, enabled: false })).status, 409);
    assert.equal((await call('/publishing/feeds/unknown', 'PUT', feed)).status, 422);
    assert.equal((await call('/publishing/topics/not-a-uuid')).status, 422);
    assert.equal((await call('/publishing/history?offset=-1')).status, 422);
    assert.equal((await call('/publishing/topics?offset=bogus')).status, 422);
    assert.ok(((await call('/publishing/audit')).body.data as unknown[]).length);
    const pending = (await fixture.db.query<{ id: string }>(`INSERT INTO publishing_deliveries(identity,destination,account,status,attempted_at)
      VALUES('uncertain','bluesky','fixture','unconfirmed',NOW()-INTERVAL '20 minutes') RETURNING id`)).rows[0]!;
    const at = new Date().toISOString();
    assert.equal((await call(`/publishing/deliveries/${pending.id}/reconcile`, 'POST', { delivered: true, url: 'https://bsky.app/profile/fixture/post/id', publishedAt: at, reason: 'Verified on the profile.' })).status, 200);
    const resolved = (await fixture.db.query<{ status: string; published_at: Date }>('SELECT status,published_at FROM publishing_deliveries WHERE id=$1', [pending.id])).rows[0]!;
    assert.equal(resolved.status, 'sent'); assert.equal(new Date(resolved.published_at).toISOString(), at);
    assert.equal((await call(`/publishing/deliveries/${pending.id}/reconcile`, 'POST', { delivered: false })).status, 422);
    env.NODE_ENV = 'development';
    assert.equal((await call('/publishing/feeds/bluesky', 'PUT', { ...changed, enabled: false })).status, 422);
    await assert.rejects(executePublishingTool(fixture.db, { action: 'save', ...changed }, 'chat'), /disabled/);
    assert.equal((await call('/publishing/feeds')).status, 200, 'development reads remain available');
  } finally { env.NODE_ENV = mode; await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close(); }
});
