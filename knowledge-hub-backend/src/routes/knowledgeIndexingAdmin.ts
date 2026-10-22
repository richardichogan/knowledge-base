import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { UnauthorisedError, ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import {
  getBulkIndexingSwitch, setBulkIndexingEnabled, type BulkIndexingSwitch, type SwitchQueryable,
} from '../services/knowledge/indexingSwitch.js';
import { estimateIndexingBackfill, summariseIndexingWork, type BackfillEstimate, type WorkQueryable, type WorkSummary } from '../services/knowledge/indexingWork.js';

export const knowledgeIndexingAdminRouter = Router();

/**
 * Admin-only (x-cron-secret header; the /admin/ path skips JWT auth like the other admin routes).
 * Fails closed when no secret is configured. The secret is never accepted from the query string.
 */
export function isIndexingAdmin(req: Request, secret: string | undefined = env.CRON_SECRET): boolean {
  if (secret === undefined || secret === '') return false;
  const header = req.headers['x-cron-secret'];
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(req: Request): void {
  if (!isIndexingAdmin(req)) throw new UnauthorisedError('Admin secret required');
}

/** GET /api/knowledge/admin/indexing - switch state, queue summary and a dry-run estimate (always allowed). */
knowledgeIndexingAdminRouter.get('/admin/indexing', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      requireAdmin(req);
      const db = getDb();
      const [bulk, queue, estimate] = await Promise.all([
        getBulkIndexingSwitch(db as unknown as SwitchQueryable),
        summariseIndexingWork(db as unknown as WorkQueryable),
        estimateIndexingBackfill(db as unknown as WorkQueryable),
      ]);
      const body: ApiSuccess<{ bulkIndexing: BulkIndexingSwitch; queue: WorkSummary; estimate: BackfillEstimate }> = {
        success: true, data: { bulkIndexing: bulk, queue, estimate },
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/** PUT /api/knowledge/admin/indexing { enabled: boolean } - persists the bulk indexing switch. */
knowledgeIndexingAdminRouter.put('/admin/indexing', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      requireAdmin(req);
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') throw new ValidationError('enabled must be a boolean', { enabled: 'Expected true or false' });
      const body: ApiSuccess<BulkIndexingSwitch> = {
        success: true, data: await setBulkIndexingEnabled(getDb() as unknown as SwitchQueryable, enabled, 'admin'),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  })();
});
