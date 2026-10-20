import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getDb } from '../db/db.js';
import { saveShareEmailConfig, sendShareEmail, shareEmailStatus, verifyShareEmailConfig } from '../services/shareEmail.js';

export const shareEmailRouter = Router();
shareEmailRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
shareEmailRouter.get('/', (_req, res, next) => {
  void shareEmailStatus(getDb()).then(data => res.json({ success: true, data })).catch(next);
});
shareEmailRouter.put('/', (req, res, next) => {
  void saveShareEmailConfig(getDb(), req.body).then(data => res.json({ success: true, data })).catch(next);
});
const limiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: { code: 'EMAIL_RATE_LIMIT', message: 'Too many email requests. Wait a minute before trying again.' } } });
shareEmailRouter.post('/verify', limiter, (_req, res, next) => {
  void verifyShareEmailConfig(getDb()).then(data => res.json({ success: true, data })).catch(next);
});
shareEmailRouter.post('/send', limiter, (req, res, next) => {
  void sendShareEmail(getDb(), (req as AuthenticatedRequest).userId, req.body).then(data => res.json({ success: true, data })).catch(next);
});
