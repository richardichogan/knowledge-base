import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { startTier1Sync } from '../sync/syncOrchestrator.js';
import { getSyncRun, latestSyncRun } from '../sync/runStore.js';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { scoreUnscored } from '../integrations/cms/discoveredArticlesSync.js';
import { HTTP_STATUS } from '../config/constants.js';
import { SYNC_CADENCE_MINUTES } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { env } from '../config/env.js';
import { emailAccountConnections } from '../integrations/email/accountConnections.js';

const router = Router();

router.get('/email-accounts', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ success: true, data: emailAccountConnections(env.ALLIANCE_ALLOWED_UPN, env.EMAIL_ACCOUNTS) });
  } catch (error) { next(error); }
});

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
  void (async (): Promise<void> => {
    try {
      const { run, completion } = await startTier1Sync(getDb());
      void completion.catch((error: unknown) => { console.error('[Sources] Manual sync failed:', error); });
      res.status(HTTP_STATUS.ACCEPTED).json({ success: true, data: run });
    } catch (error) { next(error); }
  })();
});

router.get('/runs/latest', (_req: Request, res: Response, next: NextFunction): void => {
  void latestSyncRun(getDb()).then(data => { res.json({ success: true, data }); }).catch(next);
});
router.get('/runs/:runId', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const id = req.params['runId'] ?? '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Invalid sync run ID');
      const data = await getSyncRun(getDb(), id);
      if (data === null) throw new NotFoundError('Sync run');
      res.json({ success: true, data });
    } catch (error) { next(error); }
  })();
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
