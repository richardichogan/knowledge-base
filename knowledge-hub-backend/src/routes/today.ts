import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/db.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { getTodaysBriefing, generateMorningBriefing, type Briefing } from '../ai/morningBriefing.js';
import { enqueue, getJob } from '../jobs/store.js';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { getPodcastPrepStatus, generatePodcastPrep, acknowledgePodcastPrep } from '../ai/podcastPrep.js';
import { ValidationError } from '../types/errors.js';
import { HTTP_STATUS } from '../config/constants.js';
import { latestTaskReview } from '../work/taskReview.js';
import { getDiscoverPicks, refreshDiscoverPicks, discoverPicksRunning } from '../services/discoverPicks.js';
import { goalsOverview, startGoalGeneration } from '../goals/overview.js';
import { recordGoalProgress } from '../goals/goals.js';
import { acceptGoalMove, dismissGoalMove } from '../goals/brief.js';
import { applyTidyBatch, decideDateProposal, undoTidyBatch } from '../goals/scorecard.js';
import { proactiveAction, proactiveOverview } from '../goals/proactive.js';

export const todayRouter = Router();

todayRouter.get('/podcast-prep', (_req, res, next) => {
  void getPodcastPrepStatus(getDb()).then((data) => { res.json({ success: true, data }); }).catch(next);
});
todayRouter.post('/podcast-prep', (_req, res, next) => {
  void generatePodcastPrep(getDb(), true, new Date(), true).then((data) => { res.status(HTTP_STATUS.ACCEPTED).json({ success: true, data }); }).catch(next);
});
todayRouter.post('/podcast-prep/acknowledge', (req, res, next) => {
  const body = req.body as { recordingDate?: unknown; generatedAt?: unknown };
  if (typeof body?.recordingDate !== 'string' || typeof body.generatedAt !== 'string') {
    next(new ValidationError('Recording date and brief generation time are required')); return;
  }
  void acknowledgePodcastPrep(getDb(), body.recordingDate, body.generatedAt)
    .then(() => { res.json({ success: true, data: null }); }).catch(next);
});

/** GET /api/today/discover-picks — the saved "Worth posting today" picks, filtered by current article state. */
todayRouter.get('/discover-picks', (_req, res, next) => {
  void getDiscoverPicks(getDb()).then((picks) => { res.json({ success: true, data: { picks, running: discoverPicksRunning() } }); }).catch(next);
});
/** GET /api/today/task-review — the latest scheduled proactive task review, or null before the first run. */
todayRouter.get('/task-review', (_req, res, next) => {
  void latestTaskReview(getDb()).then((review) => { res.json({ success: true, data: review }); }).catch(next);
});
/** POST /api/today/discover-picks/refresh — choose today's picks again now (internal only; nothing is posted). */
todayRouter.post('/discover-picks/refresh', (_req, res, next) => {
  void refreshDiscoverPicks(getDb(), 'manual').then(() => getDiscoverPicks(getDb()))
    .then((picks) => { res.json({ success: true, data: { picks, running: false } }); }).catch(next);
});

/** GET /api/today/goals — goal health, measures, this week's brief and the latest scorecard. */
todayRouter.get('/goals', (_req, res, next) => {
  void goalsOverview(getDb()).then((data) => { res.json({ success: true, data }); }).catch(next);
});
/** POST /api/today/goals/progress — record a proposal, CFP or milestone by hand. */
todayRouter.post('/goals/progress', (req, res, next) => {
  void recordGoalProgress(getDb(), (req.body ?? {}) as Record<string, unknown>, 'richard').then((data) => { res.json({ success: true, data }); }).catch(next);
});
/** POST /api/today/goals/(brief|scorecard)/refresh — start a generation now; poll GET /goals while running. */
todayRouter.post('/goals/:which/refresh', (req, res, next) => {
  const which = req.params['which'];
  if (which !== 'brief' && which !== 'scorecard') { next(new ValidationError('Refresh the brief or the scorecard.')); return; }
  startGoalGeneration(getDb(), which, 'manual');
  void goalsOverview(getDb()).then((data) => { res.status(HTTP_STATUS.ACCEPTED).json({ success: true, data }); }).catch(next);
});
todayRouter.post('/goals/moves/:id/:decision', (req, res, next) => {
  const decision = req.params['decision'];
  if (decision !== 'accept' && decision !== 'dismiss') { next(new ValidationError('Accept or dismiss the move.')); return; }
  const id = req.params['id'];
  void (decision === 'accept' ? acceptGoalMove(getDb(), id, 'richard') : dismissGoalMove(getDb(), id))
    .then((data) => { res.json({ success: true, data }); }).catch(next);
});
todayRouter.post('/goals/dates/:id/:decision', (req, res, next) => {
  const decision = req.params['decision'];
  if (decision !== 'accept' && decision !== 'dismiss') { next(new ValidationError('Accept or dismiss the date.')); return; }
  void decideDateProposal(getDb(), req.params['id'], decision === 'accept', 'richard').then((data) => { res.json({ success: true, data }); }).catch(next);
});
/** POST /api/today/goals/tidy/apply — apply this week's tidy-up batch, minus { excluded: itemId[] }. */
todayRouter.post('/goals/tidy/apply', (req, res, next) => {
  void applyTidyBatch(getDb(), (req.body as { excluded?: unknown } | undefined)?.excluded ?? [], 'richard').then((data) => { res.json({ success: true, data }); }).catch(next);
});
todayRouter.post('/goals/tidy/undo', (req, res, next) => {
  void undoTidyBatch(getDb(), (req.body as { batchId?: unknown } | undefined)?.batchId, 'richard').then((data) => { res.json({ success: true, data }); }).catch(next);
});
/** GET /api/today/proactive — deal desk, meeting prep, promises/chases/cadence, content packages, CFP shortlist and Athena's self-report. */
todayRouter.get('/proactive', (_req, res, next) => {
  void proactiveOverview(getDb()).then((data) => { res.json({ success: true, data }); }).catch(next);
});
/** POST /api/today/proactive/:action — the same actions Athena's manage_proactive tool uses; long runs return 202 and run in the background. */
todayRouter.post('/proactive/:action', (req, res, next) => {
  const db = getDb();
  void proactiveAction(db, req.params['action'], (req.body ?? {}) as Record<string, unknown>, 'richard')
    .then(async (result) => {
      const started = Boolean(result && typeof result === 'object' && 'started' in result);
      res.status(started ? HTTP_STATUS.ACCEPTED : 200).json({ success: true, data: { result, overview: await proactiveOverview(db) } });
    }).catch(next);
});

/** Raw mapped GitHub activity row returned by the Today activity SQL query. */
export interface GitHubActivityRow {
  id: string;
  source: string;
  title: string;
  summary: string | null;
  published_at: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  repo_full_name: string;
  project_tag_id: string;
  project_tag_name: string;
}

/** Today GitHub card payload with mapping-existence flag and filtered items. */
export interface TodayGitHubActivityResponse {
  hasMappings: boolean;
  items: GitHubActivityRow[];
}

/**
 * GET /api/today/github-activity
 * Returns mapped GitHub commits + PRs grouped later by the frontend.
 * Unmapped repos are excluded by the JOIN against repo_project_mappings.
 */
todayRouter.get('/github-activity', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const db = getDb();
      const mappingCountResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM repo_project_mappings`,
      );
      const hasMappings = Number(mappingCountResult.rows[0]?.count ?? '0') > 0;
      if (!hasMappings) {
        const out: ApiSuccess<TodayGitHubActivityResponse> = {
          success: true,
          data: { hasMappings: false, items: [] },
        };
        res.json(out);
        return;
      }

      const result = await db.query<GitHubActivityRow>(
        `SELECT ci.id, ci.source, ci.title, ci.summary, ci.published_at, ci.url, ci.metadata,
                COALESCE(ci.metadata->>'repo', '') AS repo_full_name,
                rpm.project_tag_id, t.name AS project_tag_name
         FROM content_items ci
         JOIN repo_project_mappings rpm
           ON LOWER(rpm.repo_full_name) = LOWER(COALESCE(ci.metadata->>'repo', ''))
         JOIN tags t ON t.id = rpm.project_tag_id
         WHERE ci.source IN ('github-commit', 'github-pr')
         ORDER BY ci.published_at DESC
         LIMIT 80`,
      );

      const out: ApiSuccess<TodayGitHubActivityResponse> = {
        success: true,
        data: { hasMappings: true, items: result.rows },
      };
      res.json(out);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * GET  /api/today/briefing — today's morning briefing (null before 09:00 UK / if not made yet)
 * POST /api/today/briefing — make (or remake) today's briefing now
 */
let briefingInFlight: Promise<Briefing> | null = null;

todayRouter.get('/briefing', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const body: ApiSuccess<Briefing | null> = { success: true, data: await getTodaysBriefing(getDb()) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  })();
});

todayRouter.post('/briefing', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      briefingInFlight ??= generateMorningBriefing(getDb()).finally(() => { briefingInFlight = null; });
      const body: ApiSuccess<Briefing> = { success: true, data: await briefingInFlight };
      res.json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/** Generates (or regenerates) this week's Microsoft digest on demand. */
todayRouter.post('/weekly-microsoft-digest', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      if (env.NODE_ENV !== 'production') throw new ValidationError('Managed jobs execute only on the production backend.');
      const job = await getJob(getDb(), 'a7000000-0000-4000-8000-000000000002');
      const run = await enqueue(getDb(), job, new Date(), `manual:${randomUUID()}`, false, 'manual:weekly-digest');
      res.json({ success: true, data: run });
    } catch (err) {
      next(err);
    }
  })();
});
