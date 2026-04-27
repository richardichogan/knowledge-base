import 'dotenv/config';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDb } from './db/db.js';
import { startSyncScheduler, stopSyncScheduler } from './sync/scheduler.js';

/**
 * Server entry point.
 * Starts Express, then launches the sync scheduler.
 * Handles SIGTERM/SIGINT for graceful shutdown.
 */
const app = createApp();

const server = app.listen(env.PORT, () => {
  console.warn(`[Server] Knowledge Hub backend running on port ${env.PORT} (${env.NODE_ENV})`);
  startSyncScheduler();
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
