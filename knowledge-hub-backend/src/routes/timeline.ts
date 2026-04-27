import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { queryTimeline } from '../db/queries.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess, PaginatedList } from '../types/apiResponse.js';
import type { ContentItemSummary } from '../types/contentItem.js';
import { ValidationError } from '../types/errors.js';

const router = Router();

/**
 * GET /api/timeline
 * Returns paginated timeline items ordered by published_at DESC.
 * Query params: source, projectContext, page, pageSize
 */
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const page = parseInt(String(req.query['page'] ?? '1'), 10);
      const rawPageSize = parseInt(String(req.query['pageSize'] ?? String(DEFAULT_PAGE_SIZE)), 10);
      const pageSize = Math.min(rawPageSize, MAX_PAGE_SIZE);

      if (page < 1) throw new ValidationError('page must be >= 1', { page: 'Must be >= 1' });

      const source = req.query['source'] ? String(req.query['source']) : undefined;
      const projectContext = req.query['projectContext']
        ? String(req.query['projectContext'])
        : undefined;
      const before = req.query['before'] ? String(req.query['before']) : undefined;

      const { items, total } = await queryTimeline(db, {
        page,
        pageSize,
        ...(source !== undefined && { source }),
        ...(projectContext !== undefined && { projectContext }),
        ...(before !== undefined && { before }),
      });

      const body: ApiSuccess<PaginatedList<ContentItemSummary>> = {
        success: true,
        data: {
          items,
          total,
          page,
          pageSize,
          hasMore: before ? items.length === pageSize : page * pageSize < total,
        },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as timelineRouter };
