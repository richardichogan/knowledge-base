import type { Request, Response, NextFunction } from 'express';

/**
 * Request logger middleware.
 * Logs method, path, status, and duration for every request.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.warn(
      `[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`,
    );
  });

  next();
}
