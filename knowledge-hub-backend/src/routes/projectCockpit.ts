import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import {
  getProjectCockpit, listRegister, createRegisterItem, updateRegisterItem, deleteRegisterItem, promoteDecision,
  type RegisterInput,
} from '../projects/cockpit.js';
import { getProjectChanges } from '../projects/workContext.js';

export const projectCockpitRouter = Router();

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req: Request, res: Response, next: NextFunction): void => {
  fn(req, res).catch(next);
};
const param = (req: Request, name: string): string => String(req.params[name] ?? '');
const body = (req: Request): Record<string, unknown> => (typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {});
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const send = <T>(res: Response, data: T, status: number = HTTP_STATUS.OK): void => {
  const payload: ApiSuccess<T> = { success: true, data };
  res.status(status).json(payload);
};

/** Read-only aggregate of a project's work, decisions, notes and outputs, with per-section failures. */
projectCockpitRouter.get('/:id/cockpit', wrap(async (req, res) => {
  send(res, await getProjectCockpit(getDb(), param(req, 'id')));
}));
projectCockpitRouter.get('/:id/changes', wrap(async (req, res) => {
  send(res, await getProjectChanges(getDb(), param(req, 'id'), req.query['since']));
}));

projectCockpitRouter.get('/:id/register', wrap(async (req, res) => {
  const limit = Number(text(req.query['limit']));
  const offset = Number(text(req.query['offset']));
  send(res, await listRegister(getDb(), param(req, 'id'), {
    status: text(req.query['status']), kind: text(req.query['kind']),
    limit: Number.isFinite(limit) ? limit : undefined, offset: Number.isFinite(offset) ? offset : undefined,
  }));
}));

projectCockpitRouter.post('/:id/register', wrap(async (req, res) => {
  send(res, await createRegisterItem(getDb(), param(req, 'id'), body(req) as RegisterInput), HTTP_STATUS.CREATED);
}));

projectCockpitRouter.post('/:id/register/promote', wrap(async (req, res) => {
  const b = body(req);
  const result = await promoteDecision(getDb(), param(req, 'id'), b['decisionId'], b['kind']);
  send(res, result, result.created ? HTTP_STATUS.CREATED : HTTP_STATUS.OK);
}));

projectCockpitRouter.patch('/:id/register/:itemId', wrap(async (req, res) => {
  send(res, await updateRegisterItem(getDb(), param(req, 'id'), param(req, 'itemId'), body(req) as RegisterInput));
}));

projectCockpitRouter.delete('/:id/register/:itemId', wrap(async (req, res) => {
  await deleteRegisterItem(getDb(), param(req, 'id'), param(req, 'itemId'));
  res.status(HTTP_STATUS.NO_CONTENT).end();
}));
