import { Pool } from 'pg';
import { env } from '../config/env.js';
import {
  DB_POOL_MAX,
  DB_POOL_WARN_THRESHOLD,
  DB_STATEMENT_TIMEOUT_MS,
  DB_CONNECTION_TIMEOUT_MS,
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
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      statement_timeout: DB_STATEMENT_TIMEOUT_MS,
      query_timeout: DB_STATEMENT_TIMEOUT_MS,
    });

    pool.on('error', (err: Error) => {
      console.error('[DB] Unexpected pool error:', err);
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
