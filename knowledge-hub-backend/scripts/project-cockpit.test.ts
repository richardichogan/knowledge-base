import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { projectCockpitRouter } from '../src/routes/projectCockpit.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import type { Pool } from 'pg';

const SESSION_A = '00000000-0000-4000-8000-00000000000a';
const SESSION_B = '00000000-0000-4000-8000-00000000000b';

async function fixtureDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, goal TEXT DEFAULT '', lifecycle_state TEXT DEFAULT 'active',
      expected_outputs TEXT[] DEFAULT '{}', target_end_date DATE);
    CREATE TABLE tasks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT, title TEXT, status TEXT DEFAULT 'backlog',
      project_id TEXT REFERENCES projects(id), due_date DATE, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content TEXT, status TEXT DEFAULT 'active',
      project_id TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE ai_chat_sessions (id UUID PRIMARY KEY, project_id TEXT);
    CREATE TABLE chat_decisions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID REFERENCES ai_chat_sessions(id),
      status TEXT, text TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE chat_outputs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID REFERENCES ai_chat_sessions(id),
      title TEXT, kind TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE chat_output_versions (output_id UUID, version INT);
    INSERT INTO projects (id, name, goal) VALUES ('p1', 'One', 'Ship it'), ('p2', 'Two', '');
    INSERT INTO ai_chat_sessions VALUES ('${SESSION_A}', 'p1'), ('${SESSION_B}', 'p2');
    INSERT INTO tasks (id, title, status, project_id) VALUES ('t1','Do','in-progress','p1'),('t2','Stuck','waiting','p1'),('t3','Other','waiting','p2');
    INSERT INTO notes (content, project_id) VALUES ('p1 note','p1'),('p2 note','p2'),('unassigned',NULL);
    INSERT INTO chat_decisions (id, session_id, status, text) VALUES
      ('00000000-0000-4000-8000-0000000000d1','${SESSION_A}','open','Which vendor?'),
      ('00000000-0000-4000-8000-0000000000d2','${SESSION_B}','open','Other project decision');
    INSERT INTO chat_outputs (id, session_id, title, kind) VALUES ('00000000-0000-4000-8000-0000000000e1','${SESSION_A}','Spec','spec');
    INSERT INTO chat_output_versions VALUES ('00000000-0000-4000-8000-0000000000e1', 1), ('00000000-0000-4000-8000-0000000000e1', 2);
  `);
  await db.exec(await readFile(new URL('../src/db/migrations/068_project_register.sql', import.meta.url), 'utf8'));
  return db;
}

async function withApp<T>(db: PGlite, run: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<T>): Promise<T> {
  const query = (sql: string, params?: unknown[]): Promise<unknown> => db.query(sql, params as never[]);
  const stub = mock.method(getDb(), 'query', query as never);
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectCockpitRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  try {
    return await run(async (method, path, body) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/projects${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, json: text === '' ? null : JSON.parse(text) };
    });
  } finally {
    server.close();
    stub.mock.restore();
  }
}

test('cockpit is strictly project-scoped and reports counts with deep links', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const { status, json } = await call('GET', '/p1/cockpit');
    assert.equal(status, 200);
    const c = json.data;
    assert.equal(c.outcome.data.goal, 'Ship it');
    assert.deepEqual(c.commitments.data.map((i: { label: string }) => i.label), ['Do']);
    assert.deepEqual(c.blockers.data.map((i: { label: string }) => i.label), ['Stuck']);
    assert.equal(c.blockers.data[0].href, '/plan?taskId=t2');
    assert.deepEqual(c.notes.data.map((i: { label: string }) => i.label), ['p1 note']);
    assert.deepEqual(c.decisions.data.map((i: { label: string }) => i.label), ['Which vendor?']);
    assert.equal(c.decisions.data[0].href, `/chat?session=${SESSION_A}`);
    assert.equal(c.outputs.data[0].meta, 'spec · v2');
    assert.equal((await call('GET', '/missing/cockpit')).status, 404);
  });
});

test('a failing section degrades alone instead of failing the cockpit', async () => {
  const db = await fixtureDb();
  await db.exec('DROP TABLE chat_output_versions');
  await withApp(db, async (call) => {
    const { json } = await call('GET', '/p1/cockpit');
    assert.equal(json.data.outputs.available, false);
    assert.equal(json.data.notes.available, true);
    assert.ok(!JSON.stringify(json).includes('chat_output_versions'));
  });
});

test('register round-trips owner, due date, task link and resolution, with validation and pagination', async () => {
  const db = await fixtureDb();
  await withApp(db, async (call) => {
    const created = await call('POST', '/p1/register', { kind: 'risk', title: 'Vendor slips', owner: 'Sam', dueDate: '2026-05-01', taskId: 't1' });
    assert.equal(created.status, 201);
    const id = created.json.data.id as string;
    assert.equal(created.json.data.dueDate, '2026-05-01');
    assert.equal((await call('POST', '/p1/register', { kind: 'risk', title: 'x', taskId: 't3' })).status, 422);
    assert.equal((await call('POST', '/p1/register', { kind: 'nope', title: 'x' })).status, 422);
    assert.equal((await call('POST', '/p1/register', { kind: 'issue', title: 'x', dueDate: '2026-02-31' })).status, 422);

    const resolved = await call('PATCH', `/p1/register/${id}`, { status: 'resolved', resolution: 'Switched vendor' });
    assert.equal(resolved.json.data.status, 'resolved');
    assert.equal(resolved.json.data.resolution, 'Switched vendor');
    assert.ok(resolved.json.data.resolvedAt);
    const reopened = await call('PATCH', `/p1/register/${id}`, { status: 'open' });
    assert.equal(reopened.json.data.resolvedAt, null);
    assert.equal(reopened.json.data.owner, 'Sam');

    assert.equal((await call('PATCH', `/p2/register/${id}`, { title: 'hijack' })).status, 404);
    for (let i = 0; i < 3; i++) await call('POST', '/p1/register', { kind: 'question', title: `q${i}` });
    const page = await call('GET', '/p1/register?limit=2&offset=2&kind=question');
    assert.equal(page.json.data.total, 3);
    assert.equal(page.json.data.items.length, 1);
    assert.equal((await call('GET', '/p2/register')).json.data.total, 0);
    assert.equal((await call('DELETE', `/p1/register/${id}`)).status, 204);
  });
});

test('promoting a decision is idempotent, project-scoped and leaves the source untouched', async () => {
  const db = await fixtureDb();
  const decisionId = '00000000-0000-4000-8000-0000000000d1';
  await withApp(db, async (call) => {
    const before = (await db.query('SELECT * FROM chat_decisions ORDER BY id')).rows;
    const first = await call('POST', '/p1/register/promote', { decisionId, kind: 'question' });
    assert.equal(first.status, 201);
    const second = await call('POST', '/p1/register/promote', { decisionId, kind: 'risk' });
    assert.equal(second.status, 200);
    assert.equal(second.json.data.item.id, first.json.data.item.id);
    assert.equal(second.json.data.created, false);
    assert.equal((await call('GET', '/p1/register')).json.data.total, 1);
    assert.equal((await call('POST', '/p2/register/promote', { decisionId })).status, 404);
    assert.deepEqual((await db.query('SELECT * FROM chat_decisions ORDER BY id')).rows, before);
  });
});

void (null as unknown as Pool);
