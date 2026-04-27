import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { searchContentItems } from '../db/queries.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess, PaginatedList } from '../types/apiResponse.js';
import type { ContentItemSummary } from '../types/contentItem.js';

const router = Router();

/**
 * GET /api/search?q=...&source=...&page=1&pageSize=20
 * Full-text search across all indexed content using PostgreSQL FTS.
 */
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const q = req.query['q'] ? String(req.query['q']).trim() : '';
      if (!q) throw new ValidationError('q is required', { q: 'Query string required' });

      const db = getDb();
      const page = parseInt(String(req.query['page'] ?? '1'), 10);
      const rawPageSize = parseInt(String(req.query['pageSize'] ?? String(DEFAULT_PAGE_SIZE)), 10);
      const pageSize = Math.min(rawPageSize, MAX_PAGE_SIZE);
      const source = req.query['source'] ? String(req.query['source']) : undefined;

      const { items, total } = await searchContentItems(db, q, {
        page,
        pageSize,
        ...(source !== undefined && { source }),
      });

      const body: ApiSuccess<PaginatedList<ContentItemSummary>> = {
        success: true,
        data: { items, total, page, pageSize, hasMore: page * pageSize < total },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as searchRouter };
