import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { addPublishingSchema } from './publishing-fixture.js';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/jobs-api';
const { createJobsRouter } = await import('../src/routes/jobs.js');
const { env } = await import('../src/config/env.js');
const { executeJobTool } = await import('../src/ai/jobTools.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

test('chat and UI share versioned jobs; confirmation is a user endpoint, not a model boolean', async () => {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL('../src/db/migrations/099_managed_jobs.sql', import.meta.url), 'utf8'));
  await addPublishingSchema(pg);
  const query = async (sql: string, values?: unknown[]) => {
    const r = await pg.query(sql, values); return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { userId: 'fixture-user' }); next(); });
  app.use('/api/jobs', createJobsRouter(() => db));
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/jobs`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as { success: boolean; data: Record<string, unknown> & Array<Record<string, unknown>> } };
  };
  const oldMode = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    const config = { name: 'Chat-designed job', kind: 'prompt', prompt: 'Review Microsoft announcements.', schedule: { timezone: 'Europe/London', days: [1, 2, 3, 4, 5], times: ['06:00'] },
      approval: 'required', deviceId: '', inputFolder: '', outputFolder: '', outputs: ['think'] };
    await executeJobTool(db, { action: 'save', definition: config, enabled: true, confirmed: true }, 'fixture-chat');
    assert.equal((await call('')).body.data.length, 3, 'model-supplied confirmation cannot enable a job');
    const proposals = (await call('/proposals?sessionId=fixture-chat')).body.data;
    assert.equal(proposals.length, 1);
    const confirmed = await call(`/proposals/${proposals[0]!.id}/confirm`, 'POST', {});
    assert.equal(confirmed.status, 200);
    const jobId = confirmed.body.data.id;
    assert.equal(confirmed.body.data.enabled, true);
    assert.equal((await call(`/proposals/${proposals[0]!.id}/confirm`, 'POST', {})).status, 409);
    assert.equal((await call(`/${jobId}`, 'PUT', { definition: config, revision: 0, enabled: true })).status, 422);
    assert.equal((await call(`/${jobId}/pause`, 'POST', {})).status, 200);
    assert.equal((await call(`/${jobId}/run`, 'POST', { preview: false })).status, 422, 'paused jobs do not publish through run-now');
    assert.equal((await call(`/${jobId}/run`, 'POST', { preview: true })).status, 200);
    assert.equal((await call('/runs?jobId=not-a-uuid')).status, 422);
    assert.ok((await call(`/audit?jobId=${jobId}`)).body.data.length >= 3);
    await call('/desktop/claim', 'POST', { deviceId: 'fixture-device', deviceName: 'Fixture PC', folders: [{ id: 'f', name: 'Reports', path: 'C:\\Reports' }] });
    const importConfig = { ...config, name: 'Report import', kind: 'm365-import', outputs: [], deviceId: 'fixture-device', inputFolder: 'C:\\Reports' };
    assert.equal((await call('', 'POST', { definition: { ...importConfig, inputFolder: 'C:\\Not authorised' }, enabled: true })).status, 422);
    const imported = await call('', 'POST', { definition: importConfig, enabled: true });
    assert.equal(imported.status, 200);
    const importId = imported.body.data.id;
    const queued = await call(`/${importId}/run`, 'POST', { preview: false });
    await query("UPDATE managed_job_runs SET status='waiting-file' WHERE id=$1", [queued.body.data.id]);
    const device = await call('/desktop/claim', 'POST', { deviceId: 'fixture-device', deviceName: 'Fixture PC', folders: [{ id: 'f', name: 'Reports', path: 'C:\\Reports' }] });
    assert.equal(device.body.data.managedImport, true);
    const work = device.body.data.work as { lease: string; run: { id: string } };
    const wrongDate = await call(`/desktop/${work.run.id}/result`, 'POST', { deviceId: 'fixture-device', lease: work.lease, filename: 'Daily-Briefing-2000-01-01.md', text: 'must not ingest' });
    assert.equal(wrongDate.status, 422);
    assert.equal((await call(`/runs/${work.run.id}`)).body.data.status, 'failed', 'failed capture is not stranded as a running run without a lease');
    assert.equal((await call(`/desktop/${work.run.id}/result`, 'POST', { deviceId: 'fixture-device', lease: work.lease, waiting: true })).status, 409);
    env.NODE_ENV = 'development';
    assert.equal((await call(`/${jobId}/run`, 'POST', { preview: true })).status, 422, 'local servers cannot run live production jobs');
    await assert.rejects(executeJobTool(db, { action: 'pause', id: jobId }, 'fixture-chat'), /Development servers/);
  } finally {
    env.NODE_ENV = oldMode;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pg.close();
  }
});
