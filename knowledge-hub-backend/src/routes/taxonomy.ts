/**
 * routes/taxonomy.ts
 * CRUD for the hierarchical tag taxonomy.
 *
 * GET    /api/taxonomy          — full tree (parents + children)
 * POST   /api/taxonomy          — create a tag (parent or child)
 * PATCH  /api/taxonomy/:id      — update name / colour
 * DELETE /api/taxonomy/:id      — delete a tag (enforces no-children constraint for parents)
 * GET    /api/taxonomy/pending  — suggested tags not yet in taxonomy (review queue)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError, NotFoundError } from '../types/errors.js';
import type { ApiSuccess } from '../types/apiResponse.js';

const router = Router();

export interface TaxonomyTag {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  colour: string | null;
  usageCount: number;
  children?: TaxonomyTag[];
}

// ── Validation ────────────────────────────────────────────────────────────────

const PODCAST_RE   = /^EP\d{3}$/;
const NEWSLETTER_RE = /^Edition \d{3}$/;
const NAME_RE       = /^[a-zA-Z0-9][a-zA-Z0-9 -]{0,48}[a-zA-Z0-9]$|^[a-zA-Z0-9]{1,2}$/;

const TAG_NAME_MAX = 50;

function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function validateName(db: ReturnType<typeof getDb>, name: string, parentId: string | null): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > TAG_NAME_MAX) {
    throw new ValidationError('Tag name must be 1–50 characters', {});
  }
  if (parentId !== null) {
    const parent = await db.query<{ name: string }>('SELECT name FROM tags WHERE id = $1', [parentId]);
    const parentName = parent.rows[0]?.name ?? '';
    if (parentName === 'Podcast' && !PODCAST_RE.test(trimmed)) {
      throw new ValidationError('Podcast episode tags must follow the format EP001, EP002 etc.', {});
    }
    if (parentName === 'Newsletter' && !NEWSLETTER_RE.test(trimmed)) {
      throw new ValidationError('Newsletter edition tags must follow the format Edition 001, Edition 002 etc.', {});
    }
  }
  if (!NAME_RE.test(trimmed)) {
    throw new ValidationError('Tag name may only contain letters, numbers, spaces and hyphens', {});
  }
}

// ── GET /api/taxonomy — full tree ─────────────────────────────────────────────

router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const rows = await db.query<{
        id: string; name: string; slug: string; parent_id: string | null;
        colour: string | null; usage_count: number;
      }>(
        `SELECT t.id, t.name, t.slug, t.parent_id, t.colour,
                (SELECT COUNT(*)::int FROM note_tags nt WHERE nt.tag_id = t.id) +
                (SELECT COUNT(*)::int FROM discover_item_tags dt WHERE dt.tag_id = t.id) AS usage_count
         FROM tags t ORDER BY t.name ASC`,
      );

      const allTags: TaxonomyTag[] = rows.rows.map((r) => ({
        id: r.id, name: r.name, slug: r.slug, parentId: r.parent_id,
        colour: r.colour, usageCount: r.usage_count, children: [],
      }));

      const byId = new Map(allTags.map((t) => [t.id, t]));
      const parents: TaxonomyTag[] = [];

      for (const tag of allTags) {
        if (tag.parentId === null) { parents.push(tag); }
        else { byId.get(tag.parentId)?.children?.push(tag); }
      }

      const body: ApiSuccess<TaxonomyTag[]> = { success: true, data: parents };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── GET /api/taxonomy/pending — review queue ──────────────────────────────────

router.get('/pending', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const rows = await db.query<{ suggestion: string; item_id: string; item_title: string }>(
        `SELECT DISTINCT ON (t.suggestion) t.suggestion, ci.id AS item_id, ci.title AS item_title
         FROM content_items ci
         CROSS JOIN LATERAL unnest(ci.tags) AS t(suggestion)
         WHERE ci.source = 'discovered-article'
           AND array_length(ci.tags, 1) > 0
           AND NOT EXISTS (
             SELECT 1 FROM tags
             WHERE slug = lower(regexp_replace(t.suggestion, '\\s+', '-', 'g'))
           )
           AND NOT EXISTS (
             SELECT 1 FROM tag_suggestion_dismissals
             WHERE suggestion = t.suggestion
           )
         ORDER BY t.suggestion
         LIMIT 50`,
      );
      const body: ApiSuccess<typeof rows.rows> = { success: true, data: rows.rows };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/taxonomy/pending/dismiss — permanently dismiss a suggestion ─────

router.post('/pending/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { suggestion } = req.body as { suggestion?: string };
      if (!suggestion || typeof suggestion !== 'string' || !suggestion.trim()) {
        throw new ValidationError('suggestion is required', {});
      }
      await db.query(
        `INSERT INTO tag_suggestion_dismissals (suggestion) VALUES ($1) ON CONFLICT DO NOTHING`,
        [suggestion.trim()],
      );
      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── POST /api/taxonomy ────────────────────────────────────────────────────────

router.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { name, parentId = null, colour = null } = req.body as {
        name: string; parentId?: string | null; colour?: string | null;
      };
      await validateName(db, name, parentId);
      const slug = toSlug(name.trim());
      const row = await db.query<{ id: string }>(
        `INSERT INTO tags (name, slug, parent_id, colour) VALUES ($1,$2,$3,$4) RETURNING id`,
        [name.trim(), slug, parentId, colour],
      );
      const tagId = row.rows[0]?.id;
      if (tagId === undefined) throw new Error('Insert failed');
      const tag: TaxonomyTag = { id: tagId, name: name.trim(), slug, parentId, colour, usageCount: 0 };
      const body: ApiSuccess<TaxonomyTag> = { success: true, data: tag };
      res.status(HTTP_STATUS.CREATED).json(body);
    } catch (err) { next(err); }
  })();
});

// ── PATCH /api/taxonomy/:id ───────────────────────────────────────────────────

router.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const { name, colour } = req.body as { name?: string; colour?: string | null };
      const existing = await db.query<{ parent_id: string | null }>(
        'SELECT parent_id FROM tags WHERE id = $1', [id],
      );
      if (existing.rows.length === 0) throw new NotFoundError(`Tag ${id} not found`);
      if (name !== undefined) await validateName(db, name, existing.rows[0]!.parent_id);

      const fields: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [id];
      if (name !== undefined) { params.push(name.trim()); fields.push(`name = $${params.length}, slug = $${params.length + 1}`); params.push(toSlug(name.trim())); }
      if (colour !== undefined) { params.push(colour); fields.push(`colour = $${params.length}`); }

      await db.query(`UPDATE tags SET ${fields.join(', ')} WHERE id = $1`, params);
      const resolvedId: string = id ?? '';
      const body: ApiSuccess<{ id: string }> = { success: true, data: { id: resolvedId } };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

// ── DELETE /api/taxonomy/:id ──────────────────────────────────────────────────

router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const { id } = req.params;
      const existing = await db.query<{ parent_id: string | null }>(
        'SELECT parent_id FROM tags WHERE id = $1', [id],
      );
      if (existing.rows.length === 0) throw new NotFoundError(`Tag ${id} not found`);
      if (existing.rows[0]!.parent_id === null) {
        const children = await db.query('SELECT 1 FROM tags WHERE parent_id = $1 LIMIT 1', [id]);
        if (children.rows.length > 0) {
          throw new ValidationError('Cannot delete a parent tag that has children — delete children first', {});
        }
      }
      await db.query('DELETE FROM tags WHERE id = $1', [id]);
      const body: ApiSuccess<void> = { success: true, data: undefined };
      res.status(HTTP_STATUS.OK).json(body);
    } catch (err) { next(err); }
  })();
});

export { router as taxonomyRouter };
