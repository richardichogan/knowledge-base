/**
 * services/sparkService.ts
 * Core CRUD for sparks. Triggers clustering after creation.
 *
 * Exported functions:
 *   createSpark()  — insert a spark, enqueue clustering
 *   listSparks()   — paginated query with optional filters
 *   deleteSpark()  — delete by id, returns 404 if not found
 *   updateSpark()  — edit text, move between themes, mark used
 *   listThemes() / updateTheme() / mergeThemes() / createTheme() — spark themes (spark_clusters)
 *   relatedSparks() — sparks captured from, or connected to, a note / article
 */
import type { Pool } from 'pg';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { runClusteringJob, recountThemes, createThemeForSparks } from '../jobs/clusteringJob.js';
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
  /** Title of the source note / article, when known to the graph. */
  sourceTitle: string | null;
  usedAt: string | null;
  usedType: string | null;
  usedRef: string | null;
  usedTitle: string | null;
}

/** What a theme or spark became. */
export interface SparkOutput {
  type: 'note' | 'blog' | 'canvas' | 'project' | 'tasks';
  ref: string;
  title: string;
  url?: string | null;
}

export type ThemeStatus = 'active' | 'developed' | 'dismissed';

/** A spark theme (spark_clusters row) with its sparks. */
export interface SparkTheme {
  id: string;
  theme: string;
  status: ThemeStatus;
  sparkCount: number;
  surfaced: boolean;
  dismissed: boolean;
  outputType: string | null;
  outputRef: string | null;
  outputTitle: string | null;
  outputUrl: string | null;
  developedAt: string | null;
  lastGrownAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Sparks added since the theme was developed. */
  newSinceDeveloped: number;
  sparks: Spark[];
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
  /** true = only in a theme, false = only loose */
  clustered?: boolean;
  /** Case-insensitive text match on body, tags and source title. */
  search?: string;
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
    spark = mapRow({ ...row.rows[0]!, source_title: null, used_at: null, used_type: null, used_ref: null, used_title: null });
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

const SPARK_SELECT = `
  SELECT s.id, s.source_id, s.source_type, s.body, s.tags, s.cluster_id, s.created_at,
         n.title AS source_title, s.used_at, s.used_type, s.used_ref, s.used_title
  FROM sparks s
  LEFT JOIN nodes n ON n.ref_id = s.source_id AND n.ref_type = s.source_type`;

/** Returns a paginated list of sparks matching the given filters. */
export async function listSparks(db: Pool, params: ListSparksParams): Promise<Spark[]> {
  const { sourceId, sourceType, clusterId, attached, clustered, search, limit = DEFAULT_LIMIT, offset = 0 } = params;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (sourceId !== undefined)  { conditions.push(`s.source_id = $${idx++}`);   values.push(sourceId); }
  if (sourceType !== undefined){ conditions.push(`s.source_type = $${idx++}`); values.push(sourceType); }
  if (clusterId !== undefined) { conditions.push(`s.cluster_id = $${idx++}`);  values.push(clusterId); }
  if (attached === true)       { conditions.push('s.source_id IS NOT NULL'); }
  if (attached === false)      { conditions.push('s.source_id IS NULL'); }
  if (clustered === true)      { conditions.push('s.cluster_id IS NOT NULL'); }
  if (clustered === false)     { conditions.push('s.cluster_id IS NULL'); }
  if (search !== undefined && search.trim() !== '') {
    conditions.push(`(s.body ILIKE $${idx} OR array_to_string(s.tags, ' ') ILIKE $${idx} OR n.title ILIKE $${idx})`);
    values.push(`%${search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);

  const rows = await db.query<SparkRow>(
    `${SPARK_SELECT} ${where}
     ORDER BY s.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  );
  return rows.rows.map(mapRow);
}

/** Input for updateSpark. `clusterId: null` makes the spark loose; `used: null` clears the used mark. */
export interface UpdateSparkInput {
  body?: string;
  clusterId?: string | null;
  used?: SparkOutput | null;
}

/** Edits a spark, moves it between themes, or marks it used. */
export async function updateSpark(db: Pool, id: string, input: UpdateSparkInput): Promise<Spark> {
  const before = await db.query<{ cluster_id: string | null }>(`SELECT cluster_id FROM sparks WHERE id = $1`, [id]);
  if (before.rows.length === 0) throw new NotFoundError(`Spark ${id} not found`);
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (input.body !== undefined) {
    if (input.body.trim() === '') throw new ValidationError('body cannot be empty');
    sets.push(`body = $${idx++}`); values.push(input.body.trim());
  }
  if (input.clusterId !== undefined) {
    if (input.clusterId !== null) {
      const t = await db.query(`SELECT 1 FROM spark_clusters WHERE id = $1`, [input.clusterId]);
      if (t.rows.length === 0) throw new NotFoundError(`Theme ${input.clusterId} not found`);
    }
    sets.push(`cluster_id = $${idx++}`); values.push(input.clusterId);
  }
  if (input.used !== undefined) {
    if (input.used === null) {
      sets.push('used_at = NULL', 'used_type = NULL', 'used_ref = NULL', 'used_title = NULL');
    } else {
      sets.push('used_at = now()', `used_type = $${idx++}`, `used_ref = $${idx++}`, `used_title = $${idx++}`);
      values.push(input.used.type, input.used.ref, input.used.title);
    }
  }
  if (sets.length === 0) throw new ValidationError('No fields to update');
  values.push(id);
  await db.query(`UPDATE sparks SET ${sets.join(', ')} WHERE id = $${idx}`, values);

  if (input.body !== undefined) {
    const body = input.body.trim();
    const title = body.length > TITLE_MAX_LENGTH ? body.slice(0, TITLE_TRUNCATE_AT) + '…' : body;
    await db.query(`UPDATE nodes SET title = $1, updated_at = now() WHERE ref_id = $2 AND ref_type = 'spark'`, [title, id]);
  }
  if (input.clusterId !== undefined) {
    const touched = [before.rows[0]!.cluster_id, input.clusterId].filter((v): v is string => v !== null);
    await recountThemes(db, touched);
    if (input.clusterId !== null) {
      await db.query(`UPDATE spark_clusters SET last_grown_at = now() WHERE id = $1`, [input.clusterId]);
    }
  }
  const out = await db.query<SparkRow>(`${SPARK_SELECT} WHERE s.id = $1`, [id]);
  return mapRow(out.rows[0]!);
}

/** Sparks captured from the given item, or connected to it in the graph. */
export async function relatedSparks(db: Pool, refId: string, refType: string, limit = 10): Promise<Array<Spark & { relation: 'captured' | 'connected' }>> {
  const { rows } = await db.query<SparkRow & { relation: 'captured' | 'connected' }>(
    `WITH item AS (SELECT id FROM nodes WHERE ref_id = $1 AND ref_type = $2),
     connected AS (
       SELECT sn.ref_id AS spark_id
       FROM edges e
       JOIN item i ON i.id IN (e.source_node_id, e.target_node_id)
       JOIN nodes sn ON sn.id = CASE WHEN e.source_node_id = i.id THEN e.target_node_id ELSE e.source_node_id END
       WHERE sn.ref_type = 'spark'
     )
     SELECT x.*, CASE WHEN x.source_id = $1 AND x.source_type = $2 THEN 'captured' ELSE 'connected' END AS relation
     FROM (${SPARK_SELECT}) x
     WHERE (x.source_id = $1 AND x.source_type = $2) OR x.id::text IN (SELECT spark_id FROM connected)
     ORDER BY (x.source_id = $1 AND x.source_type = $2) DESC NULLS LAST, x.created_at DESC
     LIMIT $3`,
    [refId, refType, limit],
  );
  return rows.map((r) => ({ ...mapRow(r), relation: r.relation }));
}

// ── Themes ────────────────────────────────────────────────────────────────────

interface ThemeRow {
  id: string; theme: string; status: ThemeStatus; spark_count: number;
  surfaced: boolean; dismissed: boolean;
  output_type: string | null; output_ref: string | null; output_title: string | null; output_url: string | null;
  developed_at: string | null; last_grown_at: string | null; created_at: string; updated_at: string;
}

const THEME_COLUMNS = `id, theme, status, spark_count, surfaced, dismissed, output_type, output_ref, output_title,
  output_url, developed_at, last_grown_at, created_at, updated_at`;

/** Lists themes (optionally by status) with all their sparks, most recently grown first. */
export async function listThemes(db: Pool, statuses?: ThemeStatus[]): Promise<SparkTheme[]> {
  const where = statuses !== undefined && statuses.length > 0 ? 'WHERE status = ANY($1)' : '';
  const { rows } = await db.query<ThemeRow>(
    `SELECT ${THEME_COLUMNS} FROM spark_clusters ${where}
     ORDER BY (status = 'active') DESC, COALESCE(last_grown_at, updated_at) DESC`,
    where !== '' ? [statuses] : [],
  );
  if (rows.length === 0) return [];
  const sparkRows = await db.query<SparkRow>(
    `${SPARK_SELECT} WHERE s.cluster_id = ANY($1::uuid[]) ORDER BY s.created_at DESC`,
    [rows.map((r) => r.id)],
  );
  const byTheme = new Map<string, Spark[]>();
  for (const r of sparkRows.rows) {
    const sp = mapRow(r);
    byTheme.set(sp.clusterId!, [...(byTheme.get(sp.clusterId!) ?? []), sp]);
  }
  return rows.map((r) => mapTheme(r, byTheme.get(r.id) ?? []));
}

/** Input for updateTheme. */
export interface UpdateThemeInput {
  theme?: string;
  status?: ThemeStatus;
  surfaced?: boolean;
  /** Records what the theme became; implies status 'developed'. `null` clears it. */
  output?: SparkOutput | null;
  /** Also mark the theme's sparks used with the same output. */
  markSparksUsed?: boolean;
}

export async function updateTheme(db: Pool, id: string, input: UpdateThemeInput): Promise<SparkTheme> {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let idx = 1;
  if (input.theme !== undefined) {
    if (input.theme.trim() === '') throw new ValidationError('theme cannot be empty');
    sets.push(`theme = $${idx++}`); values.push(input.theme.trim());
  }
  let status = input.status;
  if (input.output !== undefined) {
    if (input.output === null) {
      sets.push('output_type = NULL', 'output_ref = NULL', 'output_title = NULL', 'output_url = NULL', 'developed_at = NULL');
      status ??= 'active';
    } else {
      sets.push(`output_type = $${idx++}`, `output_ref = $${idx++}`, `output_title = $${idx++}`, `output_url = $${idx++}`, 'developed_at = now()');
      values.push(input.output.type, input.output.ref, input.output.title, input.output.url ?? null);
      status ??= 'developed';
    }
  }
  if (status !== undefined) {
    if (!['active', 'developed', 'dismissed'].includes(status)) throw new ValidationError('Invalid status');
    sets.push(`status = $${idx++}`, `dismissed = $${idx++}`); values.push(status, status === 'dismissed');
  }
  if (input.surfaced !== undefined) { sets.push(`surfaced = $${idx++}`); values.push(input.surfaced); }
  if (sets.length === 1) throw new ValidationError('No fields to update');
  values.push(id);
  const res = await db.query(`UPDATE spark_clusters SET ${sets.join(', ')} WHERE id = $${idx}`, values);
  if (res.rowCount === 0) throw new NotFoundError(`Theme ${id} not found`);

  if (input.markSparksUsed === true && input.output !== undefined && input.output !== null) {
    await db.query(
      `UPDATE sparks SET used_at = now(), used_type = $2, used_ref = $3, used_title = $4 WHERE cluster_id = $1 AND used_at IS NULL`,
      [id, input.output.type, input.output.ref, input.output.title],
    );
  }
  const themes = await getThemes(db, [id]);
  return themes[0]!;
}

/** Moves all sparks of `fromId` into `intoId` and deletes `fromId`. */
export async function mergeThemes(db: Pool, fromId: string, intoId: string): Promise<SparkTheme> {
  if (fromId === intoId) throw new ValidationError('Cannot merge a theme into itself');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT id FROM spark_clusters WHERE id = ANY($1::uuid[])`, [[fromId, intoId]]);
    if (found.rows.length !== 2) throw new NotFoundError('Theme not found');
    await client.query(`UPDATE sparks SET cluster_id = $1 WHERE cluster_id = $2`, [intoId, fromId]);
    await client.query(`DELETE FROM spark_clusters WHERE id = $1`, [fromId]);
    await client.query(`UPDATE spark_clusters SET last_grown_at = now() WHERE id = $1`, [intoId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await recountThemes(db, [intoId]);
  return (await getThemes(db, [intoId]))[0]!;
}

/** Creates a theme by hand from the given sparks (moving them out of any previous theme). */
export async function createTheme(db: Pool, theme: string, sparkIds: string[]): Promise<SparkTheme> {
  if (theme.trim() === '') throw new ValidationError('theme is required');
  if (sparkIds.length === 0) throw new ValidationError('At least one spark is required');
  const prev = await db.query<{ cluster_id: string }>(
    `SELECT DISTINCT cluster_id FROM sparks WHERE id = ANY($1::uuid[]) AND cluster_id IS NOT NULL`, [sparkIds],
  );
  const id = await createThemeForSparks(db, theme.trim(), sparkIds);
  await recountThemes(db, [id, ...prev.rows.map((r) => r.cluster_id)]);
  return (await getThemes(db, [id]))[0]!;
}

async function getThemes(db: Pool, ids: string[]): Promise<SparkTheme[]> {
  const { rows } = await db.query<ThemeRow>(`SELECT ${THEME_COLUMNS} FROM spark_clusters WHERE id = ANY($1::uuid[])`, [ids]);
  const sparkRows = await db.query<SparkRow>(`${SPARK_SELECT} WHERE s.cluster_id = ANY($1::uuid[]) ORDER BY s.created_at DESC`, [ids]);
  return rows.map((r) => mapTheme(r, sparkRows.rows.filter((s) => s.cluster_id === r.id).map(mapRow)));
}

function mapTheme(r: ThemeRow, sparks: Spark[]): SparkTheme {
  const developedAt = r.developed_at !== null ? new Date(r.developed_at).getTime() : null;
  return {
    id: r.id, theme: r.theme, status: r.status, sparkCount: sparks.length,
    surfaced: r.surfaced, dismissed: r.dismissed,
    outputType: r.output_type, outputRef: r.output_ref, outputTitle: r.output_title, outputUrl: r.output_url,
    developedAt: r.developed_at, lastGrownAt: r.last_grown_at, createdAt: r.created_at, updatedAt: r.updated_at,
    newSinceDeveloped: developedAt === null ? 0 : sparks.filter((s) => new Date(s.createdAt).getTime() > developedAt).length,
    sparks,
  };
}

/**
 * Deletes a spark by ID.
 * @throws NotFoundError if spark does not exist.
 */
export async function deleteSpark(db: Pool, id: string): Promise<void> {
  const client = await db.connect();
  let clusterId: string | null = null;
  try {
    await client.query('BEGIN');
    const result = await client.query<{ cluster_id: string | null }>('DELETE FROM sparks WHERE id = $1 RETURNING cluster_id', [id]);
    if (result.rowCount === 0) throw new NotFoundError(`Spark ${id} not found`);
    clusterId = result.rows[0]?.cluster_id ?? null;
    await client.query(`DELETE FROM nodes WHERE ref_id = $1 AND ref_type = 'spark'`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (clusterId !== null) await recountThemes(db, [clusterId]);
}

interface SparkRow {
  id: string; source_id: string | null; source_type: string | null;
  body: string; tags: string[]; cluster_id: string | null; created_at: string;
  source_title: string | null; used_at: string | null; used_type: string | null;
  used_ref: string | null; used_title: string | null;
}

function mapRow(r: SparkRow): Spark {
  return {
    id: r.id, sourceId: r.source_id, sourceType: r.source_type,
    body: r.body, tags: r.tags, clusterId: r.cluster_id, createdAt: r.created_at,
    sourceTitle: r.source_title, usedAt: r.used_at, usedType: r.used_type,
    usedRef: r.used_ref, usedTitle: r.used_title,
  };
}
