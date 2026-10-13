import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { ValidationError } from '../types/errors.js';
import {
  listCandidates, createPacket, listPackets, getPacket, setItemChecked, approvePacket, deletePacket, renderPacketMarkdown,
} from '../projects/reviewPackets.js';

export const reviewPacketsRouter = Router();

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

reviewPacketsRouter.get('/:id/packet-candidates', wrap(async (req, res) => {
  send(res, await listCandidates(getDb(), param(req, 'id')));
}));

reviewPacketsRouter.get('/:id/packets', wrap(async (req, res) => {
  send(res, await listPackets(getDb(), param(req, 'id')));
}));

reviewPacketsRouter.post('/:id/packets', wrap(async (req, res) => {
  send(res, await createPacket(getDb(), param(req, 'id'), body(req)), HTTP_STATUS.CREATED);
}));

reviewPacketsRouter.get('/:id/packets/:packetId', wrap(async (req, res) => {
  send(res, await getPacket(getDb(), param(req, 'id'), param(req, 'packetId')));
}));

reviewPacketsRouter.get('/:id/packets/:packetId/export', wrap(async (req, res) => {
  send(res, renderPacketMarkdown(await getPacket(getDb(), param(req, 'id'), param(req, 'packetId'))));
}));

reviewPacketsRouter.patch('/:id/packets/:packetId/items/:position', wrap(async (req, res) => {
  const position = Number(param(req, 'position'));
  if (!Number.isInteger(position) || position < 0) throw new ValidationError('position must be a non-negative integer', { position: 'invalid' });
  send(res, await setItemChecked(getDb(), param(req, 'id'), param(req, 'packetId'), position, body(req)['checked']));
}));

reviewPacketsRouter.post('/:id/packets/:packetId/approve', wrap(async (req, res) => {
  send(res, await approvePacket(getDb(), param(req, 'id'), param(req, 'packetId'), body(req)['acknowledgeStale']));
}));

reviewPacketsRouter.delete('/:id/packets/:packetId', wrap(async (req, res) => {
  await deletePacket(getDb(), param(req, 'id'), param(req, 'packetId'));
  res.status(HTTP_STATUS.NO_CONTENT).end();
}));
