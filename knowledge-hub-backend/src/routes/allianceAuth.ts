/**
 * routes/allianceAuth.ts — OneDrive (IBM Alliance tenant) connection.
 *
 * Unauthenticated (browser redirects; mounted before the /api middleware):
 *   GET /auth/alliance           → Microsoft sign-in for the Alliance tenant
 *   GET /auth/alliance/callback  → stores the sign-in, back to the Library
 * Authenticated API:
 *   GET  /api/integrations/alliance/status → connection + OneDrive sync status
 *   POST /api/integrations/alliance/sync   → run the OneDrive sync now
 */

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { buildAllianceLoginUrl, completeAllianceSignIn, getAllianceStatus, isAllianceConfigured } from '../integrations/alliance/allianceGraph.js';
import type { AllianceStatus } from '../integrations/alliance/allianceGraph.js';
import { getOneDriveSyncStatus, syncOneDriveDocuments } from '../integrations/alliance/oneDriveSync.js';

// One-time sign-in state values (CSRF protection for the public callback).
const STATE_TTL_MS = 10 * 60_000;
const pendingStates = new Map<string, number>();

function backToLibrary(res: Response, query: string): void {
  res.redirect(`${env.FRONTEND_BASE_URL}/library?${query}`);
}

export const allianceAuthRouter = Router();

allianceAuthRouter.get('/', (_req: Request, res: Response): void => {
  if (!isAllianceConfigured()) {
    res.status(HTTP_STATUS.BAD_GATEWAY).send('OneDrive (Alliance) is not configured on the server.');
    return;
  }
  const now = Date.now();
  for (const [s, exp] of pendingStates) if (exp < now) pendingStates.delete(s);
  const state = randomBytes(24).toString('hex');
  pendingStates.set(state, now + STATE_TTL_MS);
  res.redirect(buildAllianceLoginUrl(state));
});

allianceAuthRouter.get('/callback', (req: Request, res: Response): void => {
  void (async () => {
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    const error = typeof req.query['error_description'] === 'string' ? req.query['error_description'] : (typeof req.query['error'] === 'string' ? req.query['error'] : '');
    const expires = pendingStates.get(state);
    pendingStates.delete(state);
    if (expires === undefined || expires < Date.now()) {
      backToLibrary(res, `onedrive=error&reason=${encodeURIComponent('Sign-in link expired — try again.')}`);
      return;
    }
    if (error !== '' || code === '') {
      backToLibrary(res, `onedrive=error&reason=${encodeURIComponent(error || 'No code returned')}`);
      return;
    }
    try {
      const db = getDb();
      const account = await completeAllianceSignIn(db, code);
      // First sync in the background so the Library fills without waiting.
      void syncOneDriveDocuments(db).catch((err: unknown) => {
        console.error('[onedrive] Initial sync failed:', err instanceof Error ? err.message : String(err));
      });
      backToLibrary(res, `onedrive=connected&account=${encodeURIComponent(account)}`);
    } catch (err) {
      backToLibrary(res, `onedrive=error&reason=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
    }
  })();
});

export const allianceApiRouter = Router();
let syncRunning = false;

allianceApiRouter.get('/status', (_req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const [connection, sync] = await Promise.all([getAllianceStatus(db), getOneDriveSyncStatus(db)]);
      const body: ApiSuccess<AllianceStatus & { sync: typeof sync; syncRunning: boolean; root: string }> = {
        success: true,
        data: { ...connection, sync, syncRunning, root: env.ALLIANCE_ONEDRIVE_ROOT },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

allianceApiRouter.post('/sync', (_req: Request, res: Response): void => {
  if (!syncRunning) {
    syncRunning = true;
    void syncOneDriveDocuments(getDb())
      .catch((err: unknown) => { console.error('[onedrive] Manual sync failed:', err instanceof Error ? err.message : String(err)); })
      .finally(() => { syncRunning = false; });
  }
  const body: ApiSuccess<{ started: boolean }> = { success: true, data: { started: true } };
  res.status(HTTP_STATUS.OK).json(body);
});
