import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { UnauthorisedError, ValidationError } from '../types/errors.js';
import { assistanceId, approveTaskAssistance, assessTaskAssistance, copyAssistanceEmail, taskAssistanceDetail } from '../work/taskAssistance.js';
import { record } from '../agents/workforce/contracts.js';

export const taskAssistanceRouter = Router();
const wrap = (run: (req: Request, taskId: string, owner: string) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      if (!('userId' in req) || typeof req.userId !== 'string' || !req.userId.trim()) throw new UnauthorisedError();
      const id = req.params['id'];
      if (typeof id !== 'string' || !id.trim()) throw new ValidationError('Task ID is required.');
      res.json({ success: true, data: await run(req, id, req.userId) });
    })().catch(next);
  };
taskAssistanceRouter.get('/:id', wrap((_req, id, owner) => taskAssistanceDetail(getDb(), id, owner)));
taskAssistanceRouter.get('/:id/email/:proposalId', wrap((req, id, owner) => copyAssistanceEmail(getDb(), id, owner, String(req.params['proposalId']))));
taskAssistanceRouter.post('/:id/assess', wrap((req, id, owner) => assessTaskAssistance(getDb(), id, owner, record(req.body as unknown, 'Assistance request')['direction'])));
taskAssistanceRouter.post('/:id/approve', wrap((req, id, owner) => approveTaskAssistance(getDb(), id, owner, assistanceId(record(req.body as unknown, 'Assistance request')['proposalId']))));
