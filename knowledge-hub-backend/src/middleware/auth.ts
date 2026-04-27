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
  // In development, skip token verification so the UI works without a login flow
  if (env.NODE_ENV === 'development') {
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
