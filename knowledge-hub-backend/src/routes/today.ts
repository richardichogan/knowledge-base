/**
 * routes/today.ts
 * Routes for the Today dashboard page.
 *
 * GET /api/today/github-activity?tagIds[]=<uuid>&tagIds[]=<uuid>
 *   Returns GitHub content_items tagged with any of the given taxonomy tag UUIDs.
 *   Returns an empty array (not an error) if no tagIds are provided.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import type { ApiSuccess } from '../types/apiResponse.js';

export const todayRouter = Router();

export interface GitHubActivityRow {
  id: string;
  source: string;
  title: string;
  summary: string | null;
  published_at: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

// ── GET /api/today/github-activity ────────────────────────────────────────────

todayRouter.get('/github-activity', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const raw = req.query['tagIds[]'];
      const tagIds: string[] = Array.isArray(raw)
        ? (raw as string[])
        : raw != null
          ? [raw as string]
          : [];

      if (tagIds.length === 0) {
        const out: ApiSuccess<GitHubActivityRow[]> = { success: true, data: [] };
        res.json(out);
        return;
      }

      const db = getDb();
      const result = await db.query<GitHubActivityRow>(
        `SELECT ci.id, ci.source, ci.title, ci.summary, ci.published_at, ci.url, ci.metadata
         FROM content_items ci
         JOIN discover_item_tags dit ON dit.discover_item_id = ci.id
         WHERE ci.source IN ('github-commit', 'github-pr', 'github-issue')
           AND dit.tag_id = ANY($1::uuid[])
         ORDER BY ci.published_at DESC
         LIMIT 50`,
        [tagIds],
      );

      const out: ApiSuccess<GitHubActivityRow[]> = { success: true, data: result.rows };
      res.json(out);
    } catch (err) {
      next(err);
    }
  })();
});
