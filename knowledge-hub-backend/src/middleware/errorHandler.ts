import type { Request, Response, NextFunction } from 'express';
import { KnowledgeHubError } from '../types/errors.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiError } from '../types/apiResponse.js';

/**
 * Global error handler middleware.
 * Maps typed errors to appropriate HTTP responses.
 * Swallows stack traces in production.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof KnowledgeHubError) {
    const body: ApiError = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.name === 'ValidationError' && 'fields' in err
          ? { fields: err.fields as Record<string, string> }
          : {}),
      },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Unexpected errors — log and return 500
  console.error('[Unhandled error]', err);
  const body: ApiError = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  };
  res.status(HTTP_STATUS.INTERNAL_ERROR).json(body);
}
