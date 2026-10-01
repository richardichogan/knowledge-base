import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/db.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { getTodaysBriefing, generateMorningBriefing, type Briefing } from '../ai/morningBriefing.js';

export const todayRouter = Router();

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
