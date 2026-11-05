/**
 * routes/noteTags.ts
 * Manage the many-to-many relationship between notes and taxonomy tags.
 *
 * GET  /api/notes/:id/tags   — get taxonomy tags on a note
 * PUT  /api/notes/:id/tags   — replace the full tag set on a note (array of tag IDs)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { autoTagNow } from '../services/autoTagging.js';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { TaxonomyTag } from './taxonomy.js';
import { readNoteTags, setNoteTags } from '../services/noteTagService.js';

const router = Router({ mergeParams: true });

// ── GET /api/notes/:id/tags ───────────────────────────────────────────────────

router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { noteId } = req.params as { noteId: string };
      const tags = await readNoteTags(db, noteId);
      const body: ApiSuccess<TaxonomyTag[]> = { success: true, data: tags };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/notes/:id/tags/retag — run auto-tagging on this note now ───────

router.post('/retag', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { noteId } = req.params as { noteId: string };
      const result = await autoTagNow(getDb(), 'note', noteId, true);
      const body: ApiSuccess<{ applied: number; skipped?: string }> = { success: true, data: result };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── PUT /api/notes/:id/tags ───────────────────────────────────────────────────

router.put('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { noteId } = req.params as { noteId: string };
      const input: unknown = req.body;
      if (!input || typeof input !== 'object' || !('tagIds' in input) || !('expectedTagIds' in input)) {
        throw new ValidationError('Provide tagIds and the expectedTagIds from the last read.');
      }
      const saved = await setNoteTags(db, noteId, input.tagIds, input.expectedTagIds);

      const body: ApiSuccess<{ noteId: string; tagIds: string[] }> = {
        success: true, data: saved,
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      next(err);
    }
  })();
});

export { router as noteTagsRouter };
