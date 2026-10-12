import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDb, getDb, warmUpDb } from './db/db.js';
import { runMigrations } from './db/migrate.js';
import { startSyncScheduler, stopSyncScheduler } from './sync/scheduler.js';
import { assertSafeDatabase, createRuntime } from './runtime.js';
import { recoverInterruptedWork } from './sync/runStore.js';
import { stopTurnJobs } from './ai/turnJobs.js';

assertSafeDatabase(env.DATABASE_MODE, env.DATABASE_URL, env.NODE_ENV);
const app = createApp(() => runtime.phase);
const server = app.listen(env.PORT, () => {
  console.warn(`[Server] Listening on port ${env.PORT} (${env.NODE_ENV}); initializing.`);
  void runtime.start().catch(() => { void runtime.stop(1); });
});
const runtime = createRuntime({
  initialize: async () => {
    await runMigrations();
    await getDb().query('SELECT 1');
    await recoverInterruptedWork(getDb());
    await warmUpDb();
  },
  startJobs: () => {
    if (env.NODE_ENV === 'production') startSyncScheduler();
    else console.warn('[Scheduler] Non-production mode: scheduled jobs disabled.');
  },
  stopJobs: () => { stopSyncScheduler(); stopTurnJobs(); },
  closeServer: () => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
    server.closeIdleConnections();
  }),
  closeDatabase: closeDb,
  exit: (code) => { process.exit(code); },
  logError: (message, error) => { console.error(message, error); },
});

process.on('SIGTERM', () => { void runtime.stop(); });
process.on('SIGINT', () => { void runtime.stop(); });
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Server] Unhandled promise rejection; shutting down:', reason);
  void runtime.stop(1);
});
process.on('uncaughtException', (error: Error) => {
  console.error('[Server] Uncaught exception; shutting down:', error);
  void runtime.stop(1);
});
