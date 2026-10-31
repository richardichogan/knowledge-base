import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { ValidationError } from '../types/errors.js';
import { confirmEmailWaiting, getWorkContent, markEmailSent, noteId, saveWorkContent, workText } from '../work/workContent.js';

export const workContentRouter = Router();
const wrap = (run: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction): void => {
  void run(req).then(data => { res.json({ success: true, data }); }).catch(next);
};
const body = (req: Request): Record<string, unknown> => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ValidationError('Expected a request object.');
  return req.body as Record<string, unknown>;
};
workContentRouter.get('/:id', wrap(req => getWorkContent(getDb(), noteId(req.params.id))));
workContentRouter.put('/:id', wrap(req => saveWorkContent(getDb(), noteId(req.params.id), body(req))));
workContentRouter.get('/:id/email-copy', wrap(async req => {
  const id = noteId(req.params.id);
  const email = await getWorkContent(getDb(), id);
  if (email.type !== 'email-draft') throw new ValidationError('Open an Email draft to copy it.');
  return { text: `To: ${email.to}\n${email.cc ? `Cc: ${email.cc}\n` : ''}Subject: ${email.subject}\n\n${await workText(getDb(), id)}` };
}));
workContentRouter.post('/:id/sent', wrap(req => markEmailSent(getDb(), noteId(req.params.id), body(req))));
workContentRouter.post('/:id/waiting', wrap(req => confirmEmailWaiting(getDb(), noteId(req.params.id), body(req))));
