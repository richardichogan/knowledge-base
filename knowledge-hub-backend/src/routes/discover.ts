import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';

export const discoverRouter = Router();

export type WorkflowState = 'to-review' | 'saved' | 'blog' | 'archived' | 'published';

export interface DiscoverItem {
  id: string;
  sourceId: string;
  title: string;
  url: string | null;
  description: string | null;
  publishedAt: string;
  indexedAt: string;
  sourceTitle: string;
  workflowState: WorkflowState;
  relevanceScore: number | null;
  relevanceExplanation: string | null;
  /** URL of the user's own blog post written about this article */
  publishedUrl: string | null;
}

const VALID_STATES: WorkflowState[] = ['to-review', 'saved', 'blog', 'archived', 'published'];
const DISCOVER_PAGE_SIZE_DEFAULT = 50;
const DISCOVER_PAGE_SIZE_MAX = 100;

// ── GET /api/discover ─────────────────────────────────────────────────────────
discoverRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const state = (req.query['state'] as string) || 'to-review';
      const sourceFilter = req.query['source'] as string | undefined;
      const page = Math.max(1, parseInt((req.query['page'] as string) || '1', 10));
      const pageSize = Math.min(
        DISCOVER_PAGE_SIZE_MAX,
        Math.max(1, parseInt((req.query['pageSize'] as string) || String(DISCOVER_PAGE_SIZE_DEFAULT), 10)),
      );
      const offset = (page - 1) * pageSize;

      const conditions: string[] = [`source = 'discovered-article'`];
      const params: unknown[] = [];
      let p = 1;

      if (VALID_STATES.includes(state as WorkflowState)) {
        conditions.push(`workflow_state = $${p++}`);
        params.push(state);
      }
      if (sourceFilter) {
        conditions.push(`metadata->>'sourceTitle' = $${p++}`);
        params.push(sourceFilter);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;

      const [countResult, dataResult] = await Promise.all([
        db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM content_items ${where}`, params),
        db.query<{
          id: string;
          source_id: string;
          title: string;
          url: string | null;
          body: string;
          published_at: Date;
          indexed_at: Date;
          metadata: Record<string, unknown>;
          workflow_state: string;
          relevance_score: number | null;
          relevance_explanation: string | null;
        }>(
          `SELECT id, source_id, title, url, body, published_at, indexed_at,
                  metadata, workflow_state, relevance_score, relevance_explanation
           FROM content_items ${where}
           ORDER BY published_at DESC
           LIMIT $${p++} OFFSET $${p}`,
          [...params, pageSize, offset],
        ),
      ]);

      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);
      const items: DiscoverItem[] = dataResult.rows.map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        title: row.title,
        url: row.url,
        description: row.body || null,
        publishedAt: row.published_at.toISOString(),
        indexedAt: row.indexed_at.toISOString(),
        sourceTitle: (row.metadata['sourceTitle'] as string) || '',
        workflowState: row.workflow_state as WorkflowState,
        relevanceScore: row.relevance_score,
        relevanceExplanation: row.relevance_explanation,
        publishedUrl: typeof row.metadata['publishedUrl'] === 'string' ? row.metadata['publishedUrl'] : null,
      }));

      const response: ApiSuccess<{ items: DiscoverItem[]; total: number; page: number; pageSize: number }> = {
        success: true,
        data: { items, total, page, pageSize },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  })();
});

// ── GET /api/discover/sources ─────────────────────────────────────────────────
discoverRouter.get('/sources', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const result = await db.query<{ source_title: string; count: string }>(
        `SELECT metadata->>'sourceTitle' AS source_title, COUNT(*) AS count
         FROM content_items
         WHERE source = 'discovered-article'
         GROUP BY metadata->>'sourceTitle'
         ORDER BY count DESC`,
      );
      const sources = result.rows.map((r) => ({ title: r.source_title, count: parseInt(r.count, 10) }));
      const response: ApiSuccess<typeof sources> = { success: true, data: sources };
      res.json(response);
    } catch (err) {
      next(err);
    }
  })();
});

// ── PATCH /api/discover/:id/workflow ─────────────────────────────────────────
discoverRouter.patch('/:id/workflow', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { id } = req.params;
      const { state } = req.body as { state: WorkflowState };

      if (!VALID_STATES.includes(state)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: `Invalid state: ${state}` },
        });
        return;
      }

      const db = getDb();
      const result = await db.query(
        `UPDATE content_items SET workflow_state = $1 WHERE id = $2 AND source = 'discovered-article' RETURNING id`,
        [state, id],
      );

      if (result.rowCount === 0) {
        res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Item not found' },
        });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  })();
});

// ── PATCH /api/discover/:id/published-url ─────────────────────────────────────
discoverRouter.patch('/:id/published-url', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { id } = req.params;
      const { publishedUrl } = req.body as { publishedUrl: string | null };

      const db = getDb();
      const result = await db.query(
        `UPDATE content_items
         SET metadata = metadata || jsonb_build_object('publishedUrl', $1::text)
         WHERE id = $2 AND source = 'discovered-article'
         RETURNING id`,
        [publishedUrl ?? null, id],
      );

      if (result.rowCount === 0) {
        res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Item not found' },
        });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  })();
});
