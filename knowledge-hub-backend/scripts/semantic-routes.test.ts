import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { createSemanticDecisionsRouter } from '../src/routes/semanticDecisions.js';
import { fixtureDb, SD1, SD2, SD3 } from './semantic-fixture.js';

interface Reply { status: number; body: { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; fields?: Record<string, string> } } }

async function withApi<T>(run: (call: (method: string, path: string, body?: unknown) => Promise<Reply>, raw: Awaited<ReturnType<typeof fixtureDb>>['raw']) => Promise<T>): Promise<T> {
  const { db, raw } = await fixtureDb();
  const app = express();
  app.use(express.json());
  app.use('/api/semantic/decisions', createSemanticDecisionsRouter(() => db));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => { resolve(s); }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/semantic/decisions`;
  const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as Reply['body'] };
  };
  try { return await run(call, raw); } finally { server.close(); }
}

test('SEMROUTE-01 acceptance needs explicit confirmation, is user-confirmed and idempotent', async () => {
  await withApi(async (call) => {
    const before = await call('GET', `/${SD2}/semantics`);
    assert.equal(before.body.data?.['acceptance'], 'unknown');
    for (const body of [undefined, {}, { confirmed: 'yes' }, { confirmed: false }]) {
      const r = await call('POST', `/${SD2}/accept`, body ?? {});
      assert.equal(r.status, 400);
      assert.equal(r.body.error?.code, 'CONFIRMATION_REQUIRED');
    }
    assert.equal((await call('GET', `/${SD2}/semantics`)).body.data?.['acceptance'], 'unknown');
    const ok = await call('POST', `/${SD2}/accept`, { confirmed: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data?.['acceptance'], 'accepted');
    const stamp = ok.body.data?.['acceptedAt'];
    assert.equal((await call('POST', `/${SD2}/accept`, { confirmed: true })).body.data?.['acceptedAt'], stamp);
    assert.equal((await call('POST', '/missing/accept', { confirmed: true })).status, 404);
  });
});

test('SEMROUTE-02 review date is validated, can be cleared, and unknown decisions are typed errors', async () => {
  await withApi(async (call) => {
    const set = await call('PUT', `/${SD3}/review-date`, { reviewDate: '2026-12-01' });
    assert.equal(set.body.data?.['reviewDate'], '2026-12-01');
    for (const bad of [{ reviewDate: '2026-02-30' }, { reviewDate: '01/12/2026' }, { reviewDate: 5 }, {}]) {
      const r = await call('PUT', `/${SD3}/review-date`, bad);
      assert.equal(r.status, 400);
      assert.equal(r.body.error?.code, 'VALIDATION_ERROR');
      assert.ok(r.body.error?.fields?.['reviewDate']);
    }
    assert.equal((await call('PUT', `/${SD3}/review-date`, { reviewDate: null })).body.data?.['reviewDate'], null);
    assert.equal((await call('PUT', '/missing/review-date', { reviewDate: '2026-12-01' })).status, 404);
  });
});

test('SEMROUTE-03 links are validated: shape, dangling, cycle; inferred implements is upgraded by user confirmation', async () => {
  await withApi(async (call) => {
    const missing = await call('POST', `/${SD1}/links`, { relationship: 'blocks', counterpartId: '' });
    assert.equal(missing.status, 400);
    assert.deepEqual(Object.keys(missing.body.error?.fields ?? {}).sort(), ['counterpartId', 'relationship']);
    const dangling = await call('POST', `/${SD1}/links`, { relationship: 'implements', counterpartId: 'no-such-task' });
    assert.equal(dangling.status, 404);
    assert.equal(dangling.body.error?.code, 'EDGE_DANGLING');
    const self = await call('POST', `/${SD1}/links`, { relationship: 'supersedes', counterpartId: SD1 });
    assert.equal(self.status, 422);
    const cycle = await call('POST', `/${SD1}/links`, { relationship: 'supersedes', counterpartId: SD3, effectiveAt: '2026-10-22' });
    assert.equal(cycle.status, 409);
    assert.equal(cycle.body.error?.code, 'EDGE_CYCLE');
    const badDate = await call('POST', `/${SD1}/links`, { relationship: 'supersedes', counterpartId: SD3, effectiveAt: 'soon' });
    assert.equal(badDate.body.error?.fields?.['effectiveAt'], 'must be a valid date');
    const upgraded = await call('POST', `/${SD1}/links`, { relationship: 'implements', counterpartId: 't4' });
    assert.equal(upgraded.status, 201);
    const edge = (upgraded.body.data?.['edges'] as Array<{ from: { id: string }; relationship: string; origin: string }>).find((e) => e.relationship === 'implements' && e.from.id === 't4');
    assert.equal(edge?.origin, 'user_confirmed');
  });
});

test('SEMROUTE-04 recording a newer decision as superseded_by stores a user-confirmed edge with an effective date', async () => {
  await withApi(async (call, raw) => {
    const r = await call('POST', `/${SD3}/links`, { relationship: 'superseded_by', counterpartId: SD2, effectiveAt: '2026-11-01' });
    assert.equal(r.status, 201);
    const row = (await raw.query(`SELECT origin, effective_at FROM semantic_edges WHERE relationship = 'supersedes' AND from_id = $1 AND to_id = $2`, [SD2, SD3])).rows[0] as { origin: string } | undefined;
    assert.equal(row?.origin, 'user_confirmed');
  });
});
