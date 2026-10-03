import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS, DISCOVER_RECENCY_HALF_LIFE_DAYS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { scoreUnscored } from '../integrations/cms/discoveredArticlesSync.js';
import { syncDiscoveryFeeds, toSource } from '../integrations/discovery/feedSync.js';
import { readFeed } from '../integrations/discovery/feedReader.js';
import { SOURCE_AUTHORITY_WEIGHTS, ARTICLE_TYPE_WEIGHTS } from '../integrations/cms/articleScoringPrompt.js';

/**
 * Builds a SQL CASE expression mapping a metadata text column's value to its weight, generated
 * directly from the same TS weight map used elsewhere — so tuning a weight constant takes effect
 * immediately in ranking, with no backfill/rescore step required to keep SQL and TS in sync.
 */
function buildWeightCaseExpr(column: string, weights: Record<string, number>, fallback = 1): string {
  const whens = Object.entries(weights)
    .map(([key, value]) => `WHEN '${key.replace(/'/g, "''")}' THEN ${value}`)
    .join(' ');
  return `CASE ${column} ${whens} ELSE ${fallback} END`;
}

export const discoverRouter = Router();

export type WorkflowState = 'to-review' | 'saved' | 'blog' | 'archived' | 'published' | 'shelved';

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
  /** Fine-grained source authority tier used in ranking (e.g. "Microsoft/GitHub Official") */
  sourceAuthorityTier: string | null;
  /** Live-computed rank score actually used for ordering (relevance_score with recency decay applied) */
  rankScore: number | null;
  /** 0 = not covered, 1 = same story from another angle, 2 = he has already made this argument */
  alreadyCovered: number | null;
  /** Title of his own piece that covers it */
  coveredBy: string | null;
  /** Vendor group of the feed it came from (Microsoft, Google, AWS, OpenAI, IBM…) */
  sourceGroup: string | null;
  /** When the article was shelved */
  shelvedAt: string | null;
  /** Why: 'low' = scored as not worth content, 'stale' = unactioned past its time in To Review */
  shelvedReason: string | null;
}

const VALID_STATES: WorkflowState[] = ['to-review', 'saved', 'blog', 'archived', 'published', 'shelved'];
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

      const conditions: string[] = [`ci.source = 'discovered-article'`];
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
      // Live rank score (never stored, always recomputed): recency decay (halves every
      // DISCOVER_RECENCY_HALF_LIFE_DAYS) x source authority weight x article type weight,
      // all multiplied onto the editorial relevance_score. Deliberately applied here rather
      // than baked into relevance_score, so the stored/displayed quality percentage never
      // gets distorted or clamp-flattened by ranking-only factors. Weights are computed live
      // from the stored tier/type STRING (via CASE, built from the same TS weight maps) rather
      // than from a stored weight NUMBER, so tuning SOURCE_AUTHORITY_WEIGHTS/ARTICLE_TYPE_WEIGHTS
      // takes effect immediately for every row, with no backfill ever required again.
      const halfLifeParamIndex = p++;
      params.push(DISCOVER_RECENCY_HALF_LIFE_DAYS);
      const authorityWeightExpr = buildWeightCaseExpr(`ci.metadata->>'sourceAuthorityTier'`, SOURCE_AUTHORITY_WEIGHTS, 1);
      const typeWeightExpr = buildWeightCaseExpr(`ci.metadata->>'articleType'`, ARTICLE_TYPE_WEIGHTS, 1);
      const rankScoreExpr = `COALESCE(ci.relevance_score, 0)
           * EXP(- EXTRACT(EPOCH FROM (NOW() - ci.published_at)) / 86400.0 / $${halfLifeParamIndex} * LN(2))
           * (${authorityWeightExpr})
           * (${typeWeightExpr})`;

      const [countResult, dataResult] = await Promise.all([
        db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM content_items ci ${where}`, params.slice(0, halfLifeParamIndex - 1)),
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
          rank_score: number | null;
        }>(
          `SELECT ci.id, ci.source_id, ci.title, ci.url, ci.body, ci.published_at, ci.indexed_at,
                  ci.metadata, ci.workflow_state, ci.relevance_score, ci.relevance_explanation,
                  array_agg(dit.tag_id) FILTER (WHERE dit.tag_id IS NOT NULL) AS taxonomy_tag_ids,
                  ${rankScoreExpr} AS rank_score
           FROM content_items ci
           LEFT JOIN discover_item_tags dit ON dit.discover_item_id = ci.id
           ${where}
           GROUP BY ci.id
           ORDER BY
             rank_score DESC,
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
        sourceAuthorityTier: typeof row.metadata['sourceAuthorityTier'] === 'string' ? row.metadata['sourceAuthorityTier'] : null,
        rankScore: row.rank_score,
        alreadyCovered: typeof row.metadata['alreadyCovered'] === 'number' ? row.metadata['alreadyCovered'] : null,
        coveredBy: typeof row.metadata['coveredBy'] === 'string' && row.metadata['coveredBy'] !== '' ? row.metadata['coveredBy'] : null,
        sourceGroup: typeof row.metadata['sourceGroup'] === 'string' ? row.metadata['sourceGroup'] : null,
        shelvedAt: typeof row.metadata['shelvedAt'] === 'string' ? row.metadata['shelvedAt'] : null,
        shelvedReason: typeof row.metadata['shelvedReason'] === 'string' ? row.metadata['shelvedReason'] : null,
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
discoverRouter.get('/sources', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const state = req.query['state'] as string | undefined;
      const conditions = [`source = 'discovered-article'`];
      const params: unknown[] = [];
      // Scope counts to the currently active tab (e.g. "to-review") by default, so the
      // dropdown reflects what's actually visible there — not a stale grand total across
      // every workflow state including archived items, which is what caused the "1137"
      // count to look wrong right after a bulk archive.
      if (state && VALID_STATES.includes(state as WorkflowState)) {
        conditions.push(`workflow_state = $1`);
        params.push(state);
      }
      const result = await db.query<{ source_title: string; count: string }>(
        `SELECT metadata->>'sourceTitle' AS source_title, COUNT(*) AS count
         FROM content_items
         WHERE ${conditions.join(' AND ')}
         GROUP BY metadata->>'sourceTitle'
         ORDER BY count DESC`,
        params,
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
      // Restoring to To Review restarts the shelving clock; shelving by hand is recorded too.
      const stamp = state === 'to-review'
        ? `, metadata = metadata || jsonb_build_object('restoredAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`
        : state === 'shelved'
          ? `, metadata = metadata || jsonb_build_object('shelvedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`
          : '';
      const result = await db.query(
        `UPDATE content_items SET workflow_state = $1${stamp} WHERE id = $2 AND source = 'discovered-article' RETURNING id`,
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

// ── Feed sources (where discovery looks) ─────────────────────────────────────

const FEED_FIELDS = `id::text, title, feed_url, group_name, is_active, last_checked_at, last_success_at, last_error, last_new_count, articles_found`;

function feedBody(req: Request): { title: string; feedUrl: string; groupName: string } {
  const b = req.body as { title?: unknown; feedUrl?: unknown; groupName?: unknown };
  return {
    title: typeof b.title === 'string' ? b.title.trim() : '',
    feedUrl: typeof b.feedUrl === 'string' ? b.feedUrl.trim() : '',
    groupName: typeof b.groupName === 'string' && b.groupName.trim() !== '' ? b.groupName.trim() : 'Other',
  };
}

// ── GET /api/discover/feeds ───────────────────────────────────────────────────
discoverRouter.get('/feeds', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { rows } = await getDb().query(`SELECT ${FEED_FIELDS} FROM discovery_sources ORDER BY group_name, title`);
      res.json({ success: true, data: rows.map((r) => toSource(r as Parameters<typeof toSource>[0])) });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/discover/feeds — add a source (checked first, so a bad address is reported straight away) ──
discoverRouter.post('/feeds', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { title, feedUrl, groupName } = feedBody(req);
      if (title === '' || !/^https?:\/\//i.test(feedUrl)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: { code: 'BAD_REQUEST', message: 'A name and an http(s) feed address are needed.' } });
        return;
      }
      let articles;
      try {
        articles = await readFeed(feedUrl);
      } catch (err) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: { code: 'BAD_FEED', message: `That address didn't work as a feed: ${err instanceof Error ? err.message : String(err)}` } });
        return;
      }
      const { rows } = await getDb().query(
        `INSERT INTO discovery_sources (title, feed_url, group_name) VALUES ($1, $2, $3)
         ON CONFLICT (feed_url) DO UPDATE SET title = EXCLUDED.title, group_name = EXCLUDED.group_name, is_active = true
         RETURNING ${FEED_FIELDS}`,
        [title, feedUrl, groupName],
      );
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: { ...toSource(rows[0] as Parameters<typeof toSource>[0]), itemsInFeed: articles.length } });
    } catch (err) { next(err); }
  })();
});

// ── PATCH /api/discover/feeds/:id — switch on/off, rename ───────────────────
discoverRouter.patch('/feeds/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const b = req.body as { isActive?: unknown; title?: unknown; groupName?: unknown };
      const { rows } = await getDb().query(
        `UPDATE discovery_sources
            SET is_active = COALESCE($2, is_active), title = COALESCE($3, title), group_name = COALESCE($4, group_name),
                last_error = CASE WHEN $2 = true THEN NULL ELSE last_error END
          WHERE id::text = $1 RETURNING ${FEED_FIELDS}`,
        [req.params['id'], typeof b.isActive === 'boolean' ? b.isActive : null, typeof b.title === 'string' && b.title.trim() !== '' ? b.title.trim() : null, typeof b.groupName === 'string' && b.groupName.trim() !== '' ? b.groupName.trim() : null],
      );
      if (rows.length === 0) { res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: { code: 'NOT_FOUND', message: 'Source not found' } }); return; }
      res.json({ success: true, data: toSource(rows[0] as Parameters<typeof toSource>[0]) });
    } catch (err) { next(err); }
  })();
});

// ── DELETE /api/discover/feeds/:id — stop reading it (its articles stay) ─────
discoverRouter.delete('/feeds/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      await getDb().query(`DELETE FROM discovery_sources WHERE id::text = $1`, [req.params['id']]);
      res.json({ success: true });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/discover/feeds/check — read all sources now (runs in the background) ──
discoverRouter.post('/feeds/check', (_req: Request, res: Response): void => {
  void syncDiscoveryFeeds(getDb()).catch((err: unknown) => { console.error('[Discovery] manual check failed:', err); });
  res.status(HTTP_STATUS.ACCEPTED).json({ success: true, data: { started: true } });
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
