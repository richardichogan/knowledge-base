/**
 * routes/cfp.ts
 *
 * Express router for CFP (Call for Papers) endpoints.
 *
 * GET  /api/cfps              — list CFP items, filterable by workflow_state
 * PUT  /api/cfps/:id/state    — update workflow state for one item
 * POST /api/cfps/sync         — trigger a manual sync (admin/testing)
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import {
  getCfpItems,
  syncCfps,
  updateCfpWorkflowState,
  type CfpItem,
  type CfpWorkflowState,
} from '../services/cfpSyncService.js';

export const cfpRouter = Router();

const VALID_CFP_STATES: CfpWorkflowState[] = ['to_review', 'saved', 'submitted', 'archived'];
const DEFAULT_LIMIT = 50;

// ── GET /api/cfps ─────────────────────────────────────────────────────────

cfpRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const state = (req.query['workflow_state'] as string | undefined) ?? 'to_review';
      const limit = Math.min(100, parseInt((req.query['limit'] as string) || String(DEFAULT_LIMIT), 10));
      const offset = Math.max(0, parseInt((req.query['offset'] as string) || '0', 10));

      const workflowState = VALID_CFP_STATES.includes(state as CfpWorkflowState)
        ? (state as CfpWorkflowState)
        : 'to_review';

      const items = await getCfpItems(db, { workflowState, limit, offset });

      const response: ApiSuccess<CfpItem[]> = { success: true, data: items };
      res.json(response);
    } catch (err) {
      next(err);
    }
  })();
});

// ── PUT /api/cfps/:id/state ───────────────────────────────────────────────

cfpRouter.put('/:id/state', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params as { id: string };
      const { state } = req.body as { state?: string };

      if (!state || !VALID_CFP_STATES.includes(state as CfpWorkflowState)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: { code: 'INVALID_STATE', message: `state must be one of: ${VALID_CFP_STATES.join(', ')}` },
        });
        return;
      }

      const updated = await updateCfpWorkflowState(db, id, state as CfpWorkflowState);
      if (!updated) {
        res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'CFP item not found' },
        });
        return;
      }

      const response: ApiSuccess<{ id: string; state: string }> = {
        success: true,
        data: { id, state },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  })();
});

// ── POST /api/cfps/sync ───────────────────────────────────────────────────

cfpRouter.post('/sync', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const result = await syncCfps(db);
      const response: ApiSuccess<{ indexed: number; errors: number }> = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  })();
});
