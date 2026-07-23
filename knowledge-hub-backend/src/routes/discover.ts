import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { scoreUnscored } from '../integrations/cms/discoveredArticlesSync.js';

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
  taxonomyTagIds: string[];
  /** AI-classified article type */
  articleType: string | null;
  /** Treatment plan: Full Blog Post, LinkedIn Standalone, Newsletter Candidate, Archive, Podcast */
  platform: string | null;
  /** Source type: Formal, Community, Case Study, Advertorial */
  sourceType: string | null;
  /** Spark flag indicating high value */
  spark: boolean | null;
  /** Reason for spark flag */
  sparkReason: string | null;
  /** Composite relevance score 0-10 */
  compositeScore: number | null;
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
      const titleFilter = (req.query['title'] as string | undefined)?.trim();
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
      if (titleFilter) {
        conditions.push(`title ILIKE $${p++}`);
        params.push(`%${titleFilter}%`);
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
          taxonomy_tag_ids: string[] | null;
        }>(
          `SELECT ci.id, ci.source_id, ci.title, ci.url, ci.body, ci.published_at, ci.indexed_at,
                  ci.metadata, ci.workflow_state, ci.relevance_score, ci.relevance_explanation,
                  array_agg(dit.tag_id) FILTER (WHERE dit.tag_id IS NOT NULL) AS taxonomy_tag_ids
           FROM content_items ci
           LEFT JOIN discover_item_tags dit ON dit.discover_item_id = ci.id
           ${where}
           GROUP BY ci.id
           ORDER BY
             COALESCE(ci.relevance_score, 0) DESC,
             ci.published_at DESC
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
        taxonomyTagIds: row.taxonomy_tag_ids ?? [],
        articleType: typeof row.metadata['articleType'] === 'string' ? row.metadata['articleType'] : null,
        platform: typeof row.metadata['platform'] === 'string' ? row.metadata['platform'] : null,
        sourceType: typeof row.metadata['sourceType'] === 'string' ? row.metadata['sourceType'] : null,
        spark: typeof row.metadata['spark'] === 'boolean' ? row.metadata['spark'] : null,
        sparkReason: typeof row.metadata['sparkReason'] === 'string' ? row.metadata['sparkReason'] : null,
        compositeScore: typeof row.metadata['compositeScore'] === 'number' ? row.metadata['compositeScore'] : null,
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

// ── Admin auth helper ─────────────────────────────────────────────────────────
function isAdminAuthed(req: Request): boolean {
  const secret = process.env['CRON_SECRET'];
  if (!secret) return false;
  const header = req.headers['x-cron-secret'] as string | undefined;
  const query = req.query['secret'] as string | undefined;
  return header === secret || query === secret;
}

// ── GET /api/discover/admin/score-status ──────────────────────────────────────
// Returns count of unscored articles and a sample of their titles/URLs for diagnosis.
discoverRouter.get('/admin/score-status', (req: Request, res: Response, next: NextFunction): void => {
  if (!isAdminAuthed(req)) { res.status(HTTP_STATUS.UNAUTHORISED).json({ success: false, error: { code: 'UNAUTHORISED', message: 'Bad secret' } }); return; }
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const [countResult, samplesResult] = await Promise.all([
        db.query<{ unscored: string; total: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE relevance_explanation IS NULL) AS unscored,
             COUNT(*) AS total
           FROM content_items WHERE source = 'discovered-article'`,
        ),
        db.query<{ id: string; title: string; url: string | null; relevance_score: number | null }>(
          `SELECT id, title, url, relevance_score
           FROM content_items
           WHERE source = 'discovered-article' AND relevance_explanation IS NULL
           ORDER BY indexed_at DESC
           LIMIT 20`,
        ),
      ]);
      res.json({
        success: true,
        data: {
          unscored: parseInt(countResult.rows[0]?.unscored ?? '0', 10),
          total: parseInt(countResult.rows[0]?.total ?? '0', 10),
          unscoredSample: samplesResult.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  })();
});

// ── POST /api/discover/admin/score-batch ──────────────────────────────────────
// Triggers immediate scoring of the next batch (up to 10) of unscored articles.
discoverRouter.post('/admin/score-batch', (req: Request, res: Response, next: NextFunction): void => {
  if (!isAdminAuthed(req)) { res.status(HTTP_STATUS.UNAUTHORISED).json({ success: false, error: { code: 'UNAUTHORISED', message: 'Bad secret' } }); return; }
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const before = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM content_items WHERE source = 'discovered-article' AND relevance_explanation IS NULL`,
      );
      await scoreUnscored(db);
      const after = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM content_items WHERE source = 'discovered-article' AND relevance_explanation IS NULL`,
      );
      const scored = parseInt(before.rows[0]?.count ?? '0', 10) - parseInt(after.rows[0]?.count ?? '0', 10);
      res.json({ success: true, data: { scored, remainingUnscored: parseInt(after.rows[0]?.count ?? '0', 10) } });
    } catch (err) {
      next(err);
    }
  })();
});
