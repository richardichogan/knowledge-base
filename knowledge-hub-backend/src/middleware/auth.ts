import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { UnauthorisedError } from '../types/errors.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
}

/**
 * JWT authentication middleware.
 * Verifies the Bearer token in the Authorization header.
 * Attaches userId to the request for downstream handlers.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  // Admin cron routes authenticate via x-cron-secret — skip JWT for these
  if (req.path.includes('/admin/')) {
    return next();
  }

  // In development or when SKIP_AUTH is set, bypass JWT so the UI works without login
  if (env.NODE_ENV === 'development' || process.env.SKIP_AUTH === 'true') {
    (req as AuthenticatedRequest).userId = 'dev-user';
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorisedError('Missing or malformed Authorization header'));
  }

  const token = authHeader.substring('Bearer '.length);

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    (req as AuthenticatedRequest).userId = payload.sub;
    next();
  } catch {
    next(new UnauthorisedError('Invalid or expired token'));
  }
}
