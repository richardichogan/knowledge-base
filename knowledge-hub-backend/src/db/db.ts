import { Pool } from 'pg';
import { env } from '../config/env.js';
import {
  DB_POOL_MAX,
  DB_POOL_MIN,
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
      // Keep a warm floor of long-lived connections. On this non-VNet Container
      // App every new outbound dial competes for a small shared SNAT pool, so
      // re-establishing DB connections under load fails with "Connection
      // terminated due to connection timeout". Reusing a warm pool avoids the
      // re-dial entirely.
      min: DB_POOL_MIN,
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

/**
 * Pre-warms the pool to its minimum size so the app never has to establish
 * fresh connections on the hot path (which fail under SNAT pressure). Call once
 * at startup. Best-effort — logs and continues on failure.
 */
export async function warmUpDb(): Promise<void> {
  const p = getDb();
  const clients = await Promise.allSettled(
    Array.from({ length: DB_POOL_MIN }, () => p.connect()),
  );
  let warmed = 0;
  for (const c of clients) {
    if (c.status === 'fulfilled') {
      warmed += 1;
      c.value.release();
    }
  }
  console.log(`[DB] Pool pre-warmed: ${warmed}/${DB_POOL_MIN} connections ready`);
}

/** Closes the pool — call on graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
