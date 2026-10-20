import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getDb } from '../db/db.js';
import { ValidationError } from '../types/errors.js';
import { muralStatus, saveMuralConfig, startMuralAuth, finishMuralAuth, disconnectMural, exportMuralImage } from '../services/mural.js';
import { exportMuralDiagram } from '../services/muralDiagram.js';

const router = Router();
function handler(run: (req: Request) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    void run(req).then(data => { res.json({ success: true, data }); }).catch(next);
  };
}
router.get('/', handler(() => muralStatus(getDb())));
router.put('/', handler(req => saveMuralConfig(getDb(), req.body)));
router.post('/connect', handler(async req => ({ url: await startMuralAuth(getDb(), (req as AuthenticatedRequest).userId) })));
router.post('/callback', handler(async req => {
  await finishMuralAuth(getDb(), (req as AuthenticatedRequest).userId, req.body);
  return { connected: true };
}));
router.delete('/connection', handler(async () => { await disconnectMural(getDb()); return { connected: false }; }));
router.post('/export', handler(req => {
  if (!Buffer.isBuffer(req.body)) throw new ValidationError('Send a PNG image.');
  return exportMuralImage(getDb(), req.body, req.query['boardUrl'], req.query['title']);
}));
router.post('/export-diagram', handler(req => exportMuralDiagram(getDb(), req.body)));
export { router as muralRouter };
