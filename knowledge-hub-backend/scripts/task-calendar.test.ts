import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { tasksRouter, rowToTask } from '../src/routes/tasks.js';
import { timelineRouter } from '../src/routes/timeline.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { positiveInteger, queryDate } from '../src/utils/queryValidation.js';
import { queryTimeline } from '../src/db/queries.js';

test('pagination rejects malformed, unsafe and non-positive inputs; ISO dates reject rollover', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', '9007199254740992', ['1'], {}]) {
    assert.throws(() => positiveInteger(value, 'page', 1), /positive integer/);
  }
  assert.equal(positiveInteger(undefined, 'page', 20), 20);
  assert.equal(positiveInteger('999', 'pageSize', 20, 100), 100);
  for (const value of ['', 'invalid', '2026-02-30', '2026-13-01', '2026-01-01T24:00:00Z', ['2026-01-01']]) {
    assert.throws(() => queryDate(value, 'since'), /valid date/);
  }
  assert.equal(queryDate('2026-10-12', 'since'), '2026-10-12T00:00:00.000Z');
  assert.equal(queryDate('2026-10-12T00:00:00+01:00', 'since'), '2026-10-11T23:00:00.000Z');
});

test('task DATE mapper preserves pg local midnight during British summer time', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    assert.equal(rowToTask({ due_date: new Date('2026-10-12T00:00:00') }).dueDate, '2026-10-12');
    assert.equal(rowToTask({ due_date: '2026-10-12' }).dueDate, '2026-10-12');
    assert.equal(rowToTask({ task_type: 'cert_review' }).task_type, 'cert_review');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('isolated task routes round-trip types and dates, create one successor, and roll back coupled failures', async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, title TEXT NOT NULL, body TEXT DEFAULT '',
    status TEXT DEFAULT 'backlog', project_id TEXT DEFAULT 'personal', tags TEXT[] DEFAULT '{}',
    priority TEXT DEFAULT 'normal', due_date DATE, start_date DATE, end_date DATE, external_url TEXT,
    linked_tag_id UUID, recurring_cadence TEXT, archived BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE tags (id UUID PRIMARY KEY);
    CREATE TABLE task_tags (
      task_id TEXT REFERENCES tasks(id), tag_id UUID REFERENCES tags(id), source TEXT DEFAULT 'manual',
      PRIMARY KEY (task_id, tag_id));
    CREATE TABLE tag_rejections (content_kind TEXT, content_id TEXT, tag_id UUID,
      PRIMARY KEY(content_kind,content_id,tag_id));
    INSERT INTO tags VALUES ('11111111-1111-4111-8111-111111111111');`);
  const migration = await readFile(new URL('../src/db/migrations/063_task_recurrence_identity.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const pool = getDb();
  // PGlite has one session. Serialize fixture clients to emulate transaction locks.
  let available = Promise.resolve();
  let failure = false;
  const queries: string[] = [];
  const connect = mock.method(pool, 'connect', async () => {
    const previous = available;
    let release!: () => void;
    available = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return {
      query: async (sql: string, values?: unknown[]) => {
        queries.push(sql);
        if (failure && sql.startsWith('INSERT INTO task_tags')) throw new Error('Fixture tag failure');
        return db.query(sql, values);
      },
      release,
    };
  });
  const query = mock.method(pool, 'query', async (sql: string, values?: unknown[]) => {
    if (sql.includes('INSERT INTO content_items')) return { rows: [{ id: '', is_new: false }] };
    return db.query(sql, values);
  });
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/tasks`;
  const write = async (url: string, method: string, body: unknown) => fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const created = await write(base, 'POST', {
      title: 'Recurring review', task_type: 'cert_review', startDate: '2026-10-24',
      dueDate: '2026-10-25', recurringCadence: 'daily',
      taxonomyTagIds: ['11111111-1111-4111-8111-111111111111'],
    });
    assert.equal(created.status, 201);
    const { data: task } = await created.json() as { data: { id: string; task_type: string; dueDate: string } };
    assert.equal(task.task_type, 'cert_review');
    assert.equal(task.dueDate, '2026-10-25');
    const list = await (await fetch(base)).json() as { data: { items: Array<{ id: string; task_type: string }> } };
    assert.equal(list.data.items[0]?.task_type, 'cert_review');
    const url = `${base}/${task.id}`;
    const completed = await Promise.all([write(url, 'PATCH', { status: 'completed' }), write(url, 'PATCH', { status: 'completed' })]);
    assert.deepEqual(completed.map((response) => response.status), [200, 200]);
    const successors = await db.query<{ id: string; task_type: string; start_date: string; due_date: string }>(
      'SELECT * FROM tasks WHERE recurring_parent_id = $1', [task.id],
    );
    assert.equal(successors.rows.length, 1);
    assert.equal(successors.rows[0]?.task_type, 'cert_review');
    assert.equal(rowToTask(successors.rows[0]!).startDate, '2026-10-25');
    assert.equal(rowToTask(successors.rows[0]!).dueDate, '2026-10-26');
    await write(url, 'PATCH', { status: 'backlog' });
    await write(url, 'PATCH', { status: 'completed', task_type: 'cert_session' });
    assert.equal((await db.query('SELECT id FROM tasks WHERE recurring_parent_id = $1', [task.id])).rows.length, 1);
    assert.equal((await db.query('SELECT task_type FROM tasks WHERE id = $1', [task.id])).rows[0]?.task_type, 'cert_session');
    assert.ok(queries.some((sql) => /SELECT status .*FOR UPDATE/.test(sql)));
    const nextFixture = await write(base, 'POST', {
      title: 'Rollback recurrence', startDate: '2026-10-24', recurringCadence: 'daily',
      taxonomyTagIds: ['11111111-1111-4111-8111-111111111111'],
    });
    const nextTask = (await nextFixture.json() as { data: { id: string; task_type: string } }).data;
    assert.equal(nextTask.task_type, 'standard');
    failure = true;
    const before = (await db.query('SELECT count(*)::int AS n FROM tasks')).rows[0]?.n;
    assert.equal((await write(base, 'POST', { title: 'Must roll back', taxonomyTagIds: ['11111111-1111-4111-8111-111111111111'] })).status, 500);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM tasks')).rows[0]?.n, before);
    const rolledBack = await write(url, 'PATCH', {
      title: 'Must not persist', taxonomyTagIds: ['11111111-1111-4111-8111-111111111111'],
    });
    assert.equal(rolledBack.status, 500);
    assert.equal((await db.query('SELECT title FROM tasks WHERE id = $1', [task.id])).rows[0]?.title, 'Recurring review');
    assert.equal((await db.query('SELECT tag_id FROM task_tags WHERE task_id = $1', [task.id])).rows.length, 1);
    assert.equal((await write(`${base}/${nextTask.id}`, 'PATCH', { status: 'completed' })).status, 500);
    assert.equal((await db.query('SELECT status FROM tasks WHERE id = $1', [nextTask.id])).rows[0]?.status, 'backlog');
    assert.equal((await db.query('SELECT id FROM tasks WHERE recurring_parent_id = $1', [nextTask.id])).rows.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    connect.mock.restore();
    query.mock.restore();
    await db.close();
  }
});

test('range SQL includes scheduled external tasks and exact boundaries with stable multi-page ordering', async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE content_items (
    id TEXT PRIMARY KEY, source TEXT, source_id TEXT, title TEXT DEFAULT '', summary TEXT DEFAULT '',
    published_at TIMESTAMPTZ, indexed_at TIMESTAMPTZ DEFAULT now(), url TEXT, project_context TEXT,
    metadata JSONB DEFAULT '{}', tags TEXT[] DEFAULT '{}');
    CREATE TABLE content_item_tags (content_item_id TEXT, tag_id UUID);
    CREATE TABLE note_github_publications (repo TEXT, path TEXT);
    INSERT INTO content_items(id,source,source_id,published_at)
      SELECT lpad(i::text,3,'0'),'note',i::text,'2026-10-12T10:00:00Z' FROM generate_series(1,101) i;
    INSERT INTO content_items(id,source,source_id,published_at,metadata) VALUES
      ('external','graph-todo','external','2020-01-01','{"dueDateTime":"2026-10-14T00:00:00Z","status":"notStarted"}'),
      ('start','graph-calendar','start','2026-10-12T00:00:00Z','{}'),
      ('end','graph-calendar','end','2026-10-19T00:00:00Z','{}'),
      ('undated','graph-todo','undated','2026-10-14T00:00:00Z','{}');`);
  const query = mock.method(getDb(), 'query', (sql: string, params?: unknown[]) => db.query(sql, params));
  try {
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await queryTimeline(getDb(), {
        rangeStart: '2026-10-12T00:00:00Z', rangeEnd: '2026-10-19T00:00:00Z', page, pageSize: 50,
      });
      assert.equal(result.total, 103);
      ids.push(...result.items.map((item) => item.id));
    }
    assert.equal(new Set(ids).size, 103);
    assert.ok(ids.includes('start') && ids.includes('external'));
    assert.ok(!ids.includes('end') && !ids.includes('undated'));
    assert.deepEqual(ids.slice(0, 2), ['101', '100']);
  } finally {
    query.mock.restore();
    await db.close();
  }
});

test('timeline rejects invalid range and pagination before querying persistence', async () => {
  const query = mock.method(getDb(), 'query', async () => { throw new Error('Unexpected database access'); });
  const app = express();
  app.use('/api/timeline', timelineRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    for (const search of [
      'page=0', 'pageSize=-1', 'before=bad', 'rangeStart=2026-10-12',
      'rangeStart=2026-10-12&rangeEnd=2026-10-11',
      'rangeStart=2026-10-12&rangeEnd=2026-10-19&since=2026-10-10',
    ]) {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/timeline?${search}`)).status, 422);
    }
    assert.equal(query.mock.callCount(), 0);
  } finally {
    query.mock.restore();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
