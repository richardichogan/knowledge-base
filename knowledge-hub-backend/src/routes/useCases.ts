/**
 * routes/useCases.ts — Use cases (see useCases/useCaseStore.ts).
 *
 * GET    /api/use-cases?productKind=&stage=          list
 * POST   /api/use-cases                              { title, summary?, productKind, projectId?, repo?, sources? }
 * GET    /api/use-cases/:id                          detail with sources and links
 * PATCH  /api/use-cases/:id                          { title?, summary?, productKind?, projectId?, repo?, stage? }
 * DELETE /api/use-cases/:id
 * POST   /api/use-cases/:id/sources                  { sources: [{ sourceType, sourceId }] }
 * DELETE /api/use-cases/:id/sources/:type/:sourceId
 * POST   /api/use-cases/:id/links                    { url, title? }
 * DELETE /api/use-cases/:id/links/:linkId
 */
import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { ValidationError } from '../types/errors.js';
import {
  listUseCases, getUseCase, createUseCase, updateUseCase, deleteUseCase, addSources, removeSource, addLink, removeLink,
  parseCreate, parsePatch, parseSourceRef, parseProductKind, parseStage,
} from '../useCases/useCaseStore.js';

export const useCasesRouter = Router();

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req: Request, res: Response, next: NextFunction): void => {
  fn(req, res).catch(next);
};
const param = (req: Request, name: string): string => String(req.params[name] ?? '');
const body = (req: Request): Record<string, unknown> => (typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {});
const send = <T>(res: Response, data: T, status: number = HTTP_STATUS.OK): void => {
  const payload: ApiSuccess<T> = { success: true, data };
  res.status(status).json(payload);
};
const query = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

useCasesRouter.get('/', wrap(async (req, res) => {
  const kind = query(req, 'productKind');
  const stage = query(req, 'stage');
  send(res, await listUseCases(getDb(), {
    ...(kind !== undefined ? { productKind: parseProductKind(kind) } : {}),
    ...(stage !== undefined ? { stage: parseStage(stage) } : {}),
  }));
}));

useCasesRouter.post('/', wrap(async (req, res) => {
  send(res, await createUseCase(getDb(), parseCreate(body(req))), HTTP_STATUS.CREATED);
}));

useCasesRouter.get('/:id', wrap(async (req, res) => {
  send(res, await getUseCase(getDb(), param(req, 'id')));
}));

useCasesRouter.patch('/:id', wrap(async (req, res) => {
  send(res, await updateUseCase(getDb(), param(req, 'id'), parsePatch(body(req))));
}));

useCasesRouter.delete('/:id', wrap(async (req, res) => {
  await deleteUseCase(getDb(), param(req, 'id'));
  res.status(HTTP_STATUS.NO_CONTENT).end();
}));

useCasesRouter.post('/:id/sources', wrap(async (req, res) => {
  const raw = body(req)['sources'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw new ValidationError('sources must be a list of 1 to 20 items', { sources: '1 to 20 items' });
  }
  send(res, await addSources(getDb(), param(req, 'id'), raw.map(parseSourceRef)));
}));

useCasesRouter.delete('/:id/sources/:type/:sourceId', wrap(async (req, res) => {
  const ref = parseSourceRef({ sourceType: param(req, 'type'), sourceId: param(req, 'sourceId') });
  send(res, await removeSource(getDb(), param(req, 'id'), ref));
}));

useCasesRouter.post('/:id/links', wrap(async (req, res) => {
  send(res, await addLink(getDb(), param(req, 'id'), body(req)));
}));

useCasesRouter.delete('/:id/links/:linkId', wrap(async (req, res) => {
  send(res, await removeLink(getDb(), param(req, 'id'), param(req, 'linkId')));
}));
