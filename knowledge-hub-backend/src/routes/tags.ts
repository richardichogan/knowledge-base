/**
 * routes/tags.ts — Change 007
 *
 * GET /api/tags           — returns all global tags, ordered by usage_count DESC
 * GET /api/tags?q=foo     — filtered substring match
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/index.js';

const router = Router();

router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';

      const result = await db.query<{ tag: string; usage_count: number }>(
        q.length > 0
          ? `SELECT tag, usage_count FROM global_tags
             WHERE tag ILIKE $1
             ORDER BY usage_count DESC, tag ASC
             LIMIT 50`
          : `SELECT tag, usage_count FROM global_tags
             ORDER BY usage_count DESC, tag ASC
             LIMIT 200`,
        q.length > 0 ? [`%${q}%`] : [],
      );

      const tags = result.rows.map((r) => r.tag);
      const body: ApiSuccess<string[]> = { success: true, data: tags };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as tagsRouter };
