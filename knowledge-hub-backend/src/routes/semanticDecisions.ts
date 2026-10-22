import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { confirmAcceptance, readDecisionSemantics, recordDecisionLink, updateReviewDate, type ActionResult, type DecisionSemantics } from '../services/semantic/decisionActions.js';
import type { ApiError, ApiSuccess } from '../types/apiResponse.js';

type Action = (db: Pool, id: string, body: unknown, ctx: { now: Date }) => Promise<ActionResult<DecisionSemantics>>;

/** Explicit user actions on a decision: confirm acceptance, set the review date, record implements/supersedes links. */
export function createSemanticDecisionsRouter(pool: () => Pool = getDb): Router {
  const router = Router();
  const handle = (action: Action, success: number = HTTP_STATUS.OK) => (req: Request, res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      try {
        const result = await action(pool(), String(req.params['id'] ?? ''), req.body, { now: new Date() });
        if (result.ok) {
          const body: ApiSuccess<DecisionSemantics> = { success: true, data: result.data };
          res.status(success).json(body);
          return;
        }
        const { status, code, message, fields } = result.error;
        const body: ApiError = { success: false, error: { code, message, ...(fields === undefined ? {} : { fields }) } };
        res.status(status).json(body);
      } catch (err) { next(err); }
    })();
  };
  router.get('/:id/semantics', handle((db, id, _body, ctx) => readDecisionSemantics(db, id, ctx)));
  router.post('/:id/accept', handle(confirmAcceptance));
  router.put('/:id/review-date', handle(updateReviewDate));
  router.post('/:id/links', handle(recordDecisionLink, HTTP_STATUS.CREATED));
  return router;
}

export const semanticDecisionsRouter = createSemanticDecisionsRouter();
