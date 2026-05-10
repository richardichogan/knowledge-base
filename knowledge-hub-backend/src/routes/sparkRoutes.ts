/**
 * routes/sparkRoutes.ts
 * REST API for sparks and spark clusters.
 *
 * POST   /api/sparks              — create a spark
 * GET    /api/sparks              — list sparks (query: source_id, source_type, cluster_id, attached, limit, offset)
 * DELETE /api/sparks/:id          — delete a spark
 * GET    /api/spark-clusters      — list clusters (query: surfaced, dismissed)
 * PATCH  /api/spark-clusters/:id  — update cluster (body: { dismissed?, surfaced? })
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import { createSpark, listSparks, deleteSpark } from '../services/sparkService.js';
import { runClusteringJob } from '../jobs/clusteringJob.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { Spark } from '../services/sparkService.js';

export const sparkRouter = Router();
export const sparkClusterRouter = Router();

// ── POST /api/sparks ──────────────────────────────────────────────────────────

sparkRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { body, tags, source_id, source_type } = req.body as {
        body?: string; tags?: string[];
        source_id?: string | null; source_type?: string | null;
      };
      if (!body || body.trim() === '') throw new ValidationError('body is required');
      if ((source_id == null) !== (source_type == null)) {
        throw new ValidationError('source_id and source_type must both be present or both absent');
      }
      const db = getDb();
      const spark = await createSpark(db, {
        body: body.trim(), tags: tags ?? [],
        sourceId: source_id ?? null, sourceType: source_type ?? null,
      });
      const out: ApiSuccess<Spark> = { success: true, data: spark };
      res.status(HTTP_STATUS.CREATED).json(out);
      // Fire clustering async — does not block the response
      void runClusteringJob(db);
    } catch (err) { next(err); }
  })();
});

// ── GET /api/sparks ───────────────────────────────────────────────────────────

sparkRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const attached = q['attached'] === 'true' ? true : q['attached'] === 'false' ? false : undefined;
      const db = getDb();
      const params: Record<string, unknown> = {};
      if (attached !== undefined) params['attached'] = attached;
      if (q['source_id'])   params['sourceId']   = q['source_id'];
      if (q['source_type']) params['sourceType'] = q['source_type'];
      if (q['cluster_id'])  params['clusterId']  = q['cluster_id'];
      if (q['limit']  !== undefined) params['limit']  = parseInt(q['limit'],  10);
      if (q['offset'] !== undefined) params['offset'] = parseInt(q['offset'], 10);
      const sparks = await listSparks(db, params as Parameters<typeof listSparks>[1]);
      const out: ApiSuccess<Spark[]> = { success: true, data: sparks };
      res.status(HTTP_STATUS.OK).json(out);
    } catch (err) { next(err); }
  })();
});

// ── DELETE /api/sparks/:id ────────────────────────────────────────────────────

sparkRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      await deleteSpark(db, req.params['id']!);
      res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (err) { next(err); }
  })();
});

// ── GET /api/spark-clusters/unsurfaced-count ─────────────────────────────────

sparkClusterRouter.get('/unsurfaced-count', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const row = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM spark_clusters
         WHERE spark_count >= 4 AND surfaced = false AND dismissed = false`,
      );
      const count = parseInt(row.rows[0]?.count ?? '0', 10);
      res.status(HTTP_STATUS.OK).json({ success: true, data: { count } });
    } catch (err) { next(err); }
  })();
});

// ── GET /api/spark-clusters ───────────────────────────────────────────────────

sparkClusterRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const conditions: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      if (q['surfaced']  !== undefined) { conditions.push(`surfaced = $${idx++}`);  values.push(q['surfaced']  === 'true'); }
      if (q['dismissed'] !== undefined) { conditions.push(`dismissed = $${idx++}`); values.push(q['dismissed'] === 'true'); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const db = getDb();
      const rows = await db.query<{
        id: string; theme: string; spark_count: number;
        surfaced: boolean; surfaced_at: string | null;
        dismissed: boolean; created_at: string; updated_at: string;
      }>(`SELECT id, theme, spark_count, surfaced, surfaced_at, dismissed, created_at, updated_at
          FROM spark_clusters ${where} ORDER BY updated_at DESC`, values);
      const data = rows.rows.map((r) => ({
        id: r.id, theme: r.theme, sparkCount: r.spark_count,
        surfaced: r.surfaced, surfacedAt: r.surfaced_at,
        dismissed: r.dismissed, createdAt: r.created_at, updatedAt: r.updated_at,
      }));
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── PATCH /api/spark-clusters/:id ────────────────────────────────────────────

sparkClusterRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { dismissed, surfaced } = req.body as { dismissed?: boolean; surfaced?: boolean };
      const sets: string[] = ['updated_at = now()'];
      const values: unknown[] = [];
      let idx = 1;
      if (dismissed !== undefined) { sets.push(`dismissed = $${idx++}`); values.push(dismissed); }
      if (surfaced  !== undefined) { sets.push(`surfaced = $${idx++}`);  values.push(surfaced); }
      if (sets.length === 1) throw new ValidationError('No fields to update');
      values.push(req.params['id']);
      const db = getDb();
      const result = await db.query(
        `UPDATE spark_clusters SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id`,
        values,
      );
      if (result.rowCount === 0) { res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: { message: 'Not found' } }); return; }
      res.status(HTTP_STATUS.OK).json({ success: true, data: { id: req.params['id'] } });
    } catch (err) { next(err); }
  })();
});
