import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDb, getDb, warmUpDb } from './db/db.js';
import { runMigrations } from './db/migrate.js';
import { startSyncScheduler, stopSyncScheduler } from './sync/scheduler.js';
import { assertSafeDatabase, createRuntime } from './runtime.js';
import { recoverInterruptedWork } from './sync/runStore.js';
import { stopTurnJobs } from './ai/turnJobs.js';
import { startAgentWorker, stopAgentWorker } from './agents/index.js';
import { loadConnectionCredentials } from './services/connectionCredentials.js';
import { registerManualBlogExecutor } from './agents/workforce/dispatcher.js';
import { createManualBlogExecutor } from './agents/workforce/blogDomain.js';
import { manualBlogSourceCapabilities } from './agents/workforce/blogSources.js';
import { assertWorkforceSchemaReady } from './agents/workforce/readiness.js';

assertSafeDatabase(env.DATABASE_MODE, env.DATABASE_URL, env.NODE_ENV);
const sharedProductionDatabase = env.NODE_ENV === 'development' && env.DATABASE_MODE === 'production';
let credentialTimer: ReturnType<typeof setInterval> | undefined;
let refreshingCredentials = false;
const CREDENTIAL_REFRESH_INTERVAL_MS = 15_000;
const app = createApp(() => runtime.phase);
const server = app.listen(env.PORT, () => {
  console.warn(`[Server] Listening on port ${env.PORT} (${env.NODE_ENV}); initializing.`);
  void runtime.start().catch(() => { void runtime.stop(1); });
});
const runtime = createRuntime({
  initialize: async () => {
    if (sharedProductionDatabase) {
      console.warn('[Server] Using production data in development; automatic migrations and interrupted-work recovery are disabled.');
    } else {
      await runMigrations();
    }
    if (env.ATHENA_WORKFORCE_MANUAL_BLOG) await assertWorkforceSchemaReady(getDb());
    await loadConnectionCredentials(getDb());
    await getDb().query('SELECT 1');
    if (!sharedProductionDatabase) await recoverInterruptedWork(getDb());
    await warmUpDb();
  },
  startJobs: () => {
    if (env.ATHENA_WORKFORCE_MANUAL_BLOG) registerManualBlogExecutor(createManualBlogExecutor(getDb(), manualBlogSourceCapabilities()));
    credentialTimer = setInterval(() => {
      if (refreshingCredentials) return;
      refreshingCredentials = true;
      void loadConnectionCredentials(getDb()).catch(() => {
        console.error('[Connections] Credential refresh failed; check database connectivity and the credential encryption key.');
      }).finally(() => { refreshingCredentials = false; });
    }, CREDENTIAL_REFRESH_INTERVAL_MS);
    credentialTimer.unref();
    void startAgentWorker(getDb()).catch((error: unknown) => { console.error('[agents] Specialist worker did not start:', error); });
    if (env.NODE_ENV === 'production') startSyncScheduler();
    else console.warn('[Scheduler] Non-production mode: scheduled jobs disabled.');
  },
  stopJobs: () => { clearInterval(credentialTimer); stopSyncScheduler(); stopTurnJobs(); void stopAgentWorker(); },
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
