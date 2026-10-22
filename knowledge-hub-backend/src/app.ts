import express from 'express';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authenticate } from './middleware/auth.js';
import { timelineRouter } from './routes/timeline.js';
import { searchRouter } from './routes/search.js';
import { sourcesRouter } from './routes/sources.js';
import { muralRouter } from './routes/mural.js';
import { shareEmailRouter } from './routes/shareEmail.js';
import { aiRouter } from './routes/ai.js';
import { chatPanelRouter } from './routes/chatPanel.js';
import { tasksRouter } from './routes/tasks.js';
import { captureRouter } from './routes/capture.js';
import { notesRouter } from './routes/notes.js';
import { imagesRouter } from './routes/images.js';
import { graphAuthRouter } from './routes/graphAuth.js';
import { allianceAuthRouter, allianceApiRouter } from './routes/allianceAuth.js';
import { memoriesRouter } from './routes/memories.js';
import { projectsRouter } from './routes/projects.js';
import { peopleRouter } from './routes/people.js';
import { companiesRouter } from './routes/companies.js';
import { projectCockpitRouter } from './routes/projectCockpit.js';
import { reviewPacketsRouter } from './routes/reviewPackets.js';
import { tagsRouter } from './routes/tags.js';
import { documentsRouter } from './routes/documents.js';
import { discoverRouter } from './routes/discover.js';
import { discoverMonitoringRouter } from './routes/discoverWatchlists.js';
import { taxonomyRouter } from './routes/taxonomy.js';
import { noteTagsRouter } from './routes/noteTags.js';
import { repoMappingsRouter } from './routes/repoMappings.js';
import { cfpRouter } from './routes/cfp.js';
import { tagSuggestionRouter } from './routes/tagSuggestionRoutes.js';
import { sparkRouter, sparkClusterRouter } from './routes/sparkRoutes.js';
import { navAttentionRouter } from './routes/navAttention.js';
import { connectionRouter } from './routes/connectionRoutes.js';
import certScoresRouter from './routes/certScores.js';
import { graphRouter } from './routes/graphRoutes.js';
import { canvasRouter } from './routes/canvasRoutes.js';
import { buildRouter } from './routes/build.js';
import { useCasesRouter } from './routes/useCases.js';
import { DIAGRAM_LIMITS } from './services/diagramValidation.js';
import { HTTP_STATUS } from './config/constants.js';
import { KnowledgeHubError, PayloadTooLargeError } from './types/errors.js';
import { voiceRouter } from './routes/voiceRoutes.js';
import { todayRouter } from './routes/today.js';
import { repoProjectMappingsRouter } from './routes/repoProjectMappings.js';
import { knowledgeHealthRouter } from './routes/knowledgeHealth.js';
import { knowledgeIndexingAdminRouter } from './routes/knowledgeIndexingAdmin.js';
import { semanticDecisionsRouter } from './routes/semanticDecisions.js';
import { env } from './config/env.js';
import type { RuntimePhase } from './runtime.js';
const SERVICE_UNAVAILABLE = 503;

/**
 * Creates and configures the Express application.
 * Middleware order matters — security headers first, then auth, then routes.
 */
export function createApp(readiness: () => RuntimePhase = () => 'starting'): express.Application {
  const app = express();
  // ACA appends the verified sender as the rightmost forwarded IP; earlier
  // entries are client-controlled. Local/direct deployments trust no proxy.
  app.set('trust proxy', env.CONTAINER_APP_NAME?.trim() ? 1 : false);

  // ── Security headers ─────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS — tighten in production ─────────────────────────────────────────
  // CORS_ORIGIN accepts a comma-separated list so the API can serve more than
  // one front-end hostname at a time — the custom domain and the underlying
  // Static Web Apps hostname both need to work, and a single-value setting
  // meant renaming the domain silently broke every API call from the new one.
  const corsOrigin = process.env['CORS_ORIGIN'];
  app.use(cors({
    origin: corsOrigin === undefined || corsOrigin.trim() === ''
      ? '*'
      : corsOrigin.split(',').map((o) => o.trim()).filter((o) => o !== ''),
  }));

  // ── Body parsing ──────────────────────────────────────────────────────────
  // Raw binary for image uploads — MUST come before express.json so binary bodies aren't parsed as JSON
  app.use('/api/images', express.raw({ type: '*/*', limit: '20mb' }));
  app.use('/api/integrations/mural/export', mapBodyErrors(express.raw({ type: 'image/png', limit: '20mb' })));
  app.use('/api/integrations/mural/export-diagram', mapBodyErrors(express.json({ limit: '30mb' })));
  app.use('/api/integrations/share-email/send', mapBodyErrors(express.json({ limit: '9mb' })));
  // Voice audio travels as base64 JSON (see voiceRoutes.ts) — a ~30s WAV clip
  // base64-encodes to several MB, well past the default 1mb JSON limit.
  app.use('/api/voice', express.json({ limit: '20mb' }));
  // Document uploads — multipart/form-data for PDF/DOCX/PPTX/XLSX
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
  app.use('/api/documents/upload', upload.single('file'));
  // Large notes: BlockNote's JSON is several times the size of the text, so a long note (or a big
  // edit applied to one) is well past 1mb. Chat turns carry the open note's text too.
  app.use('/api/notes', express.json({ limit: '25mb' }));
  app.use('/api/ai', express.json({ limit: '8mb' }));
  // Diagram canvases: asset uploads are a raw PNG/SVG body (validated in diagramValidation.ts,
  // 5 MiB cap); a diagram document of up to 1000 nodes / 2000 edges is well past 1mb of JSON.
  app.use(/^\/api\/canvases\/[^/]+\/assets\/?$/, mapBodyErrors(express.raw({ type: () => true, limit: DIAGRAM_LIMITS.maxAssetBytes })));
  app.use(/^\/api\/canvases\/[^/]+\/diagram\/?$/, mapBodyErrors(express.json({ limit: '8mb' })));
  app.use(express.json({ limit: '1mb' }));

  // ── Rate limiting ─────────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: 60 * 1_000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // ── Request logging ───────────────────────────────────────────────────────
  app.use(requestLogger);

  // ── Health check — unauthenticated ────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.get('/ready', (_req: Request, res: Response) => {
    const phase = readiness();
    res.status(phase === 'ready' ? HTTP_STATUS.OK : SERVICE_UNAVAILABLE).json({ status: phase });
  });

  // ── OAuth routes — unauthenticated (must be before /api middleware) ──────
  app.use('/auth/graph', graphAuthRouter);
  app.use('/auth/alliance', allianceAuthRouter);

  // ── API routes — all authenticated ────────────────────────────────────────
  app.use('/api', authenticate);
  app.use('/api', (_req: Request, res: Response, next) => {
    if (readiness() !== 'ready') {
      res.status(SERVICE_UNAVAILABLE).json({ success: false, error: { code: 'NOT_READY', message: 'The service is not ready. Please retry shortly.' } });
      return;
    }
    next();
  });
  app.use('/api/timeline', timelineRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/sources', sourcesRouter);
  app.use('/api/integrations/mural', muralRouter);
  app.use('/api/integrations/share-email', shareEmailRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/ai', chatPanelRouter);
  app.use('/api/voice', voiceRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/nav', navAttentionRouter);
  app.use('/api/capture', captureRouter);
  app.use('/api/notes/:noteId/tags', noteTagsRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/images', imagesRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/people', peopleRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/projects', projectCockpitRouter);
  app.use('/api/projects', reviewPacketsRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/integrations/alliance', allianceApiRouter);
  app.use('/api/memories', memoriesRouter);
  app.use('/api/discover', discoverMonitoringRouter);
  app.use('/api/discover', discoverRouter);
  app.use('/api/taxonomy', taxonomyRouter);
  app.use('/api/repo-mappings', repoMappingsRouter);
  app.use('/api/cfps', cfpRouter);
  app.use('/api/tag-suggestions', tagSuggestionRouter);
  app.use('/api/sparks', sparkRouter);
  app.use('/api/spark-clusters', sparkClusterRouter);
  app.use('/api/connections', connectionRouter);
  app.use('/api/cert-scores', certScoresRouter);
  app.use('/api/graph', graphRouter);
  app.use('/api/canvases', canvasRouter);
  app.use('/api/build', buildRouter);
  app.use('/api/use-cases', useCasesRouter);
  app.use('/api/today', todayRouter);
  app.use('/api/repo-project-mappings', repoProjectMappingsRouter);
  app.use('/api/health', knowledgeHealthRouter);
  app.use('/api/knowledge', knowledgeIndexingAdminRouter);
  app.use('/api/semantic/decisions', semanticDecisionsRouter);

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // ── Global error handler — must be last ───────────────────────────────────
  app.use(errorHandler);

  return app;
}

/** Turns body-parser failures into 413 / 400 API errors instead of a generic 500. */
function mapBodyErrors(parser: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    parser(req, res, (err?: unknown) => {
      if (err === undefined || err === null) { next(); return; }
      const type = (err as { type?: unknown }).type;
      if (type === 'entity.too.large') { next(new PayloadTooLargeError('Request body is too large')); return; }
      if (type === 'entity.parse.failed') { next(new KnowledgeHubError('Request body is not valid JSON', 400, 'INVALID_JSON')); return; }
      next(err);
    });
  };
}
