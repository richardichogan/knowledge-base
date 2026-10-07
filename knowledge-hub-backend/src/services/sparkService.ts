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
import { upsertNode } from './nodeService.js';
import { upsertEdge } from './edgeService.js';

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
const TITLE_MAX_LENGTH = 80;
const TITLE_TRUNCATE_AT = 77;

/**
 * Creates a spark and asynchronously triggers the clustering job.
 * The clustering job does not block the HTTP response.
 */
export async function createSpark(db: Pool, input: CreateSparkInput): Promise<Spark> {
  const { sourceId = null, sourceType = null, body, tags = [] } = input;

  const client = await db.connect();
  let spark: Spark;
  try {
    await client.query('BEGIN');
    const row = await client.query<{
      id: string; source_id: string | null; source_type: string | null;
      body: string; tags: string[]; cluster_id: string | null; created_at: string;
    }>(
      `INSERT INTO sparks (source_id, source_type, body, tags)
       VALUES ($1, $2, $3, $4)
       RETURNING id, source_id, source_type, body, tags, cluster_id, created_at`,
      [sourceId, sourceType, body, tags],
    );
    spark = mapRow(row.rows[0]!);
    const title = body.length > TITLE_MAX_LENGTH ? body.slice(0, TITLE_TRUNCATE_AT) + '…' : body;
    const nodeId = await upsertNode(client, spark.id, 'spark', title, tags);
    if (sourceId !== null && sourceType !== null) {
      const source = await client.query<{ id: string }>(
        `SELECT id FROM nodes WHERE ref_id = $1 AND ref_type = $2`, [sourceId, sourceType],
      );
      const sourceNodeId = source.rows[0]?.id;
      if (sourceNodeId !== undefined) {
        await upsertEdge(client, nodeId, sourceNodeId, 'has_spark', 1, { reason: 'This Spark was captured from this item.' });
      } else {
        console.warn(`[SparkService] Source ${sourceType} ${sourceId} is not yet in the graph; the next sync will resolve its Spark connection.`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

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
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM sparks WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new NotFoundError(`Spark ${id} not found`);
    await client.query(`DELETE FROM nodes WHERE ref_id = $1 AND ref_type = 'spark'`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
