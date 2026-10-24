/**
 * GET /api/nav/attention — counts behind the header tab badges.
 *   think:    spark themes not yet seen
 *   discover: articles to review that arrived after `discoverSince` (the client's last Discover visit)
 *   plan:     open tasks past their due date
 *   build:    build tasks waiting on you (approval, blocked, failed)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { HTTP_STATUS } from '../config/constants.js';
import { MIN_THEME_SIZE } from '../jobs/clusteringJob.js';
import { workDay } from '../services/planNudges.js';

export const navAttentionRouter = Router();
const MAX_DISCOVER_SINCE_CHARS = 40;

function sinceParam(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_DISCOVER_SINCE_CHARS) return null;
  const time = Date.parse(input);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const count = (rows: { count: string }[]): number => parseInt(rows[0]?.count ?? '0', 10);

navAttentionRouter.get('/attention', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const since = sinceParam(req.query['discoverSince']);
      const [think, discover, plan, build, jobs] = await Promise.all([
        db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM spark_clusters
            WHERE spark_count >= $1 AND surfaced = false AND status IN ('active', 'developed')`, [MIN_THEME_SIZE]),
        since
          ? db.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM content_items
              WHERE source = 'discovered-article' AND workflow_state = 'to-review' AND indexed_at > $1`, [since])
          : Promise.resolve({ rows: [{ count: '0' }] }),
        db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM tasks
            WHERE archived = false AND status IN ('backlog', 'in-progress') AND due_date < $1::date`, [workDay(req.query['today'])]),
        db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM build_tasks WHERE status IN ('awaiting_approval', 'blocked', 'failed')`),
        db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM managed_job_runs WHERE status IN ('awaiting-approval','failed','partial','unconfirmed')`),
      ]);
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: { think: count(think.rows), discover: count(discover.rows), plan: count(plan.rows), build: count(build.rows), jobs: count(jobs.rows) },
      });
    } catch (err) { next(err); }
  })();
});
