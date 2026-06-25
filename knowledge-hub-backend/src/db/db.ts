import { Pool } from 'pg';
import { env } from '../config/env.js';
import {
  DB_POOL_MAX,
  DB_POOL_WARN_THRESHOLD,
  DB_STATEMENT_TIMEOUT_MS,
  DB_CONNECTION_TIMEOUT_MS,
  DB_IDLE_TIMEOUT_MS,
  DB_KEEPALIVE_INITIAL_DELAY_MS,
} from '../config/constants.js';

let pool: Pool | undefined;

/**
 * Returns the singleton PostgreSQL connection pool.
 * Initialised lazily on first call.
 */
export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: DB_POOL_MAX,
      // Reap idle connections before Azure's networking silently kills them,
      // otherwise the pool hands out dead sockets → "Connection terminated
      // unexpectedly" → API 500s until the container is restarted.
      idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      statement_timeout: DB_STATEMENT_TIMEOUT_MS,
      query_timeout: DB_STATEMENT_TIMEOUT_MS,
      // Keep long-lived TCP sockets warm so idle middleboxes don't drop them.
      keepAlive: true,
      keepAliveInitialDelayMillis: DB_KEEPALIVE_INITIAL_DELAY_MS,
    });

    pool.on('error', (err: Error) => {
      // A backend connection died while idle in the pool. pg removes it
      // automatically; we just log so it doesn't crash the process.
      console.error('[DB] Unexpected pool error (idle client removed):', err.message);
    });

    // Log pool exhaustion — helps diagnose hangs
    pool.on('connect', () => {
      const p = pool;
      if (p && p.totalCount >= DB_POOL_WARN_THRESHOLD) {
        console.warn(`[DB] Pool near capacity: total=${p.totalCount} idle=${p.idleCount} waiting=${p.waitingCount}`);
      }
    });
  }
  return pool;
}

/** Closes the pool — call on graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
