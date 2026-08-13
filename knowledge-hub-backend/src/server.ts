import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDb, warmUpDb } from './db/db.js';
import { runMigrations } from './db/migrate.js';
import { startSyncScheduler, stopSyncScheduler } from './sync/scheduler.js';

/**
 * Server entry point.
 * Runs pending DB migrations, starts Express, then launches the sync scheduler.
 * Handles SIGTERM/SIGINT for graceful shutdown.
 */
const app = createApp();

const server = app.listen(env.PORT, () => {
  console.warn(`[Server] Knowledge Hub backend running on port ${env.PORT} (${env.NODE_ENV})`);
  // Apply any pending schema/migrations before warming the pool — migrations
  // are idempotent (IF NOT EXISTS) so this is safe to run on every boot.
  void runMigrations()
    .catch((err: unknown) => {
      console.error('[Server] Migration run failed (continuing with existing schema):', err);
    })
    .finally(() => {
      // Pre-warm the DB pool before the scheduler fires so sync/edge jobs reuse
      // warm connections instead of dialing new ones through the shared SNAT pool.
      void warmUpDb().finally(() => {
        if (env.NODE_ENV !== 'development') {
          startSyncScheduler();
          return;
        }
        console.warn('[Scheduler] Development mode — scheduler disabled to keep local chat/dev stable.');
      });
    });
});

function gracefulShutdown(signal: string): void {
  console.warn(`[Server] ${signal} received — shutting down gracefully`);
  stopSyncScheduler();
  server.close(async () => {
    await closeDb();
    console.warn('[Server] Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Keep the process alive — log unhandled errors but do NOT exit
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Server] Unhandled promise rejection (continuing):', reason);
});
process.on('uncaughtException', (err: Error) => {
  console.error('[Server] Uncaught exception (continuing):', err.message);
});
