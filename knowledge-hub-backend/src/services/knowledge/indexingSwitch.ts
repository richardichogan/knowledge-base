/**
 * Persisted admin switch for bulk/backfill indexing (spec 6.3). Default OFF.
 * It gates only bulk paths (the scheduled sweep, bulk reconcile, the backfill
 * script). Incremental per-write indexing and dry-run estimates are never
 * gated. Reads fail closed: an unreadable switch is treated as OFF.
 */
import { KnowledgeHubError } from '../../types/errors.js';
import type { QueryRows } from './admission.js';

const SWITCH_KEY = 'bulk_indexing';
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

export interface SwitchQueryable { query<R = unknown>(sql: string, params?: unknown[]): Promise<QueryRows<R>> }

export interface BulkIndexingSwitch { enabled: boolean; updatedAt: string | null; updatedBy: string | null }

/** Bulk indexing was requested while the admin switch is OFF. */
export class BulkIndexingDisabledError extends KnowledgeHubError {
  public constructor() {
    super('Bulk indexing is switched off. An administrator must enable it; dry-run estimates and per-write indexing are unaffected.', HTTP_CONFLICT, 'BULK_INDEXING_DISABLED');
    this.name = 'BulkIndexingDisabledError';
  }
}

/** The switch state could not be read or written. */
export class IndexingSwitchUnavailableError extends KnowledgeHubError {
  public constructor() {
    super('The bulk indexing switch could not be read or updated.', HTTP_UNAVAILABLE, 'INDEXING_SWITCH_UNAVAILABLE');
    this.name = 'IndexingSwitchUnavailableError';
  }
}

interface SwitchRow { enabled: boolean; updated_at: Date | string; updated_by: string }

function toSwitch(row: SwitchRow | undefined): BulkIndexingSwitch {
  if (row === undefined) return { enabled: false, updatedAt: null, updatedBy: null };
  return { enabled: row.enabled, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by };
}

export async function getBulkIndexingSwitch(q: SwitchQueryable): Promise<BulkIndexingSwitch> {
  try {
    const { rows } = await q.query<SwitchRow>(
      `SELECT enabled, updated_at, updated_by FROM knowledge_indexing_settings WHERE key = $1`, [SWITCH_KEY]);
    return toSwitch(rows[0]);
  } catch {
    throw new IndexingSwitchUnavailableError();
  }
}

/** Fail-closed read: any error means OFF. */
export async function isBulkIndexingEnabled(q: SwitchQueryable): Promise<boolean> {
  try {
    return (await getBulkIndexingSwitch(q)).enabled;
  } catch {
    return false;
  }
}

export async function assertBulkIndexingEnabled(q: SwitchQueryable): Promise<void> {
  if (!(await isBulkIndexingEnabled(q))) throw new BulkIndexingDisabledError();
}

export async function setBulkIndexingEnabled(q: SwitchQueryable, enabled: boolean, actor: string, now = new Date()): Promise<BulkIndexingSwitch> {
  try {
    const { rows } = await q.query<SwitchRow>(
      `INSERT INTO knowledge_indexing_settings (key, enabled, updated_at, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
       RETURNING enabled, updated_at, updated_by`,
      [SWITCH_KEY, enabled, now, actor]);
    return toSwitch(rows[0]);
  } catch {
    throw new IndexingSwitchUnavailableError();
  }
}
