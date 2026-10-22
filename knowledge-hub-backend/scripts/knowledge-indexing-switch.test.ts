import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { isIndexingAdmin } from '../src/routes/knowledgeIndexingAdmin.js';
import {
  assertBulkIndexingEnabled, BulkIndexingDisabledError, getBulkIndexingSwitch, isBulkIndexingEnabled, setBulkIndexingEnabled,
} from '../src/services/knowledge/indexingSwitch.js';
import { estimateIndexingBackfill, getWork } from '../src/services/knowledge/indexingWork.js';
import { bulkReconcileIndexingBacklog, drainIndexingWork, kickIndexingWork } from '../src/services/knowledge/indexingWorkRunner.js';
import { insertContent, phase2Db } from './knowledge-phase2-fixture.js';

async function switchDb(): Promise<Awaited<ReturnType<typeof phase2Db>>> {
  const db = await phase2Db();
  await db.exec(await readFile(new URL('../src/db/migrations/091_knowledge_indexing_switch.sql', import.meta.url), 'utf8'));
  return db;
}

test('SWITCH-01 bulk indexing defaults OFF and the setting persists across reads', async () => {
  const db = await switchDb();
  assert.equal(await isBulkIndexingEnabled(db), false);
  await assert.rejects(assertBulkIndexingEnabled(db), BulkIndexingDisabledError);
  const on = await setBulkIndexingEnabled(db, true, 'admin');
  assert.equal(on.enabled, true);
  assert.equal(on.updatedBy, 'admin');
  assert.equal((await getBulkIndexingSwitch(db)).enabled, true);
  await setBulkIndexingEnabled(db, false, 'admin');
  assert.equal(await isBulkIndexingEnabled(db), false);
});

test('SWITCH-02 an unreadable switch fails closed (OFF)', async () => {
  const db = await phase2Db();
  assert.equal(await isBulkIndexingEnabled(db), false);
});

test('SWITCH-03 the bulk drain and bulk reconcile are blocked while OFF and run when ON', async () => {
  const db = await switchDb();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  assert.equal(await drainIndexingWork(db as unknown as Pool), null);
  assert.equal((await getWork(db, id))?.attempts, 0);
  await assert.rejects(bulkReconcileIndexingBacklog(db as unknown as Pool), BulkIndexingDisabledError);
  await setBulkIndexingEnabled(db, true, 'admin');
  assert.notEqual(await drainIndexingWork(db as unknown as Pool), null);
  assert.equal((await getWork(db, id))?.attempts, 1);
  const page = await bulkReconcileIndexingBacklog(db as unknown as Pool);
  assert.equal(page.scanned >= 0, true);
});

test('SWITCH-04 per-write indexing is not gated by the switch', async () => {
  const db = await switchDb();
  const id = await insertContent(db, { sourceId: 'n', body: 'x' });
  kickIndexingWork(db as unknown as Pool);
  for (let i = 0; i < 50 && (await getWork(db, id))?.attempts === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await getWork(db, id))?.attempts, 1, 'the kick claimed and attempted the work while the switch is OFF');
});

test('SWITCH-05 dry-run estimates stay available while OFF and write nothing', async () => {
  const db = await switchDb();
  await insertContent(db, { sourceId: 'n', body: 'x'.repeat(3500) });
  const before = (await db.query(`SELECT count(*)::int AS n FROM knowledge_indexing_work`)).rows;
  const estimate = await estimateIndexingBackfill(db);
  assert.equal(estimate.items, 1);
  assert.deepEqual((await db.query(`SELECT count(*)::int AS n FROM knowledge_indexing_work`)).rows, before);
});

test('SWITCH-06 the admin route authenticates by x-cron-secret only and fails closed', () => {
  const req = (headers: Record<string, string>): Request => ({ headers, query: { secret: 's3cret' } }) as unknown as Request;
  assert.equal(isIndexingAdmin(req({ 'x-cron-secret': 's3cret' }), 's3cret'), true);
  assert.equal(isIndexingAdmin(req({ 'x-cron-secret': 'wrong' }), 's3cret'), false);
  assert.equal(isIndexingAdmin(req({}), 's3cret'), false, 'query-string secrets are not accepted');
  assert.equal(isIndexingAdmin(req({ 'x-cron-secret': '' }), undefined), false);
  assert.equal(isIndexingAdmin(req({ 'x-cron-secret': '' }), ''), false);
});

test('SWITCH-07 the typed disabled error carries a stable code and status', () => {
  const err = new BulkIndexingDisabledError();
  assert.equal(err.code, 'BULK_INDEXING_DISABLED');
  assert.equal(err.statusCode, 409);
});
