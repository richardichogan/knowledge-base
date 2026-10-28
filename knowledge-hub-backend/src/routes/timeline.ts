import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { queryTimeline } from '../db/queries.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess, PaginatedList } from '../types/apiResponse.js';
import type { ContentItemSummary } from '../types/contentItem.js';
import { ValidationError } from '../types/errors.js';
import { positiveInteger, queryDate } from '../utils/queryValidation.js';
import { prepareMeeting } from '../projects/workContext.js';

const router = Router();
router.get('/:id/preparation', (req, res, next) => {
  const maxProjectChars = 200;
  const projectId = req.query['projectId'];
  if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim() || projectId.length > maxProjectChars)) {
    next(new ValidationError('Choose a valid project.')); return;
  }
  void prepareMeeting(getDb(), String(req.params['id']), projectId).then(data => { res.json({ success: true, data }); }).catch(next);
});

/**
 * GET /api/timeline
 * Returns paginated timeline items ordered by published_at DESC.
 * Query params: source, projectContext, page, pageSize, before, since
 * since selects recent activity by source update time and excludes future events.
 */
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const db = getDb();
      const page = positiveInteger(req.query['page'], 'page', 1);
      const pageSize = positiveInteger(req.query['pageSize'], 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

      const source = req.query['source'] ? String(req.query['source']) : undefined;
      const projectContext = req.query['projectContext']
        ? String(req.query['projectContext'])
        : undefined;
      const before = queryDate(req.query['before'], 'before');
      const since = queryDate(req.query['since'], 'since');
      const rangeStart = queryDate(req.query['rangeStart'], 'rangeStart');
      const rangeEnd = queryDate(req.query['rangeEnd'], 'rangeEnd');
      const order = req.query['order'];
      if (order !== undefined && order !== 'asc' && order !== 'desc') throw new ValidationError('order must be asc or desc.');
      if ((rangeStart === undefined) !== (rangeEnd === undefined)) throw new ValidationError('rangeStart and rangeEnd must be supplied together');
      if (rangeStart !== undefined && rangeEnd !== undefined &&
        (rangeStart >= rangeEnd || since !== undefined || before !== undefined)) {
        throw new ValidationError('Range must be increasing and cannot be combined with since or before');
      }
      if (since !== undefined && before !== undefined) {
        throw new ValidationError('since and before cannot be combined');
      }

      const { items, total } = await queryTimeline(db, {
        page,
        pageSize,
        ...(source !== undefined && { source }),
        ...(projectContext !== undefined && { projectContext }),
        ...(before !== undefined && { before }),
        ...(since !== undefined && { since }),
        ...(rangeStart !== undefined && { rangeStart }),
        ...(rangeEnd !== undefined && { rangeEnd }),
        ...(order === 'asc' && { ascending: true }),
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
