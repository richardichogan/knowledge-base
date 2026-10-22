import { CONTENT_FORMATS, formatFitSql, isContentFormat, type ContentFormat, type FormatFit } from '../integrations/cms/formatFit.js';
import { Router } from 'express';
import { positiveInteger } from '../utils/queryValidation.js';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS, DISCOVER_RECENCY_HALF_LIFE_DAYS } from '../config/constants.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { scoreUnscored } from '../integrations/cms/discoveredArticlesSync.js';
import { syncDiscoveryFeeds, toSource } from '../integrations/discovery/feedSync.js';
import { readFeed } from '../integrations/discovery/feedReader.js';
import { discoverRankSql, discoverDiversitySql } from '../integrations/cms/discoverRank.js';
import { interestSql } from '../services/discoverInterests.js';
import { generateLinkedInDraft, generateShortSocialDraft, sourceUrl, type LinkedInSource } from '../ai/linkedInDraft.js';
import { findEarlierPosts, generateBlogDraft } from '../ai/blogDraft.js';
import { BLOG_CATEGORIES } from '../ai/blogHouseStyle.js';
import { parsePublishBody, sendToBlog } from '../services/blogPublisher.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { BlueskyPostUnconfirmedError, blueskyConfigured, postToBluesky } from '../integrations/social/bluesky.js';
import { getDiscoverParking, saveDiscoverParking, removeDiscoverParking, type DiscoverParking } from '../services/discoverParking.js';
import { resolveDiscoveryFeed, readYouTubeVideo } from '../integrations/discovery/youtube.js';
import { collectYouTubeEvidence, relatedYouTubeArticles } from '../integrations/discovery/youtubeEvidence.js';
import { upsertContentItem } from '../db/queries.js';

export const discoverRouter = Router();

discoverRouter.get('/blog-categories', (_req: Request, res: Response): void => {
  res.json({ success: true, data: BLOG_CATEGORIES });
});

export type WorkflowState = 'to-review' | 'saved' | 'blog' | 'archived' | 'published' | 'shelved';

export interface DiscoverItem {
  feedbackVote?: 'up' | 'down' | null;
  contentBasis?: 'description-only' | 'captions';
  relatedArticles?: Array<{ title: string; url: string }>;
  parking?: DiscoverParking;
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
  /** 0-3 fit per publishing format (newsletter, podcast, full/quick blog, social). */
  formatFit: FormatFit;
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
  pickReasons: string[];
  filteredReason: string | null;
  rankFactors: {
    editorial: number | null; recency: number | null; authority: number; articleType: number;
    project: number; halfLifeDays: number; computedAt: string;
    interests: number; diversity: number;
  };
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
  /** Live projects this article is useful to (fit 2 = directly, 1 = background), strongest first */
  projectFit: Array<{ projectId: string; name: string; fit: 1 | 2; why: string }>;
}

const VALID_STATES: WorkflowState[] = ['to-review', 'saved', 'blog', 'archived', 'published', 'shelved'];
const DISCOVER_PAGE_SIZE_DEFAULT = 50;
const DISCOVER_PAGE_SIZE_MAX = 100;
const DISCOVER_ENUM_MAX_LENGTH = 32;
const BLOG_RELATED_SOURCE_CHARS = 2000;
const BLUESKY_REQUEST_MAX_CHARS = 2000;
const VIDEO_URL_MAX_CHARS = 2048;
const DISCOVER_FILTER_MAX_LENGTH = 256;
const DISCOVER_BOOLEAN_MAX_LENGTH = 5;
const RANK_FACTOR_PRECISION = 2;
const ASCII_SPACE = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximum || [...value].some(character => character.charCodeAt(0) < ASCII_SPACE)) {
    throw new ValidationError(`Invalid ${name}`);
  }
  return value.trim() || undefined;
}

discoverRouter.post('/:id/linkedin-draft', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const format = (req.body as { format?: unknown } | undefined)?.format ?? 'linkedin';
      if (format !== 'linkedin' && format !== 'short') {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Unsupported social draft format' } });
        return;
      }
      const id = req.params['id'];
      if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid Discover item ID' } });
        return;
      }
      const { rows } = await getDb().query<LinkedInSource & { bluesky_post_url: string | null }>(
        `SELECT title, body, source, url, metadata->'blueskyPost'->>'url' AS bluesky_post_url
         FROM content_items WHERE id = $1 AND source IN ('email', 'discovered-article')`,
        [id],
      );
      const source = rows[0];
      if (!source) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: { code: 'NOT_FOUND', message: 'Discover item not found' } });
        return;
      }
      if (!source.body.trim()) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: { code: 'BAD_REQUEST', message: 'This source has no content to draft from.' } });
        return;
      }
      const draft = await (format === 'short' ? generateShortSocialDraft(source) : generateLinkedInDraft(source));
      res.json({ success: true, data: { ...draft, blueskyConfigured: blueskyConfigured(), blueskyPostUrl: source.bluesky_post_url } });
    } catch (err) { next(err); }
  })();
});

// Posts the reviewed quick-social copy plus the original article link to Bluesky, then files the article as Published.
discoverRouter.post('/:id/bluesky-post', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const id = req.params['id'];
      if (!id || !UUID.test(id)) throw new ValidationError('Invalid Discover item ID');
      const copy = (req.body as { post?: unknown } | undefined)?.post;
      if (typeof copy !== 'string' || copy.length > BLUESKY_REQUEST_MAX_CHARS) throw new ValidationError('Post text is required.');
      const db = getDb();
      // Atomic claim: only one request can move the article from "never posted" to "posting".
      const { rows } = await db.query<{ title: string; body: string; url: string | null }>(
        `UPDATE content_items
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('blueskyPost', jsonb_build_object('status', 'posting', 'claimedAt', NOW()))
         WHERE id = $1 AND source = 'discovered-article' AND metadata->'blueskyPost' IS NULL
         RETURNING title, body, url`, [id],
      );
      const item = rows[0];
      if (!item) {
        const existing = await db.query<{ post_url: string | null; status: string | null }>(
          `SELECT metadata->'blueskyPost'->>'url' AS post_url, metadata->'blueskyPost'->>'status' AS status
           FROM content_items WHERE id = $1 AND source = 'discovered-article'`, [id],
        );
        const state = existing.rows[0];
        if (!state) throw new NotFoundError('Discover article');
        if (state.post_url) throw new ConflictError(`This article is already on Bluesky: ${state.post_url}`, 'BLUESKY_ALREADY_POSTED');
        throw new ConflictError(
          state.status === 'unconfirmed'
            ? 'An earlier Bluesky post for this article may have gone out. Check your Bluesky profile; it will not be posted again from here.'
            : 'This article is already being posted to Bluesky.',
          'BLUESKY_POST_IN_PROGRESS',
        );
      }

      const link = sourceUrl(item.url);
      const description = item.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      let posted;
      try {
        posted = await postToBluesky(copy, link ? { url: link, title: item.title, description } : null);
      } catch (err) {
        // Release the claim only when nothing could have been published; otherwise keep it so a retry cannot duplicate.
        await (err instanceof BlueskyPostUnconfirmedError
          ? db.query(
            `UPDATE content_items SET metadata = jsonb_set(metadata, '{blueskyPost,status}', '"unconfirmed"')
             WHERE id = $1 AND metadata->'blueskyPost'->>'status' = 'posting'`, [id],
          )
          : db.query(
            `UPDATE content_items SET metadata = metadata - 'blueskyPost'
             WHERE id = $1 AND metadata->'blueskyPost'->>'status' = 'posting'`, [id],
          )).catch((releaseErr: unknown) => { console.error('[bluesky] could not update the post claim:', releaseErr); });
        throw err;
      }
      try {
        await db.query(
          `UPDATE content_items SET workflow_state = 'published',
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('blueskyPost', jsonb_build_object('status', 'posted', 'url', $2::text, 'uri', $3::text, 'postedAt', NOW()))
           WHERE id = $1`,
          [id, posted.url, posted.uri],
        );
      } catch (recordErr) {
        // The post is live and the "posting" claim still blocks a repeat, so report success rather than invite a retry.
        console.error(`[bluesky] posted ${posted.url} but could not record it on ${id}:`, recordErr);
      }
      res.json({ success: true, data: posted });
    } catch (err) { next(err); }
  })();
});

discoverRouter.post('/:id/blog-draft', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const id = req.params['id'];
      if (!id || !UUID.test(id)) throw new ValidationError('Invalid Discover item ID');
      const { rows } = await getDb().query<LinkedInSource>(
        `SELECT title, body, source, url FROM content_items WHERE id = $1 AND source IN ('email', 'discovered-article')`, [id],
      );
      const source = rows[0];
      if (!source) throw new NotFoundError('Discover item');
      if (!source.body.trim()) throw new ValidationError('This source has no content to draft from.');
      const length = (req.body as { length?: unknown } | undefined)?.length === 'long' ? 'long' : 'short';
      const earlier = length === 'short' ? await findEarlierPosts(getDb(), `${source.title} ${source.body.slice(0, BLOG_RELATED_SOURCE_CHARS)}`) : [];
      res.json({ success: true, data: await generateBlogDraft(source, sourceUrl(source.url), length, earlier) });
    } catch (err) { next(err); }
  })();
});

discoverRouter.post('/:id/blog-publish', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const id = req.params['id'];
      if (!id || !UUID.test(id)) throw new ValidationError('Invalid Discover item ID');
      const post = parsePublishBody(req.body);
      const item = await getDb().query(`SELECT id FROM content_items WHERE id=$1 AND source IN ('email','discovered-article')`, [id]);
      if (item.rows.length === 0) throw new NotFoundError('Discover item');
      const sent = await sendToBlog(post);
      if (sent.payload.success && post.status === 'published') {
        await getDb().query(`UPDATE content_items SET workflow_state='published' WHERE id=$1 AND source='discovered-article'`, [id]);
      }
      res.status(sent.httpStatus).json(sent.payload);
    } catch (err) { next(err); }
  })();
});

discoverRouter.get('/:id/parking', (req: Request, res: Response, next: NextFunction): void => {
  void getDiscoverParking(getDb(), req.params['id'] ?? '')
    .then(data => { res.json({ success: true, data }); }).catch(next);
});
discoverRouter.put('/:id/parking', (req: Request, res: Response, next: NextFunction): void => {
  void saveDiscoverParking(getDb(), req.params['id'] ?? '', req.body as unknown)
    .then(data => { res.json({ success: true, data }); }).catch(next);
});
discoverRouter.delete('/:id/parking', (req: Request, res: Response, next: NextFunction): void => {
  void removeDiscoverParking(getDb(), req.params['id'] ?? '')
    .then(() => { res.json({ success: true, data: null }); }).catch(next);
});

// The parking pool shares article hydration but never filters by workflow state.
const serveDiscoverFeed = (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const isParking = req.path === '/parking-lot';
      const parkingJoin = `${isParking ? 'JOIN' : 'LEFT JOIN'} discover_parking pl ON pl.article_id=ci.id`;
      const state = queryText(req.query['state'], 'state', DISCOVER_ENUM_MAX_LENGTH) ?? 'to-review';
      if (!VALID_STATES.some(value => value === state)) throw new ValidationError('Unsupported Discovery state');
      const sort = queryText(req.query['sort'], 'sort', DISCOVER_ENUM_MAX_LENGTH) ?? 'weighted';
      const orders: Record<string, string> = {
        weighted: 'rank_score DESC NULLS LAST, ci.published_at DESC NULLS LAST, ci.id ASC',
        editorial: 'ci.relevance_score DESC NULLS LAST, ci.published_at DESC NULLS LAST, ci.id ASC',
        latest: 'ci.published_at DESC NULLS LAST, ci.id ASC',
      };
      const order = isParking ? 'ci.parked_at DESC, ci.id ASC' : orders[sort];
      if (!Object.hasOwn(orders, sort) || !order) throw new ValidationError('Unsupported Discovery sort');
      const formatParam = queryText(req.query['format'], 'format', DISCOVER_ENUM_MAX_LENGTH);
      if (formatParam !== undefined && !isContentFormat(formatParam)) throw new ValidationError('Unsupported Discovery format');
      const format = formatParam;
      const sourceFilter = queryText(req.query['source'], 'source', DISCOVER_FILTER_MAX_LENGTH);
      const titleFilter = queryText(req.query['title'], 'title', DISCOVER_FILTER_MAX_LENGTH);
      const page = positiveInteger(req.query['page'], 'page', 1);
      const pageSize = positiveInteger(req.query['pageSize'], 'pageSize', DISCOVER_PAGE_SIZE_DEFAULT, DISCOVER_PAGE_SIZE_MAX);
      const offset = (page - 1) * pageSize;
      if (!Number.isSafeInteger(offset)) throw new ValidationError('Discovery page is too large');
      const filteredParam = queryText(req.query['filtered'], 'filtered', DISCOVER_BOOLEAN_MAX_LENGTH);
      if (filteredParam !== undefined && filteredParam !== 'true') throw new ValidationError('Invalid filtered view.');
      const filtered = filteredParam === 'true';
      const interests = interestSql('ci');

      const conditions: string[] = [`ci.source = 'discovered-article'`];
      const params: unknown[] = [];
      let p = 1;

      if (!isParking && !filtered && VALID_STATES.includes(state as WorkflowState)) {
        conditions.push(`workflow_state = $${p++}`);
        params.push(state);
      }
      if (sourceFilter) {
        conditions.push(`metadata->>'sourceTitle' = $${p++}`);
        params.push(sourceFilter);
      }
      if (titleFilter) {
        conditions.push(`title ILIKE $${p++}`);
        params.push(`%${titleFilter.replace(/[\\%_]/g, '\\$&')}%`);
      }
      if (isParking && filtered) throw new ValidationError('The parking lot is independent of the filtered-out view.');
      if (filtered) {
        conditions.push(`ci.published_at >= NOW()-INTERVAL '7 days'`);
        conditions.push(`(ci.workflow_state IN ('shelved','archived') OR (${interests.eligible})=0)`);
      } else if (!isParking && state === 'to-review') conditions.push(`(${interests.eligible})>0`);

      // Ranking for a format lists only articles that suit it, strongest fit first, then by rank.
      if (format !== undefined) conditions.push(`${formatFitSql('ci', format)} >= 1`);
      const where = `WHERE ${conditions.join(' AND ')}`;
      // Live rank score (never stored, always recomputed): recency decay (halves every
      // DISCOVER_RECENCY_HALF_LIFE_DAYS) x source authority weight x article type weight,
      // all multiplied onto the editorial relevance_score. Deliberately applied here rather
      // than baked into relevance_score, so the stored/displayed quality percentage never
      // gets distorted or clamp-flattened by ranking-only factors. Weights are computed live
      // from the stored tier/type STRING (via CASE, built from the same TS weight maps) rather
      // than from a stored weight NUMBER, so tuning SOURCE_AUTHORITY_WEIGHTS/ARTICLE_TYPE_WEIGHTS
      // takes effect immediately for every row, with no backfill ever required again.
      // Articles useful to a live project (projectFit.ts) are lifted by their stored project boost.
      const halfLifeParamIndex = p++;
      params.push(DISCOVER_RECENCY_HALF_LIFE_DAYS);
      const { rank: rankScoreExpr, recency: recencyExpr, authority: authorityWeightExpr, articleType: typeWeightExpr, project: projectExpr }
        = discoverRankSql('ci', `$${halfLifeParamIndex}`);
      const diversity = !isParking && !filtered && state === 'to-review' && sort === 'weighted' && !sourceFilter && format === undefined
        ? discoverDiversitySql('ci') : '1.0';

      const [countResult, dataResult] = await Promise.all([
        db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM content_items ci ${parkingJoin} ${where}`, params.slice(0, halfLifeParamIndex - 1)),
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
          diversity_factor: number;
          recency_factor: number | null;
          authority_factor: number;
          type_factor: number;
          project_factor: number;
          rank_computed_at: Date;
          interest_topics: string | null; interest_source: number; saved_factor: number; learned_factor: number; interest_factor: number;
          parking: DiscoverParking | null;
        } & Record<`fit_${ContentFormat}`, number>>(
          `WITH ranked AS MATERIALIZED (SELECT ci.id, ci.source_id, ci.title, ci.url, ci.body, ci.published_at, ci.indexed_at,
                  ci.metadata, ci.workflow_state, ci.relevance_score, ci.relevance_explanation,
                  CASE WHEN pl.article_id IS NOT NULL THEN
                    jsonb_build_object('newsletter',pl.newsletter,'podcast',pl.podcast,'parkedAt',pl.parked_at,'updatedAt',pl.updated_at)
                  END AS parking, pl.parked_at AS parked_at,
                  array_agg(dit.tag_id) FILTER (WHERE dit.tag_id IS NOT NULL) AS taxonomy_tag_ids,
                  (${rankScoreExpr}) * (${interests.factor}) AS base_rank_score,
                  ${interests.topics} AS interest_topics, ${interests.source} AS interest_source, ${interests.saved} AS saved_factor, ${interests.learned} AS learned_factor,
                  (${interests.factor}) AS interest_factor,
                  ${recencyExpr} AS recency_factor, (${authorityWeightExpr}) AS authority_factor,
                  (${typeWeightExpr}) AS type_factor, ${projectExpr} AS project_factor,
                  ${CONTENT_FORMATS.map((f) => `${formatFitSql('ci', f)} AS "fit_${f}"`).join(', ')},
                  NOW() AS rank_computed_at
           FROM content_items ci
           ${parkingJoin}
           LEFT JOIN discover_item_tags dit ON dit.discover_item_id = ci.id
           ${where}
           GROUP BY ci.id, pl.article_id)
           SELECT ci.*, ${diversity} AS diversity_factor,
                  ci.base_rank_score * ${diversity} AS rank_score
           FROM ranked ci
           ORDER BY ${format === undefined ? order : `"fit_${format}" DESC, ${order}`}
           LIMIT $${p++} OFFSET $${p}`,
          [...params, pageSize, offset],
        ),
      ]);

      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);
      const items: DiscoverItem[] = dataResult.rows.map((row) => ({
        ...(row.parking ? { parking: row.parking } : {}),
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
        platform: (row.metadata['platform'] === 'Podcast Topic' || row.metadata['platform'] === 'Podcast') && Number(row.fit_podcast) === 0
          ? null : typeof row.metadata['platform'] === 'string' ? row.metadata['platform'] : null,
        sourceType: typeof row.metadata['sourceType'] === 'string' ? row.metadata['sourceType'] : null,
        spark: typeof row.metadata['spark'] === 'boolean' ? row.metadata['spark'] : null,
        sparkReason: typeof row.metadata['sparkReason'] === 'string' ? row.metadata['sparkReason'] : null,
        feedbackVote: row.metadata['feedbackVote'] === 'up' || row.metadata['feedbackVote'] === 'down' ? row.metadata['feedbackVote'] : null,
        compositeScore: typeof row.metadata['compositeScore'] === 'number' ? row.metadata['compositeScore'] : null,
        sourceAuthorityTier: typeof row.metadata['sourceAuthorityTier'] === 'string' ? row.metadata['sourceAuthorityTier'] : null,
        rankScore: row.rank_score,
        pickReasons: [
          row.relevance_explanation || 'Awaiting editorial assessment.',
          `Source weight ×${Number(row.interest_source)}; recency ×${Number(row.recency_factor ?? 0).toFixed(RANK_FACTOR_PRECISION)}.`,
          ...(row.interest_topics ? [`Matched topics: ${row.interest_topics}.`] : []),
          ...(Number(row.saved_factor) > 1 ? ['You previously saved articles from this source (×1.1).'] : []),
          ...(Number(row.learned_factor) !== 1 ? [`Learned from what you kept or archived from this source (×${Number(row.learned_factor)}).`] : []),
          ...(Number(row.diversity_factor) < 1 ? ['Balanced with other sources to avoid a feed dominated by one publisher family.'] : []),
        ],
        filteredReason: filtered ? (Number(row.interest_source) === 0 ? 'Source weight is zero.'
          : row.workflow_state === 'shelved' ? `Shelved: ${String(row.metadata['shelvedReason'] ?? 'editorial triage or age')}.`
            : row.workflow_state === 'archived' ? 'Archived during triage.' : 'A matching topic has weight zero.') : null,
        rankFactors: {
          editorial: row.relevance_score === null ? null : Number(row.relevance_score),
          recency: row.recency_factor === null ? null : Number(row.recency_factor),
          authority: Number(row.authority_factor), articleType: Number(row.type_factor),
          project: Number(row.project_factor), halfLifeDays: DISCOVER_RECENCY_HALF_LIFE_DAYS,
          interests: Number(row.interest_factor),
          diversity: Number(row.diversity_factor),
          computedAt: row.rank_computed_at.toISOString(),
        },
        alreadyCovered: typeof row.metadata['alreadyCovered'] === 'number' ? row.metadata['alreadyCovered'] : null,
        coveredBy: typeof row.metadata['coveredBy'] === 'string' && row.metadata['coveredBy'] !== '' ? row.metadata['coveredBy'] : null,
        sourceGroup: typeof row.metadata['sourceGroup'] === 'string' ? row.metadata['sourceGroup'] : null,
        ...(['description-only', 'captions'].includes(String(row.metadata['contentBasis']))
          ? { contentBasis: row.metadata['contentBasis'] as 'description-only' | 'captions' } : {}),
        relatedArticles: relatedYouTubeArticles(row.metadata),
        shelvedAt: typeof row.metadata['shelvedAt'] === 'string' ? row.metadata['shelvedAt'] : null,
        shelvedReason: typeof row.metadata['shelvedReason'] === 'string' ? row.metadata['shelvedReason'] : null,
        formatFit: Object.fromEntries(CONTENT_FORMATS.map((f) => [f, Number(row[`fit_${f}`])])) as FormatFit,
        projectFit: Array.isArray(row.metadata['projectFit']) ? row.metadata['projectFit'] as DiscoverItem['projectFit'] : [],
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
};
discoverRouter.get('/', serveDiscoverFeed);
discoverRouter.get('/parking-lot', serveDiscoverFeed);

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

// ── PUT /api/discover/:id/feedback ───────────────────────────────────────────
// Thumbs up/down teaches source ranking (learnedSourceSql); a down-vote also archives
// a To review article. vote=null clears it.
discoverRouter.put('/:id/feedback', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const vote = (req.body as { vote?: unknown }).vote;
      if (vote !== 'up' && vote !== 'down' && vote !== null) throw new ValidationError('vote must be up, down or null');
      const result = await getDb().query(
        `UPDATE content_items SET
           metadata = CASE WHEN $1::text IS NULL THEN metadata - 'feedbackVote'
             ELSE metadata || jsonb_build_object('feedbackVote', $1::text) END,
           workflow_state = CASE WHEN $1::text = 'down' AND workflow_state IN ('to-review','shelved') THEN 'archived' ELSE workflow_state END
         WHERE id = $2 AND source = 'discovered-article' RETURNING workflow_state`,
        [vote, req.params['id']],
      );
      const row = result.rows[0] as { workflow_state: WorkflowState } | undefined;
      if (row === undefined) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
        return;
      }
      res.json({ success: true, data: { feedbackVote: vote, workflowState: row.workflow_state } });
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

discoverRouter.post('/videos', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const raw: unknown = (req.body as { url?: unknown }).url;
      if (typeof raw !== 'string' || raw.length > VIDEO_URL_MAX_CHARS) throw new ValidationError('Enter a YouTube video URL.');
      const video = await readYouTubeVideo(raw);
      const evidence = await collectYouTubeEvidence(video);
      const discoveredAt = new Date().toISOString();
      const result = await upsertContentItem(getDb(), {
        source: 'discovered-article', sourceId: `youtube-${video.videoId}`, title: video.title,
        summary: `YouTube - ${video.channel} - ${evidence.metadata['contentBasis'] === 'captions' ? 'public captions' : 'description only'}`, body: evidence.body,
        publishedAt: (video.publishedAt ?? new Date()).toISOString(), url: video.url, projectContext: 'msft-blog',
        tags: [video.channel], metadata: {
          sourceTitle: video.channel, sourceGroup: 'YouTube', contentKind: 'youtube-video', videoId: video.videoId,
          durationSeconds: video.durationSeconds, ...evidence.metadata,
          discoveredAt, status: 'new',
        },
      });
      res.status(result.isNew ? HTTP_STATUS.CREATED : HTTP_STATUS.OK).json({ success: true, data: { id: result.id, title: video.title, isNew: result.isNew } });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/discover/feeds — add a source (checked first, so a bad address is reported straight away) ──
discoverRouter.post('/feeds', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { title, feedUrl: submittedUrl, groupName } = feedBody(req);
      let feedUrl = submittedUrl;
      if (title === '' || !/^https?:\/\//i.test(feedUrl)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: { code: 'BAD_REQUEST', message: 'A name and an http(s) feed address are needed.' } });
        return;
      }
      let articles;
      try {
        feedUrl = await resolveDiscoveryFeed(feedUrl);
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
