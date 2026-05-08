/**
 * routes/tagSuggestionRoutes.ts
 * CRUD for the pending_tag_suggestions table.
 *
 * GET    /api/tag-suggestions          — list pending suggestions
 * POST   /api/tag-suggestions/:id/accept  — create tag + back-apply
 * POST   /api/tag-suggestions/:id/reject  — mark rejected
 * POST   /api/tag-suggestions/:id/merge   — map to existing tag + back-apply
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const router = Router();

export interface PendingSuggestion {
  id: string;
  suggestedName: string;
  suggestedCount: number;
  exampleContent: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'merged';
  mergedToId: string | null;
  createdAt: string;
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ── GET /api/tag-suggestions ──────────────────────────────────────────────────

router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const rows = await db.query<{
        id: string; suggested_name: string; suggested_count: number;
        example_content: string[]; status: string; merged_to_id: string | null; created_at: string;
      }>(
        `SELECT id, suggested_name, suggested_count, example_content, status, merged_to_id, created_at
         FROM pending_tag_suggestions
         WHERE status = 'pending'
         ORDER BY suggested_count DESC, created_at DESC`,
      );
      const data: PendingSuggestion[] = rows.rows.map((r) => ({
        id: r.id, suggestedName: r.suggested_name, suggestedCount: r.suggested_count,
        exampleContent: r.example_content, status: r.status as PendingSuggestion['status'],
        mergedToId: r.merged_to_id, createdAt: r.created_at,
      }));
      const body: ApiSuccess<PendingSuggestion[]> = { success: true, data };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/tag-suggestions/:id/accept ─────────────────────────────────────

router.post('/:id/accept', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const { parentId = null, colour = null } = req.body as { parentId?: string | null; colour?: string | null };

      const suggestion = await db.query<{ suggested_name: string }>(
        `SELECT suggested_name FROM pending_tag_suggestions WHERE id = $1 AND status = 'pending'`, [id],
      );
      if (suggestion.rows.length === 0) throw new NotFoundError(`Suggestion ${id} not found`);
      const name = suggestion.rows[0]!.suggested_name;
      const slug = toSlug(name);

      const tagRow = await db.query<{ id: string }>(
        `INSERT INTO tags (name, slug, role, parent_id, colour) VALUES ($1,$2,'concept',$3,$4)
         ON CONFLICT (slug) DO UPDATE SET role = 'concept', updated_at = now() RETURNING id`,
        [name, slug, parentId, colour],
      );
      const tagId = tagRow.rows[0]!.id;

      await db.query(
        `UPDATE pending_tag_suggestions SET status = 'accepted', updated_at = now() WHERE id = $1`, [id],
      );

      const body: ApiSuccess<{ tagId: string }> = { success: true, data: { tagId } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/tag-suggestions/:id/reject ─────────────────────────────────────

router.post('/:id/reject', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const result = await db.query(
        `UPDATE pending_tag_suggestions SET status = 'rejected', updated_at = now()
         WHERE id = $1 AND status = 'pending'`, [id],
      );
      if ((result.rowCount ?? 0) === 0) throw new NotFoundError(`Suggestion ${id} not found`);
      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/tag-suggestions/:id/merge ──────────────────────────────────────

router.post('/:id/merge', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const { mergeToTagId } = req.body as { mergeToTagId?: string };
      if (!mergeToTagId) throw new ValidationError('mergeToTagId is required', {});

      const existing = await db.query(`SELECT id FROM tags WHERE id = $1`, [mergeToTagId]);
      if (existing.rows.length === 0) throw new NotFoundError(`Tag ${mergeToTagId} not found`);

      await db.query(
        `UPDATE pending_tag_suggestions
         SET status = 'merged', merged_to_id = $2, updated_at = now()
         WHERE id = $1 AND status = 'pending'`, [id, mergeToTagId],
      );

      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/tag-suggestions/reject-all ─────────────────────────────────────

router.post('/reject-all', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const result = await db.query(
        `UPDATE pending_tag_suggestions SET status = 'rejected', updated_at = now() WHERE status = 'pending'`,
      );
      const body: ApiSuccess<{ rejected: number }> = { success: true, data: { rejected: result.rowCount ?? 0 } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export { router as tagSuggestionRouter };
