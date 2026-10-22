import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { applyMigrations } from '../src/db/migrate.js';
import { assertSafeDatabase, createRuntime } from '../src/runtime.js';
import { ukClock } from '../src/sync/ukClock.js';
import { createSyncRun, getSyncRun, recordSyncProgress, recoverInterruptedWork, runClaimedJob, syncOutcome } from '../src/sync/runStore.js';
import { getPendingTurn, setPendingTurn } from '../src/ai/chatSessionStore.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { startSyncScheduler, stopSyncScheduler } from '../src/sync/scheduler.js';
import { INITIAL_SYNC_DELAY_MS } from '../src/config/constants.js';

test('liveness stays available while readiness reports startup/failure and becomes ready only explicitly', async () => {
  let phase: 'starting' | 'failed' | 'ready' | 'stopping' = 'starting';
  const app = createApp(() => phase);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const read = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`);
  try {
    assert.equal((await read('/health')).status, 200);
    assert.equal((await read('/ready')).status, 503);
    phase = 'failed';
    assert.equal((await read('/ready')).status, 503);
    phase = 'ready';
    assert.equal((await read('/ready')).status, 200);
    phase = 'stopping';
    assert.equal((await read('/ready')).status, 503);
  } finally { await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); }
});

test('scheduler stop clears the initial timeout as well as interval timers', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(env, 'NODE_ENV')!;
  const pool = getDb();
  let queries = 0;
  const query = mock.method(pool, 'query', async () => { queries++; return { rows: [] }; });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    assert.throws(() => startSyncScheduler(), /production mode/);
    Object.defineProperty(env, 'NODE_ENV', { value: 'production', configurable: true });
    startSyncScheduler();
    startSyncScheduler();
    stopSyncScheduler();
    await Promise.resolve();
    const before = queries;
    mock.timers.tick(INITIAL_SYNC_DELAY_MS + 600_000);
    await Promise.resolve();
    assert.equal(queries, before, 'Stopped timers cannot start integration work');
  } finally {
    stopSyncScheduler();
    mock.timers.reset();
    Object.defineProperty(env, 'NODE_ENV', descriptor);
    query.mock.restore();
  }
});

test('failed initialization never becomes ready or starts jobs; shutdown is idempotent and bounded', async () => {
  let jobs = 0;
  let closes = 0;
  const exits: number[] = [];
  const runtime = createRuntime({
    initialize: async () => { throw new Error('Migration failure'); },
    startJobs: () => { jobs++; }, stopJobs: () => {},
    closeServer: async () => { closes++; }, closeDatabase: async () => {},
    exit: code => { exits.push(code); }, logError: () => {},
  });
  await assert.rejects(runtime.start(), /Migration failure/);
  assert.equal(runtime.phase, 'failed');
  assert.equal(jobs, 0);
  await Promise.all([runtime.stop(1), runtime.stop(1)]);
  assert.equal(closes, 1);
  assert.deepEqual(exits, [1]);
  let release!: () => void;
  const slow = createRuntime({
    initialize: async () => {}, startJobs: () => {}, stopJobs: () => {},
    closeServer: () => new Promise(resolve => { release = resolve; }), closeDatabase: async () => {},
    exit: code => { exits.push(code); }, logError: () => {},
  }, 10);
  const stopping = slow.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(exits.at(-1), 1);
  release();
  await stopping;
  assert.deepEqual(exits, [1, 1], 'A late shutdown cannot exit twice or replace a forced failure with success');
});
test('shutdown still closes the database after job or server cleanup fails', async () => {
  let databaseClosed = false;
  const errors: unknown[] = [];
  const exits: number[] = [];
  const runtime = createRuntime({
    initialize: async () => {}, startJobs: () => {},
    stopJobs: () => { throw new Error('Job cleanup failed'); },
    closeServer: async () => { throw new Error('Server cleanup failed'); },
    closeDatabase: async () => { databaseClosed = true; },
    exit: code => { exits.push(code); }, logError: (_message, error) => { errors.push(error); },
  });
  await runtime.stop();
  assert.equal(databaseClosed, true);
  assert.equal(errors.length, 2);
  assert.deepEqual(exits, [1]);
});
test('shutdown during startup cannot start schedulers; non-production requires an explicit safe DB', async () => {
  let finish!: () => void;
  let jobs = 0;
  const runtime = createRuntime({
    initialize: () => new Promise(resolve => { finish = resolve; }), startJobs: () => { jobs++; },
    stopJobs: () => {}, closeServer: async () => {}, closeDatabase: async () => {}, exit: () => {}, logError: () => {},
  });
  const starting = runtime.start();
  await runtime.stop();
  finish();
  await starting;
  assert.equal(jobs, 0);
  assert.throws(() => assertSafeDatabase('', 'postgresql://localhost/test', 'development'), /DATABASE_MODE/);
  assert.throws(() => assertSafeDatabase('local', 'postgresql://remote.invalid/prod', 'test'), /DATABASE_MODE/);
  assert.doesNotThrow(() => assertSafeDatabase('local', 'postgresql://127.0.0.1/test', 'development'));
  assert.doesNotThrow(() => assertSafeDatabase('disposable', 'postgresql://fixture.invalid/test', 'test'));
  assert.doesNotThrow(() => assertSafeDatabase('production', 'postgresql://remote.invalid/prod', 'development'));
  assert.throws(() => assertSafeDatabase('production', 'postgresql://remote.invalid/prod', 'test'), /DATABASE_MODE/);
  assert.throws(() => assertSafeDatabase('', 'postgresql://remote.invalid/prod', 'development'), /DATABASE_MODE/);
});
test('UK clock handles midnight, DST and weekly keys regardless of host timezone', () => {
  assert.equal(ukClock(new Date('2026-07-05T23:30:00Z')).day, '2026-07-06');
  assert.equal(ukClock(new Date('2026-07-06T07:00:00Z')).hour, 8);
  assert.equal(ukClock(new Date('2026-01-05T08:00:00Z')).hour, 8);
  assert.equal(ukClock(new Date('2026-03-29T01:00:00Z')).hour, 2);
  assert.equal(ukClock(new Date('2026-10-25T01:00:00Z')).hour, 1);
  assert.equal(ukClock(new Date('2026-07-05T23:30:00Z')).week, '2026-07-06');
});
test('migration runners serialize on one connection and failure rolls back SQL plus tracking', async () => {
  const db = new PGlite();
  const pool = getDb();
  let lock: Promise<void> = Promise.resolve();
  let applied = 0;
  const connect = mock.method(pool, 'connect', async () => {
    let unlock = (): void => {};
    return {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('pg_advisory_lock(')) {
          const previous = lock;
          lock = new Promise(resolve => { unlock = resolve; });
          await previous;
          return { rows: [] };
        }
        if (sql.includes('pg_advisory_unlock(')) { unlock(); return { rows: [] }; }
        if (sql.includes('INSERT INTO once_only')) applied++;
        return db.query(sql, values);
      },
      release: () => {},
    };
  });
  try {
    const schema = 'CREATE TABLE IF NOT EXISTS once_only (id INTEGER PRIMARY KEY)';
    const migrations = [{ filename: '001.sql', sql: 'INSERT INTO once_only VALUES (1)' }];
    await Promise.all([applyMigrations(pool, schema, migrations), applyMigrations(pool, schema, migrations)]);
    assert.equal(applied, 1);
    await assert.rejects(applyMigrations(pool, schema, [{ filename: '002.sql',
      sql: 'INSERT INTO once_only VALUES (2); SELECT * FROM nonexistent_table;' }]));
    assert.deepEqual((await db.query('SELECT id FROM once_only')).rows, [{ id: 1 }]);
    assert.deepEqual((await db.query('SELECT filename FROM applied_migrations')).rows, [{ filename: '001.sql' }]);
  } finally { connect.mock.restore(); await db.close(); }
});
test('durable runs and claims track partial outcomes, interruptions and never replay claimed work', async () => {
  const db = new PGlite();
  await db.exec('CREATE TABLE ai_chat_sessions (id TEXT PRIMARY KEY, pending_turn JSONB)');
  await db.exec(await readFile(new URL('../src/db/migrations/065_runtime_runs.sql', import.meta.url), 'utf8'));
  const pool = getDb();
  const query = mock.method(pool, 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  try {
    const first = await createSyncRun(pool, 'sync:2026-10-12:8');
    assert.ok(first);
    assert.equal(await createSyncRun(pool), null);
    const results = [{ source: 'good', indexed: 2, errors: 0, durationMs: 1 },
      { source: 'bad', indexed: 0, errors: 1, durationMs: 2 }];
    assert.equal(syncOutcome(results), 'partial');
    assert.equal(syncOutcome([results[1]!]), 'failed');
    await recordSyncProgress(pool, first.id, results, 'partial');
    assert.equal((await getSyncRun(pool, first.id))?.status, 'partial');
    assert.equal(await createSyncRun(pool, 'sync:2026-10-12:8'), null);
    const second = await createSyncRun(pool);
    assert.ok(second);
    let executions = 0;
    await runClaimedJob(pool, 'weekly', '2026-10-12', async () => { executions++; });
    assert.equal(await runClaimedJob(pool, 'weekly', '2026-10-12', async () => { executions++; }), false);
    await assert.rejects(runClaimedJob(pool, 'failing', 'day', async () => { throw new Error('integration unavailable'); }));
    assert.equal(await runClaimedJob(pool, 'failing', 'day', async () => { executions++; }), false);
    assert.equal(executions, 1);
    await setPendingTurn(pool, 'session', { turnId: 'old', message: 'Do an action', startedAt: '2026-10-12' });
    await assert.rejects(setPendingTurn(pool, 'session', { turnId: 'duplicate', message: 'Repeat', startedAt: '' }), /already running/);
    await recoverInterruptedWork(pool);
    assert.equal((await getSyncRun(pool, second.id))?.status, 'interrupted');
    assert.equal((await getPendingTurn(pool, 'session'))?.status, 'interrupted');
    await setPendingTurn(pool, 'session', { turnId: 'new', message: 'Explicit user request', startedAt: '' });
    await setPendingTurn(pool, 'session', null, 'old');
    assert.equal((await getPendingTurn(pool, 'session'))?.turnId, 'new');
    await setPendingTurn(pool, 'session', null, 'new');
    assert.equal(await getPendingTurn(pool, 'session'), null);
  } finally { query.mock.restore(); await db.close(); }
});
