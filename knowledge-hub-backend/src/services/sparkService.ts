/**
 * services/sparkService.ts
 * Core CRUD for sparks. Triggers clustering after creation.
 *
 * Exported functions:
 *   createSpark()  — insert a spark, enqueue clustering
 *   listSparks()   — paginated query with optional filters
 *   deleteSpark()  — delete by id, returns 404 if not found
 */
import type { Pool } from 'pg';
import { NotFoundError } from '../types/errors.js';
import { runClusteringJob } from '../jobs/clusteringJob.js';

/** Public shape of a spark returned to API callers. */
export interface Spark {
  id: string;
  sourceId: string | null;
  sourceType: string | null;
  body: string;
  tags: string[];
  clusterId: string | null;
  createdAt: string;
}

/** Input for spark creation. */
export interface CreateSparkInput {
  sourceId?: string | null;
  sourceType?: string | null;
  body: string;
  tags?: string[];
}

/** Query params for listing sparks. */
export interface ListSparksParams {
  sourceId?: string;
  sourceType?: string;
  clusterId?: string;
  /** true = only attached, false = only standalone, omit = all */
  attached?: boolean;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 20;

/**
 * Creates a spark and asynchronously triggers the clustering job.
 * The clustering job does not block the HTTP response.
 */
export async function createSpark(db: Pool, input: CreateSparkInput): Promise<Spark> {
  const { sourceId = null, sourceType = null, body, tags = [] } = input;

  const row = await db.query<{
    id: string; source_id: string | null; source_type: string | null;
    body: string; tags: string[]; cluster_id: string | null; created_at: string;
  }>(
    `INSERT INTO sparks (source_id, source_type, body, tags)
     VALUES ($1, $2, $3, $4)
     RETURNING id, source_id, source_type, body, tags, cluster_id, created_at`,
    [sourceId, sourceType, body, tags],
  );
  const spark = mapRow(row.rows[0]!);

  // Fire-and-forget clustering — do not await
  runClusteringJob(db).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[SparkService] Clustering job error:', msg);
  });

  return spark;
}

/** Returns a paginated list of sparks matching the given filters. */
export async function listSparks(db: Pool, params: ListSparksParams): Promise<Spark[]> {
  const { sourceId, sourceType, clusterId, attached, limit = DEFAULT_LIMIT, offset = 0 } = params;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (sourceId !== undefined)  { conditions.push(`source_id = $${idx++}`);   values.push(sourceId); }
  if (sourceType !== undefined){ conditions.push(`source_type = $${idx++}`); values.push(sourceType); }
  if (clusterId !== undefined) { conditions.push(`cluster_id = $${idx++}`);  values.push(clusterId); }
  if (attached === true)       { conditions.push('source_id IS NOT NULL'); }
  if (attached === false)      { conditions.push('source_id IS NULL'); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);

  const rows = await db.query<{
    id: string; source_id: string | null; source_type: string | null;
    body: string; tags: string[]; cluster_id: string | null; created_at: string;
  }>(
    `SELECT id, source_id, source_type, body, tags, cluster_id, created_at
     FROM sparks ${where}
     ORDER BY created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  );
  return rows.rows.map(mapRow);
}

/**
 * Deletes a spark by ID.
 * @throws NotFoundError if spark does not exist.
 */
export async function deleteSpark(db: Pool, id: string): Promise<void> {
  const result = await db.query('DELETE FROM sparks WHERE id = $1', [id]);
  if (result.rowCount === 0) throw new NotFoundError(`Spark ${id} not found`);
}

function mapRow(r: {
  id: string; source_id: string | null; source_type: string | null;
  body: string; tags: string[]; cluster_id: string | null; created_at: string;
}): Spark {
  return {
    id: r.id, sourceId: r.source_id, sourceType: r.source_type,
    body: r.body, tags: r.tags, clusterId: r.cluster_id, createdAt: r.created_at,
  };
}
