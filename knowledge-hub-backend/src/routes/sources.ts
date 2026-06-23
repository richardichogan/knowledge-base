import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { runTier1Sync } from '../sync/syncOrchestrator.js';
import { scoreUnscored } from '../integrations/cms/discoveredArticlesSync.js';
import { HTTP_STATUS } from '../config/constants.js';
import { SYNC_CADENCE_MINUTES } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const router = Router();

/**
 * GET /api/sources
 * Returns connection status and sync metadata for all Tier 1 sources.
 */
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const result = await db.query<{
        source: string;
        last_sync_at: Date | null;
        item_count: number | null;
        last_error: string | null;
      }>(`SELECT source, last_sync_at, item_count, last_error FROM sync_state ORDER BY source`);

      const sources = result.rows.map((row: { source: string; last_sync_at: Date | null; item_count: number | null; last_error: string | null }) => ({
        source: row.source,
        lastSyncAt: row.last_sync_at?.toISOString() ?? null,
        itemCount: row.item_count ?? 0,
        lastError: row.last_error ?? null,
        syncCadenceMinutes: SYNC_CADENCE_MINUTES[row.source] ?? null,
        status: row.last_error ? 'error' : row.last_sync_at ? 'ok' : 'never-synced',
      }));

      const body: ApiSuccess<typeof sources> = { success: true, data: sources };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * POST /api/sources/sync
 * Triggers a manual Tier 1 sync in the background. Returns immediately.
 */
router.post('/sync', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const body: ApiSuccess<{ message: string }> = { success: true, data: { message: 'Sync started' } };
    res.status(HTTP_STATUS.ACCEPTED).json(body);
    runTier1Sync(db).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Sources] Manual sync failed:', message);
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sources/score
 * Runs a scoring pass on unscored discovered articles. Returns immediately.
 */
router.post('/score', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const body: ApiSuccess<{ message: string }> = { success: true, data: { message: 'Scoring started' } };
    res.status(HTTP_STATUS.ACCEPTED).json(body);
    scoreUnscored(db).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Sources] Manual score failed:', message);
    });
  } catch (err) {
    next(err);
  }
});

export { router as sourcesRouter };
