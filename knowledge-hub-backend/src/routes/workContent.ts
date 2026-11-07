import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { ValidationError } from '../types/errors.js';
import { confirmEmailWaiting, getWorkContent, listDrafts, markEmailSent, noteId, saveWorkContent, workText } from '../work/workContent.js';
import { exportDelivery } from '../work/officeExport.js';

export const workContentRouter = Router();
const wrap = (run: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction): void => {
  void run(req).then(data => { res.json({ success: true, data }); }).catch(next);
};
const body = (req: Request): Record<string, unknown> => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ValidationError('Expected a request object.');
  return req.body as Record<string, unknown>;
};
workContentRouter.get('/drafts', wrap(() => listDrafts(getDb())));
workContentRouter.get('/:id', wrap(req => getWorkContent(getDb(), noteId(req.params.id))));
workContentRouter.put('/:id', wrap(req => saveWorkContent(getDb(), noteId(req.params.id), body(req))));
workContentRouter.post('/:id/download', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    const input = body(req);
    const file = await exportDelivery(getDb(), noteId(req.params.id), input.format, input.revision, input.noteRevision);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.buffer);
  })().catch(next);
});
workContentRouter.get('/:id/email-copy', wrap(async req => {
  const id = noteId(req.params.id);
  const email = await getWorkContent(getDb(), id);
  if (email.type !== 'email-draft') throw new ValidationError('Open an Email draft to copy it.');
  if (email.channel !== 'email') return { text: await workText(getDb(), id) };
  return { text: `To: ${email.to}\n${email.cc ? `Cc: ${email.cc}\n` : ''}Subject: ${email.subject}\n\n${await workText(getDb(), id)}` };
}));
workContentRouter.post('/:id/sent', wrap(req => markEmailSent(getDb(), noteId(req.params.id), body(req))));
workContentRouter.post('/:id/waiting', wrap(req => confirmEmailWaiting(getDb(), noteId(req.params.id), body(req))));
