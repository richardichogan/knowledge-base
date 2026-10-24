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
import { getAllianceStatus } from '../integrations/alliance/allianceGraph.js';
import { listConnectionCredentials, updateConnectionCredential } from '../services/connectionCredentials.js';
import { audit } from '../jobs/store.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.get('/credentials', (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Cache-Control', 'no-store');
  void listConnectionCredentials(getDb()).then((data) => {
    res.json({ success: true, data });
  }).catch(next);
});

router.put('/credentials/:id', (req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Cache-Control', 'no-store');
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || !('token' in body) || Object.keys(body).some((key) => key !== 'token')) {
    next(new ValidationError('Only the token field is accepted.'));
    return;
  }
  void updateConnectionCredential(getDb(), req.params['id'] ?? '', body.token).then((data) => {
    res.json({ success: true, data });
  }).catch(next);
});

router.get('/email-accounts', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const alliance = await getAllianceStatus(getDb());
      const allianceMail = { enabled: env.ALLIANCE_MAIL_ENABLED, mailAccess: alliance.connected && alliance.mailAccess };
      res.json({ success: true, data: emailAccountConnections(env.ALLIANCE_ALLOWED_UPN, env.EMAIL_ACCOUNTS, allianceMail) });
    } catch (error) { next(error); }
  })();
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
      }>(`SELECT source, last_sync_at, item_count, last_error FROM sync_state WHERE source NOT LIKE 'connection-credential:%' AND source NOT LIKE 'integration:mural:%' ORDER BY source`);

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
router.post('/sync', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { run, completion } = await startTier1Sync(getDb());
      const actor = (req as AuthenticatedRequest).userId;
      void completion.then(result => audit(getDb(), 'a7000000-0000-4000-8000-000000000001', null, actor,
        result.totalErrors ? 'manual-sync-partial' : 'manual-sync-succeeded', { syncRunId: run.id, result }))
        .catch(async (error: unknown) => {
          console.error('[Sources] Manual sync failed:', error);
          await audit(getDb(), 'a7000000-0000-4000-8000-000000000001', null, actor, 'manual-sync-failed', { syncRunId: run.id, message: error instanceof Error ? error.message : 'Failed' });
        }).catch((error: unknown) => console.error('[Sources] Could not record manual sync failure:', error));
      await audit(getDb(), 'a7000000-0000-4000-8000-000000000001', null, actor, 'manual-sync-started', { syncRunId: run.id });
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
