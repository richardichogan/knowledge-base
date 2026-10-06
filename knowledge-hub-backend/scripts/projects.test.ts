import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import express from 'express';
import { getDb } from '../src/db/db.js';
import { projectsRouter } from '../src/routes/projects.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

test('project dates round-trip through list, create and update without timezone conversion or 422', async () => {
  const project = {
    id: 'project-date-test', name: 'Date test', colour: 'gray', category: 'work',
    priority: 'medium', project_type: 'standard', description: '',
    start_date: '2026-07-01', target_end_date: '2026-12-01',
    gitlab_paths: [], github_repos: [], tags: [], links: [],
  };
  const query = mock.method(getDb(), 'query', async (sql: string, params: unknown[]) => {
    assert.match(sql, /to_char\(start_date, 'YYYY-MM-DD'\) AS start_date/);
    assert.match(sql, /to_char\(target_end_date, 'YYYY-MM-DD'\) AS target_end_date/);
    if (sql.startsWith('UPDATE') && sql.includes('start_date =') && !params.includes(null)) {
      assert.ok(params.includes('2026-07-01'));
      assert.ok(params.includes('2026-12-01'));
    }
    const expectedOutputs = params.find((value) => Array.isArray(value) && value.length > 0);
    return { rows: [{
      ...project,
      ...(sql.startsWith('UPDATE') && params.includes(null) ? { start_date: null, target_end_date: null } : {}),
      expected_outputs: expectedOutputs ?? [],
    }] };
  });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/projects', projectsRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/projects`;
  try {
    const list = await (await fetch(url)).json() as { data: Array<{ startDate: string; targetEndDate: string }> };
    const dates = list.data[0]!;
    assert.equal(dates.startDate, '2026-07-01');
    assert.equal(dates.targetEndDate, '2026-12-01');
    for (const method of ['POST', 'PATCH']) {
      const response = await fetch(method === 'POST' ? url : `${url}/${project.id}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: project.name, ...dates }),
      });
      assert.equal(response.status, method === 'POST' ? 201 : 200);
      const body = await response.json() as { data: { startDate: string; targetEndDate: string } };
      assert.equal(body.data.startDate, dates.startDate);
      assert.equal(body.data.targetEndDate, dates.targetEndDate);
    }
    const invalid = await fetch(`${url}/${project.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-02-30' }),
    });
    assert.equal(invalid.status, 422);
    const body = await invalid.json() as { error: { message: string } };
    assert.equal(body.error.message, 'startDate must be a valid YYYY-MM-DD date');
    const invalidRange = await fetch(`${url}/${project.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: '2027-01-01' }),
    });
    assert.equal(invalidRange.status, 422);
    const clear = await fetch(`${url}/${project.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: null, targetEndDate: null }),
    });
    assert.equal(clear.status, 200);
    const cleared = await clear.json() as { data: { startDate: null; targetEndDate: null } };
    assert.equal(cleared.data.startDate, null);
    assert.equal(cleared.data.targetEndDate, null);
    const outputs = Array.from({ length: 40 }, (_, i) => `Output ${i}: ${'Detailed delivery scope. '.repeat(150)}`.trim());
    for (const method of ['POST', 'PATCH']) {
      const saved = await fetch(method === 'POST' ? url : `${url}/${project.id}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: project.name, expectedOutputs: outputs }),
      });
      assert.equal(saved.status, method === 'POST' ? 201 : 200);
      const result = await saved.json() as { data: { expectedOutputs: string[] } };
      assert.deepEqual(result.data.expectedOutputs, outputs);
    }
    for (const expectedOutputs of [[''], ['   '], [42], 'not an array']) {
      const invalidOutputs = await fetch(`${url}/${project.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedOutputs }),
      });
      assert.equal(invalidOutputs.status, 422);
    }
  } finally {
    query.mock.restore();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  }
});
