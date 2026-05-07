/**
 * routes/noteTags.ts
 * Manage the many-to-many relationship between notes and taxonomy tags.
 *
 * GET  /api/notes/:id/tags   — get taxonomy tags on a note
 * PUT  /api/notes/:id/tags   — replace the full tag set on a note (array of tag IDs)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { NotFoundError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { TaxonomyTag } from './taxonomy.js';

const router = Router({ mergeParams: true });

// ── GET /api/notes/:id/tags ───────────────────────────────────────────────────

router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { noteId } = req.params as { noteId: string };
      const rows = await db.query<{
        id: string; name: string; slug: string; parent_id: string | null; colour: string | null;
      }>(
        `SELECT t.id, t.name, t.slug, t.parent_id, t.colour
         FROM tags t
         INNER JOIN note_tags nt ON nt.tag_id = t.id
         WHERE nt.note_id = $1
         ORDER BY t.name ASC`,
        [noteId],
      );
      const tags: TaxonomyTag[] = rows.rows.map((r) => ({
        id: r.id, name: r.name, slug: r.slug, parentId: r.parent_id, colour: r.colour, usageCount: 0,
      }));
      const body: ApiSuccess<TaxonomyTag[]> = { success: true, data: tags };
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
      const { tagIds } = req.body as { tagIds: string[] };

      // Verify note exists
      const noteCheck = await db.query('SELECT id FROM notes WHERE id = $1 AND status = $2', [noteId, 'active']);
      if (noteCheck.rows.length === 0) throw new NotFoundError(`Note ${noteId} not found`);

      // Replace tag set in a transaction
      await db.query('BEGIN');
      await db.query('DELETE FROM note_tags WHERE note_id = $1', [noteId]);
      if (tagIds.length > 0) {
        const placeholders = tagIds.map((_, i) => `($1, $${i + 2})`).join(', '); // $1 = noteId, $2+ = tagIds  // eslint-disable-line @typescript-eslint/no-magic-numbers
        await db.query(
          `INSERT INTO note_tags (note_id, tag_id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
          [noteId, ...tagIds],
        );
      }
      await db.query('COMMIT');

      const body: ApiSuccess<{ noteId: string; tagIds: string[] }> = {
        success: true, data: { noteId: noteId, tagIds },
      };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) {
      const db = getDb();
      await db.query('ROLLBACK').catch(() => undefined);
      next(err);
    }
  })();
});

export { router as noteTagsRouter };
