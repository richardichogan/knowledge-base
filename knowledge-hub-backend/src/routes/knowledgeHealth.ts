import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/db.js';
import { env } from '../config/env.js';
import { isKnowledgeOrchestrationEnabled } from '../ai/knowledge/budgets.js';
import { getKnowledgeHealth, parseHealthQuery, type KnowledgeHealth } from '../health/knowledgeHealth.js';
import type { ApiSuccess } from '../types/apiResponse.js';
import { getSemanticStatus, type SemanticStatus } from '../services/semantic/status.js';

export const knowledgeHealthRouter = Router();

function queryText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * GET /api/health/knowledge?from=YYYY-MM-DD&to=YYYY-MM-DD&environment=prod&feature=&persona=&deployment=
 * Read-only aggregates: AI usage, sync runs and index freshness. Contains no prompts, content or error text.
 */
knowledgeHealthRouter.get('/knowledge', (req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const filters = parseHealthQuery({
        from: queryText(req.query['from']), to: queryText(req.query['to']), environment: queryText(req.query['environment']),
        feature: queryText(req.query['feature']), persona: queryText(req.query['persona']), deployment: queryText(req.query['deployment']),
      });
      const options = {
        semanticConfigured: Boolean(env.FOUNDRY_IQ_SEARCH_ENDPOINT && env.FOUNDRY_IQ_SEARCH_ADMIN_KEY),
        orchestrationEnabled: isKnowledgeOrchestrationEnabled(),
      };
      const body: ApiSuccess<KnowledgeHealth> = { success: true, data: await getKnowledgeHealth(getDb(), filters, new Date(), options) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  })();
});

/** GET /api/health/semantic — semantic-layer capability counts (decisions awaiting acceptance, edges, monitoring state). */
knowledgeHealthRouter.get('/semantic', (_req: Request, res: Response, next: NextFunction): void => {
  void (async (): Promise<void> => {
    try {
      const body: ApiSuccess<SemanticStatus> = { success: true, data: await getSemanticStatus(getDb(), undefined) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  })();
});
