/**
 * routes/sparkRoutes.ts
 * REST API for sparks and spark clusters.
 *
 * POST   /api/sparks              — create a spark
 * POST   /api/sparks/from-article — read a Discover article and capture its argument
 * GET    /api/sparks              — list sparks (query: source_id, source_type, cluster_id, attached, clustered, q, limit, offset)
 * GET    /api/sparks/related      — sparks captured from / connected to an item (query: ref_id, ref_type)
 * PATCH  /api/sparks/:id          — edit body, move theme (cluster_id, null = loose), mark used (used, null = clear)
 * DELETE /api/sparks/:id          — delete a spark
 * GET    /api/spark-clusters      — list themes with their sparks (query: status=active,developed | surfaced | dismissed)
 * GET    /api/spark-clusters/unsurfaced-count — themes not yet seen (Think nav dot)
 * POST   /api/spark-clusters      — create a theme from sparks (body: { theme, sparkIds })
 * PATCH  /api/spark-clusters/:id  — rename, status, surfaced, output (what it became), markSparksUsed
 * POST   /api/spark-clusters/:id/merge — merge this theme into body.intoId
 * POST   /api/spark-clusters/:id/graduate — turn the theme into a note | canvas | project | tasks (body.target), recording the output
 * POST   /api/spark-clusters/:id/blog-draft — AI blog draft from the theme's sparks (body.length short|long)
 * POST   /api/spark-clusters/:id/blog-publish — send to the blog; records the output on success
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { ValidationError } from '../types/errors.js';
import { createSpark, listSparks, deleteSpark, updateSpark, relatedSparks, listThemes, updateTheme, mergeThemes, createTheme } from '../services/sparkService.js';
import { MIN_THEME_SIZE } from '../jobs/clusteringJob.js';
import { graduateTheme, getTheme, type GraduationTarget } from '../services/sparkGraduation.js';
import { handOff } from '../agents/index.js';
import { parsePublishBody, sendToBlog } from '../services/blogPublisher.js';
import { assertVerifiedBlogJob } from '../services/blogJobs.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import type { Spark, SparkOutput, ThemeStatus, UpdateSparkInput, UpdateThemeInput } from '../services/sparkService.js';
import { readDiscoverArgument } from '../services/sparkSourceReading.js';

const OUTPUT_TYPES = ['note', 'blog', 'canvas', 'project', 'tasks'];

function parseOutput(v: unknown): SparkOutput | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['type'] !== 'string' || !OUTPUT_TYPES.includes(o['type']) || typeof o['ref'] !== 'string' || typeof o['title'] !== 'string') {
    throw new ValidationError('output needs type (note|blog|canvas|project), ref and title');
  }
  return { type: o['type'] as SparkOutput['type'], ref: o['ref'], title: o['title'], url: typeof o['url'] === 'string' ? o['url'] : null };
}

export const sparkRouter = Router();
export const sparkClusterRouter = Router();

sparkRouter.post('/from-article', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { source_id, tags } = req.body as { source_id?: unknown; tags?: unknown };
      if (typeof source_id !== 'string' || !source_id.trim()) throw new ValidationError('source_id is required');
      const tagNames: string[] = [];
      if (tags !== undefined) {
        if (!Array.isArray(tags)) throw new ValidationError('tags must be an array of names');
        for (const tag of tags) {
          if (typeof tag !== 'string') throw new ValidationError('tags must be an array of names');
          tagNames.push(tag);
        }
      }
      const db = getDb();
      const source = await readDiscoverArgument(db, source_id);
      const spark = await createSpark(db, { body: `${source.title}\n\n${source.argument}`,
        sourceId: source_id, sourceType: 'discover_item', tags: tagNames });
      res.status(HTTP_STATUS.CREATED).json({ success: true, data: spark });
    } catch (error) { next(error); }
  })();
});

// ── POST /api/sparks ──────────────────────────────────────────────────────────

sparkRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { body, tags, source_id, source_type } = req.body as {
        body?: string; tags?: string[];
        source_id?: string | null; source_type?: string | null;
      };
      if (!body || body.trim() === '') throw new ValidationError('body is required');
      if ((source_id == null) !== (source_type == null)) {
        throw new ValidationError('source_id and source_type must both be present or both absent');
      }
      const db = getDb();
      const spark = await createSpark(db, {
        body: body.trim(), tags: tags ?? [],
        sourceId: source_id ?? null, sourceType: source_type ?? null,
      });
      const out: ApiSuccess<Spark> = { success: true, data: spark };
      res.status(HTTP_STATUS.CREATED).json(out);
    } catch (err) { next(err); }
  })();
});

// ── GET /api/sparks ───────────────────────────────────────────────────────────

sparkRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const attached = q['attached'] === 'true' ? true : q['attached'] === 'false' ? false : undefined;
      const db = getDb();
      const params: Record<string, unknown> = {};
      if (q['id'] !== undefined) {
        if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(q['id'])) throw new ValidationError('Invalid spark ID');
        params['id'] = q['id'];
      }
      if (attached !== undefined) params['attached'] = attached;
      if (q['source_id'])   params['sourceId']   = q['source_id'];
      if (q['source_type']) params['sourceType'] = q['source_type'];
      if (q['cluster_id'])  params['clusterId']  = q['cluster_id'];
      if (q['clustered'] === 'true')  params['clustered'] = true;
      if (q['clustered'] === 'false') params['clustered'] = false;
      if (q['q']) params['search'] = q['q'];
      if (q['limit']  !== undefined) params['limit']  = parseInt(q['limit'],  10);
      if (q['offset'] !== undefined) params['offset'] = parseInt(q['offset'], 10);
      const sparks = await listSparks(db, params as Parameters<typeof listSparks>[1]);
      const out: ApiSuccess<Spark[]> = { success: true, data: sparks };
      res.status(HTTP_STATUS.OK).json(out);
    } catch (err) { next(err); }
  })();
});

// ── GET /api/sparks/related ───────────────────────────────────────────────────

sparkRouter.get('/related', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      if (!q['ref_id'] || !q['ref_type']) throw new ValidationError('ref_id and ref_type are required');
      const data = await relatedSparks(getDb(), q['ref_id'], q['ref_type']);
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── PATCH /api/sparks/:id ─────────────────────────────────────────────────────

sparkRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const b = req.body as { body?: string; cluster_id?: string | null; used?: unknown };
      const input: UpdateSparkInput = {};
      if (b.body !== undefined) input.body = b.body;
      if (b.cluster_id !== undefined) input.clusterId = b.cluster_id;
      const used = parseOutput(b.used);
      if (used !== undefined) input.used = used;
      const spark = await updateSpark(getDb(), req.params['id']!, input);
      res.status(HTTP_STATUS.OK).json({ success: true, data: spark });
    } catch (err) { next(err); }
  })();
});

// ── DELETE /api/sparks/:id ────────────────────────────────────────────────────

sparkRouter.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      await deleteSpark(db, req.params['id']!);
      res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (err) { next(err); }
  })();
});

// ── GET /api/spark-clusters/unsurfaced-count ─────────────────────────────────

sparkClusterRouter.get('/unsurfaced-count', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const row = await getDb().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM spark_clusters
         WHERE spark_count >= $1 AND surfaced = false AND status IN ('active', 'developed')`,
        [MIN_THEME_SIZE],
      );
      const count = parseInt(row.rows[0]?.count ?? '0', 10);
      res.status(HTTP_STATUS.OK).json({ success: true, data: { count } });
    } catch (err) { next(err); }
  })();
});

// ── GET /api/spark-clusters ───────────────────────────────────────────────────

sparkClusterRouter.get('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      let statuses: ThemeStatus[] | undefined;
      if (q['status']) statuses = q['status'].split(',').filter((s): s is ThemeStatus => ['active', 'developed', 'dismissed'].includes(s));
      else if (q['dismissed'] === 'false') statuses = ['active', 'developed'];
      else if (q['dismissed'] === 'true') statuses = ['dismissed'];
      let data = await listThemes(getDb(), statuses);
      if (q['surfaced'] !== undefined) data = data.filter((t) => t.surfaced === (q['surfaced'] === 'true'));
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/spark-clusters ──────────────────────────────────────────────────

sparkClusterRouter.post('/', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { theme, sparkIds } = req.body as { theme?: string; sparkIds?: string[] };
      if (typeof theme !== 'string' || !Array.isArray(sparkIds)) throw new ValidationError('theme and sparkIds are required');
      const data = await createTheme(getDb(), theme, sparkIds);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── PATCH /api/spark-clusters/:id ────────────────────────────────────────────

sparkClusterRouter.patch('/:id', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const b = req.body as { theme?: string; status?: ThemeStatus; dismissed?: boolean; surfaced?: boolean; output?: unknown; markSparksUsed?: boolean };
      const input: UpdateThemeInput = {};
      if (b.theme !== undefined) input.theme = b.theme;
      if (b.status !== undefined) input.status = b.status;
      else if (b.dismissed !== undefined) input.status = b.dismissed ? 'dismissed' : 'active';
      if (b.surfaced !== undefined) input.surfaced = b.surfaced;
      const output = parseOutput(b.output);
      if (output !== undefined) input.output = output;
      if (b.markSparksUsed !== undefined) input.markSparksUsed = b.markSparksUsed;
      const data = await updateTheme(getDb(), req.params['id']!, input);
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/spark-clusters/:id/merge ───────────────────────────────────────

sparkClusterRouter.post('/:id/merge', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const { intoId } = req.body as { intoId?: string };
      if (typeof intoId !== 'string') throw new ValidationError('intoId is required');
      const data = await mergeThemes(getDb(), req.params['id']!, intoId);
      res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/spark-clusters/:id/graduate ────────────────────────────────────

sparkClusterRouter.post('/:id/graduate', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const target = (req.body as { target?: unknown }).target;
      if (target !== 'note' && target !== 'canvas' && target !== 'project' && target !== 'tasks') throw new ValidationError('target must be note, canvas, project or tasks');
      const data = await graduateTheme(getDb(), req.params['id']!, target as GraduationTarget);
      res.status(HTTP_STATUS.CREATED).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/spark-clusters/:id/blog-draft ──────────────────────────────────

sparkClusterRouter.post('/:id/blog-draft', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const length = (req.body as { length?: unknown } | undefined)?.length;
      if (length !== 'short' && length !== 'long') throw new ValidationError('Choose Quick take or Article before starting.');
      const data = await handOff(getDb(), { specialist: 'blog-writer', subjectId: `spark-theme:${req.params['id'] ?? ''}`, input: { length }, requestedBy: 'app' });
      res.status(202).json({ success: true, data });
    } catch (err) { next(err); }
  })();
});

// ── POST /api/spark-clusters/:id/blog-publish ────────────────────────────────

sparkClusterRouter.post('/:id/blog-publish', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const id = req.params['id']!;
      await getTheme(db, id);
      const post = parsePublishBody(req.body);
      await assertVerifiedBlogJob(db, (req.body as { jobId?: unknown } | undefined)?.jobId, `spark-theme:${id.toLowerCase()}`, post);
      const sent = await sendToBlog(post);
      if (sent.payload.success) {
        const url = sent.payload.data.url ?? sent.payload.data.editUrl;
        await updateTheme(db, id, { output: { type: 'blog', ref: url ?? post.title, title: post.title, url }, markSparksUsed: true });
      }
      res.status(sent.httpStatus).json(sent.payload);
    } catch (err) { next(err); }
  })();
});
